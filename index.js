require("dotenv").config();

const express = require("express");
const fetch = require("node-fetch");
const HttpsProxyAgent = require("https-proxy-agent");

const app = express();
const port = Number(process.env.PORT) || 3000;
const SERVICE_VERSION = "3.1.0";

const PROXY_KEY =
  process.env.CATALOG_PROXY_KEY ||
  process.env.PROXY_KEY ||
  "";

const UPSTREAM_TIMEOUT_MS =
  Number(process.env.UPSTREAM_TIMEOUT_MS) || 7000;

const MAX_PRICE_ITEMS = 100;
const MAX_PARENT_ASSETS = 5;
const TRANSPORT_ERROR_COOLDOWN_MS = 5000;

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  return !["0", "false", "no", "off"].includes(
    String(value).trim().toLowerCase()
  );
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function parseStringList(rawValue) {
  if (!rawValue || !String(rawValue).trim()) {
    return [];
  }

  const raw = String(rawValue).trim();
  try {
    const decoded = JSON.parse(raw);
    if (Array.isArray(decoded)) {
      return decoded
        .map(value => String(value || "").trim())
        .filter(Boolean);
    }
  } catch {
    // Comma/newline parsing below is the compatibility fallback.
  }

  return raw
    .split(/[\r\n,]+/)
    .map(value => value.trim())
    .filter(Boolean);
}

function deduplicate(values) {
  return [...new Set(values)];
}

function normalizeProxyUrl(rawValue) {
  const raw = String(rawValue || "").trim();
  if (/^https?:\/\//i.test(raw)) {
    return raw;
  }

  const parts = raw.split(":");
  if (parts.length >= 4) {
    const host = parts.shift();
    const proxyPort = parts.shift();
    const username = parts.shift();
    const password = parts.join(":");
    return (
      `http://${encodeURIComponent(username)}:` +
      `${encodeURIComponent(password)}@${host}:${proxyPort}`
    );
  }

  if (parts.length === 2) {
    return `http://${raw}`;
  }
  return raw;
}

const ENABLE_RENDER_DIRECT = parseBoolean(
  process.env.ENABLE_RENDER_DIRECT,
  true
);

const ENABLE_CLOUDFLARE = parseBoolean(
  process.env.ENABLE_CLOUDFLARE,
  true
);

const CLOUDFLARE_PROVIDER_URL = String(
  process.env.CLOUDFLARE_PROVIDER_URL ||
    "https://roblox-asset.rhlekarkdtl.workers.dev"
).replace(/\/+$/, "");

const JOB_TIMEOUT_MS = clampInteger(
  process.env.JOB_TIMEOUT_MS,
  4500,
  1000,
  30000
);

const PROVIDER_ATTEMPT_TIMEOUT_MS = clampInteger(
  process.env.PROVIDER_ATTEMPT_TIMEOUT_MS,
  2000,
  250,
  15000
);

// Render's logical lanes shared one observed outbound IP and one rate-limit
// bucket. Keep exactly one Render slot even if the old environment value is 3.
const REQUESTED_RENDER_DIRECT_LANES = clampInteger(
  process.env.RENDER_DIRECT_LANES,
  1,
  1,
  16
);
const RENDER_DIRECT_LANES = 1;

const webshareUrls = deduplicate([
  ...parseStringList(process.env.WEBSHARE_PROXY_LIST),
  ...parseStringList(process.env.WEBSHARE_PROXY_URL)
]);

const remoteProviderUrls = deduplicate(
  parseStringList(process.env.REMOTE_PROVIDER_URLS)
);

function parseRemoteProviderSpecs(rawValue) {
  if (!rawValue || !String(rawValue).trim()) {
    return [];
  }
  try {
    const decoded = JSON.parse(String(rawValue));
    if (!Array.isArray(decoded)) {
      return [];
    }
    return decoded
      .filter(entry => entry && typeof entry === "object")
      .map((entry, index) => ({
        name: String(entry.name || `remote-${index + 1}`)
          .replace(/[^a-zA-Z0-9_-]/g, "-")
          .slice(0, 40),
        url: String(entry.url || "").trim(),
        lanes: clampInteger(entry.lanes, 1, 1, 16)
      }))
      .filter(entry => entry.url);
  } catch (error) {
    console.error(
      "REMOTE_PROVIDER_SPECS must be a JSON array:",
      String(error?.message || error)
    );
    return [];
  }
}

const remoteProviderSpecs = [
  ...remoteProviderUrls.map((url, index) => ({
    name: `remote-${index + 1}`,
    url,
    lanes: 1
  })),
  ...parseRemoteProviderSpecs(process.env.REMOTE_PROVIDER_SPECS)
];

const ownRenderHostname = String(
  process.env.RENDER_EXTERNAL_HOSTNAME || ""
).toLowerCase();

app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "content-type, x-proxy-key"
  );
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, OPTIONS"
  );
  res.setHeader(
    "Access-Control-Expose-Headers",
    [
      "x-upstream-ratelimit-limit",
      "x-upstream-ratelimit-remaining",
      "x-upstream-ratelimit-reset",
      "x-upstream-retry-after",
      "x-upstream-status",
      "x-selected-provider"
    ].join(", ")
  );

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

function asyncRoute(handler) {
  return function wrappedRoute(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function requireProxyKey(req, res, next) {
  if (!PROXY_KEY) {
    return res.status(503).json({
      ok: false,
      code: "proxy_key_not_configured"
    });
  }

  if ((req.get("x-proxy-key") || "") !== PROXY_KEY) {
    return res.status(401).json({
      ok: false,
      code: "unauthorized"
    });
  }
  next();
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : null;
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function splitHeaderValues(value) {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map(part => part.trim())
    .filter(Boolean);
}

function firstNumericValue(values) {
  for (const rawValue of values || []) {
    const parsed = Number(rawValue);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function parseRetryAfter(value) {
  if (!value) {
    return null;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, Math.ceil(seconds));
  }
  const dateValue = Date.parse(value);
  return Number.isFinite(dateValue)
    ? Math.max(0, Math.ceil((dateValue - Date.now()) / 1000))
    : null;
}

function safeBodySnippet(text) {
  const cleaned = String(text || "")
    .replace(/[\r\n\t]+/g, " ")
    .trim();
  return cleaned.length <= 1000
    ? cleaned
    : `${cleaned.slice(0, 1000)}...<truncated>`;
}

function captureRateLimit(response, metadata) {
  const limit = response.headers.get("x-ratelimit-limit");
  const remaining = response.headers.get("x-ratelimit-remaining");
  const reset = response.headers.get("x-ratelimit-reset");
  const retryAfter = response.headers.get("retry-after");

  return {
    endpoint: metadata.endpoint,
    attempt: metadata.attempt,
    elapsedMs: metadata.elapsedMs,
    status: response.status,
    limit: limit || undefined,
    remaining: remaining || undefined,
    reset: reset || undefined,
    retryAfter: retryAfter || undefined,
    limitValues: splitHeaderValues(limit),
    remainingValues: splitHeaderValues(remaining),
    resetValues: splitHeaderValues(reset),
    retryAfterSeconds: parseRetryAfter(retryAfter) ?? undefined,
    csrfTokenReturned: Boolean(
      response.headers.get("x-csrf-token")
    )
  };
}

function captureRemoteRateLimit(response, decoded, endpoint) {
  const embedded =
    decoded?.upstreamRateLimit ||
    decoded?.upstreamRateLimitSummary;
  if (embedded && typeof embedded === "object") {
    return embedded;
  }

  const limit = response.headers.get(
    "x-upstream-ratelimit-limit"
  );
  const remaining = response.headers.get(
    "x-upstream-ratelimit-remaining"
  );
  const reset = response.headers.get(
    "x-upstream-ratelimit-reset"
  );
  const retryAfter = response.headers.get(
    "x-upstream-retry-after"
  );
  const upstreamStatus = Number(
    response.headers.get("x-upstream-status")
  );

  return {
    endpoint,
    attempt: 1,
    status: Number.isFinite(upstreamStatus)
      ? upstreamStatus
      : response.status,
    limit: limit || undefined,
    remaining: remaining || undefined,
    reset: reset || undefined,
    retryAfter: retryAfter || undefined,
    limitValues: splitHeaderValues(limit),
    remainingValues: splitHeaderValues(remaining),
    resetValues: splitHeaderValues(reset),
    retryAfterSeconds: parseRetryAfter(retryAfter) ?? undefined,
    csrfTokenReturned: false
  };
}

function applyRateLimitHeaders(res, info, providerId) {
  if (providerId) {
    res.setHeader("x-selected-provider", providerId);
  }
  if (!info) {
    return;
  }
  if (info.limit) {
    res.setHeader("x-upstream-ratelimit-limit", info.limit);
  }
  if (info.remaining) {
    res.setHeader(
      "x-upstream-ratelimit-remaining",
      info.remaining
    );
  }
  if (info.reset) {
    res.setHeader("x-upstream-ratelimit-reset", info.reset);
  }
  if (info.retryAfter) {
    res.setHeader(
      "x-upstream-retry-after",
      info.retryAfter
    );
  }
  if (info.status !== undefined) {
    res.setHeader("x-upstream-status", String(info.status));
  }
}

function timeoutForDeadline(deadlineAt) {
  const remaining = Number(deadlineAt) - Date.now();
  return Math.max(
    1,
    Math.min(
      UPSTREAM_TIMEOUT_MS,
      PROVIDER_ATTEMPT_TIMEOUT_MS,
      remaining
    )
  );
}

async function fetchWithTimeout(
  url,
  options = {},
  timeoutMs = UPSTREAM_TIMEOUT_MS
) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(1, Number(timeoutMs) || UPSTREAM_TIMEOUT_MS)
  );
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

async function readResponseBody(response) {
  const text = await response.text();
  if (!text) {
    return { text: "", json: null };
  }
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: null };
  }
}

function normalizeItemType(value) {
  if (
    value === 2 ||
    String(value).toLowerCase().includes("bundle")
  ) {
    return { name: "Bundle", value: 2 };
  }
  return { name: "Asset", value: 1 };
}

function normalizePriceItems(rawItems) {
  const items = [];
  const seen = new Set();
  for (const rawItem of rawItems || []) {
    const id = positiveInteger(rawItem?.id ?? rawItem?.Id);
    if (!id) {
      continue;
    }
    const itemType = normalizeItemType(
      rawItem.itemType ?? rawItem.ItemType
    );
    const key = `${itemType.name}:${id}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    items.push({
      id,
      key,
      itemTypeName: itemType.name,
      itemTypeValue: itemType.value
    });
  }
  return items;
}

function inferPriceStatus(detail, price) {
  if (typeof detail.priceStatus === "string" && detail.priceStatus) {
    return detail.priceStatus;
  }
  if (Array.isArray(detail.itemStatus)) {
    const status = detail.itemStatus.find(value =>
      String(value).toLowerCase().includes("sale")
    );
    if (status) {
      return String(status);
    }
  }
  return price !== null ? "On Sale" : "Off Sale";
}

function inferForSale(explicit, status, price) {
  if (typeof explicit === "boolean") {
    return explicit;
  }
  const normalized = String(status || "").toLowerCase();
  if (
    normalized.includes("off sale") ||
    normalized.includes("not for sale")
  ) {
    return false;
  }
  if (normalized.includes("on sale")) {
    return true;
  }
  return price !== null;
}

function buildPriceMap(items, rawJson) {
  const details = Array.isArray(rawJson?.data)
    ? rawJson.data
    : Array.isArray(rawJson)
      ? rawJson
      : [];

  const requestedByKey = new Map(
    items.map(item => [item.key, item])
  );
  const requestedById = new Map(
    items.map(item => [item.id, item])
  );
  const prices = {};
  for (const item of items) {
    prices[item.key] = { isForSale: false };
  }

  let returnedCount = 0;
  for (const detail of details) {
    const id = positiveInteger(detail?.id);
    if (!id) {
      continue;
    }
    const responseType = normalizeItemType(detail.itemType);
    const requested =
      requestedByKey.get(`${responseType.name}:${id}`) ||
      requestedById.get(id);
    if (!requested) {
      continue;
    }

    const publicBasePrice = finiteNumber(detail.price);
    const lowestPrice = finiteNumber(detail.lowestPrice);
    const priceStatus = inferPriceStatus(
      detail,
      publicBasePrice
    );
    const entry = {
      isForSale: inferForSale(
        detail.isForSale,
        priceStatus,
        publicBasePrice
      ),
      priceStatus
    };
    if (publicBasePrice !== null) {
      entry.publicBasePrice = publicBasePrice;
    }
    if (lowestPrice !== null) {
      entry.lowestPrice = lowestPrice;
    }
    prices[requested.key] = entry;
    returnedCount += 1;
  }
  return { prices, returnedCount };
}

const providers = [];

function addProvider(provider) {
  providers.push({
    busy: false,
    cooldownUntil: 0,
    csrfToken: null,
    lastRateLimit: null,
    lastError: null,
    requestCount: 0,
    priority: 99,
    supportsPrice: true,
    supportsParent: true,
    ...provider
  });
}

if (ENABLE_CLOUDFLARE) {
  try {
    const parsed = new URL(CLOUDFLARE_PROVIDER_URL);
    addProvider({
      id: "cloudflare",
      type: "remote",
      baseUrl: parsed.origin,
      priority: 1
    });
  } catch (error) {
    console.error(
      "Skipping invalid Cloudflare provider URL:",
      String(error?.message || error)
    );
  }
}

if (ENABLE_RENDER_DIRECT) {
  for (let lane = 1; lane <= RENDER_DIRECT_LANES; lane += 1) {
    addProvider({
      id: `render-direct-${lane}`,
      type: "local",
      agent: undefined,
      priority: 2
    });
  }
}

for (let index = 0; index < webshareUrls.length; index += 1) {
  const proxyUrl = normalizeProxyUrl(webshareUrls[index]);
  try {
    const parsed = new URL(proxyUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error(`unsupported protocol ${parsed.protocol}`);
    }
    addProvider({
      id: `webshare-${index + 1}`,
      type: "local",
      agent: new HttpsProxyAgent(proxyUrl),
      priority: 3,
      supportsPrice: false,
      supportsParent: true
    });
  } catch (error) {
    console.error(
      `Skipping invalid Webshare proxy #${index + 1}:`,
      String(error?.message || error)
    );
  }
}

for (let index = 0; index < remoteProviderSpecs.length; index += 1) {
  try {
    const spec = remoteProviderSpecs[index];
    const parsed = new URL(spec.url);
    if (
      ownRenderHostname &&
      parsed.hostname.toLowerCase() === ownRenderHostname
    ) {
      console.warn(
        `Skipping remote provider that points to this service: ${parsed.hostname}`
      );
      continue;
    }
    for (let lane = 1; lane <= spec.lanes; lane += 1) {
      addProvider({
        id: `${spec.name}-lane-${lane}`,
        type: "remote",
        baseUrl: parsed.origin,
        priority: 2
      });
    }
  } catch (error) {
    console.error(
      `Skipping invalid remote provider #${index + 1}:`,
      String(error?.message || error)
    );
  }
}

function updateProviderState(provider, result) {
  provider.requestCount += 1;
  provider.lastError = result.ok
    ? null
    : result.errorCode || `http_${result.statusCode}`;

  const rateLimit = result.rateLimit;
  if (!rateLimit) {
    if (!result.ok) {
      provider.cooldownUntil = Math.max(
        provider.cooldownUntil,
        Date.now() + TRANSPORT_ERROR_COOLDOWN_MS
      );
    }
    return;
  }

  provider.lastRateLimit = rateLimit;
  const retryAfter = Number(rateLimit.retryAfterSeconds) || 0;
  const reset = firstNumericValue(rateLimit.resetValues) || 0;
  const remaining = firstNumericValue(
    rateLimit.remainingValues
  );

  if (Number(rateLimit.status) === 429 || remaining === 0) {
    const waitSeconds = Math.max(1, retryAfter, reset);
    provider.cooldownUntil = Math.max(
      provider.cooldownUntil,
      Date.now() + waitSeconds * 1000
    );
  }
}

async function requestLocalPrice(provider, items, deadlineAt) {
  const requestBody = JSON.stringify({
    items: items.map(item => ({
      itemType: item.itemTypeValue,
      id: item.id
    }))
  });

  const attempts = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (Date.now() >= deadlineAt) {
      return {
        ok: false,
        statusCode: 504,
        errorCode: "job_deadline_exceeded",
        rateLimit: attempts[attempts.length - 1] || null,
        body: { ok: false, code: "job_deadline_exceeded" }
      };
    }

    const headers = {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": `RobloxCatalogProviderPool/${SERVICE_VERSION}`
    };
    if (provider.csrfToken) {
      headers["x-csrf-token"] = provider.csrfToken;
    }

    let response;
    const startedAt = Date.now();
    try {
      response = await fetchWithTimeout(
        "https://catalog.roblox.com/v1/catalog/items/details",
        {
          method: "POST",
          headers,
          body: requestBody,
          agent: provider.agent
        },
        timeoutForDeadline(deadlineAt)
      );
    } catch (error) {
      return {
        ok: false,
        statusCode: 502,
        errorCode: "transport_failed",
        rateLimit: null,
        body: {
          ok: false,
          code: "transport_failed",
          details: String(error?.message || error)
        }
      };
    }

    const diagnostic = captureRateLimit(response, {
      endpoint: "catalog-items-details",
      attempt,
      elapsedMs: Date.now() - startedAt
    });
    attempts.push(diagnostic);
    const responseBody = await readResponseBody(response);
    const returnedToken = response.headers.get("x-csrf-token");

    if (response.status === 403 && returnedToken && attempt === 1) {
      // Persist per provider, including when the second request is rate limited.
      provider.csrfToken = returnedToken;
      continue;
    }

    if (!response.ok) {
      return {
        ok: false,
        statusCode: response.status === 429 ? 429 : 502,
        errorCode:
          response.status === 429
            ? "upstream_rate_limited"
            : "upstream_http_error",
        rateLimit: diagnostic,
        body: {
          ok: false,
          code:
            response.status === 429
              ? "upstream_rate_limited"
              : "upstream_http_error",
          upstreamStatus: response.status,
          retryAfterSeconds: diagnostic.retryAfterSeconds,
          upstreamRateLimit: diagnostic,
          upstreamAttempts: attempts,
          upstreamBody: safeBodySnippet(responseBody.text)
        }
      };
    }

    const mapped = buildPriceMap(items, responseBody.json);
    return {
      ok: true,
      statusCode: 200,
      errorCode: null,
      rateLimit: diagnostic,
      body: {
        ok: true,
        requestedCount: items.length,
        returnedCount: mapped.returnedCount,
        upstreamRequestCount: attempts.length,
        fetchedAt: Math.floor(Date.now() / 1000),
        upstreamRateLimit: diagnostic,
        upstreamAttempts: attempts,
        prices: mapped.prices
      }
    };
  }

  return {
    ok: false,
    statusCode: 502,
    errorCode: "csrf_attempts_exhausted",
    rateLimit: attempts[attempts.length - 1] || null,
    body: { ok: false, code: "csrf_attempts_exhausted" }
  };
}

async function requestLocalParent(provider, assetId, deadlineAt) {
  let response;
  const startedAt = Date.now();
  try {
    response = await fetchWithTimeout(
      `https://catalog.roblox.com/v1/assets/${assetId}/bundles`,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          "User-Agent": `RobloxCatalogProviderPool/${SERVICE_VERSION}`
        },
        agent: provider.agent
      },
      timeoutForDeadline(deadlineAt)
    );
  } catch (error) {
    return {
      ok: false,
      statusCode: 502,
      errorCode: "transport_failed",
      rateLimit: null,
      entry: {
        state: "failed",
        code: "transport_failed",
        retryable: true,
        details: String(error?.message || error)
      }
    };
  }

  const diagnostic = captureRateLimit(response, {
    endpoint: "asset-parent-bundles",
    attempt: 1,
    elapsedMs: Date.now() - startedAt
  });
  const responseBody = await readResponseBody(response);

  if (!response.ok) {
    return {
      ok: false,
      statusCode: response.status === 429 ? 429 : 502,
      errorCode:
        response.status === 429
          ? "upstream_rate_limited"
          : "upstream_http_error",
      rateLimit: diagnostic,
      entry: {
        state: "failed",
        code:
          response.status === 429
            ? "upstream_rate_limited"
            : "upstream_http_error",
        retryable: response.status === 429 || response.status >= 500,
        retryAfterSeconds: diagnostic.retryAfterSeconds,
        upstreamStatus: response.status,
        upstreamBody: safeBodySnippet(responseBody.text),
        upstreamRateLimit: diagnostic
      }
    };
  }

  const bundles = Array.isArray(responseBody.json?.data)
    ? responseBody.json.data
    : null;
  const fetchedAt = Math.floor(Date.now() / 1000);
  if (!bundles) {
    return {
      ok: false,
      statusCode: 502,
      errorCode: "invalid_upstream_response",
      rateLimit: diagnostic,
      entry: {
        state: "failed",
        code: "invalid_upstream_response",
        retryable: true,
        upstreamBody: safeBodySnippet(responseBody.text),
        upstreamRateLimit: diagnostic
      }
    };
  }
  if (bundles.length === 0) {
    return {
      ok: true,
      statusCode: 200,
      errorCode: null,
      rateLimit: diagnostic,
      entry: {
        state: "none",
        fetchedAt,
        upstreamRateLimit: diagnostic
      }
    };
  }

  const bundle = bundles[0];
  const bundleId = positiveInteger(bundle.id);
  if (!bundleId) {
    return {
      ok: false,
      statusCode: 502,
      errorCode: "invalid_bundle_id",
      rateLimit: diagnostic,
      entry: {
        state: "failed",
        code: "invalid_bundle_id",
        retryable: true,
        upstreamRateLimit: diagnostic
      }
    };
  }

  const product =
    bundle.product && typeof bundle.product === "object"
      ? bundle.product
      : {};
  const publicBasePrice =
    finiteNumber(product.priceInRobux) ??
    finiteNumber(product.price) ??
    finiteNumber(bundle.priceInRobux) ??
    finiteNumber(bundle.price);
  const explicitForSale =
    typeof product.isForSale === "boolean"
      ? product.isForSale
      : typeof bundle.isForSale === "boolean"
        ? bundle.isForSale
        : undefined;
  const rawStatus = product.priceStatus || bundle.priceStatus || null;
  const isForSale = inferForSale(
    explicitForSale,
    rawStatus,
    publicBasePrice
  );
  const entry = {
    state: "found",
    bundleId,
    isForSale,
    priceStatus: rawStatus || (isForSale ? "On Sale" : "Off Sale"),
    fetchedAt,
    upstreamRateLimit: diagnostic
  };
  if (publicBasePrice !== null) {
    entry.publicBasePrice = publicBasePrice;
  }

  return {
    ok: true,
    statusCode: 200,
    errorCode: null,
    rateLimit: diagnostic,
    entry
  };
}

async function requestRemote(
  provider,
  path,
  payload,
  endpoint,
  deadlineAt
) {
  let response;
  try {
    response = await fetchWithTimeout(
      `${provider.baseUrl}${path}`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "x-proxy-key": PROXY_KEY,
          "User-Agent": `RobloxCatalogProviderPool/${SERVICE_VERSION}`
        },
        body: JSON.stringify(payload)
      },
      timeoutForDeadline(deadlineAt)
    );
  } catch (error) {
    return {
      ok: false,
      statusCode: 502,
      errorCode: "remote_transport_failed",
      rateLimit: null,
      decoded: {
        ok: false,
        code: "remote_transport_failed",
        details: String(error?.message || error)
      }
    };
  }

  const responseBody = await readResponseBody(response);
  const diagnostic = captureRemoteRateLimit(
    response,
    responseBody.json,
    endpoint
  );
  const validJson =
    responseBody.json !== null &&
    typeof responseBody.json === "object";
  return {
    ok: response.ok && validJson && responseBody.json?.ok !== false,
    statusCode: response.status,
    errorCode:
      responseBody.json?.code ||
      (response.ok ? null : `remote_http_${response.status}`),
    rateLimit: diagnostic,
    decoded:
      responseBody.json || {
        ok: false,
        code: "invalid_remote_response",
        upstreamBody: safeBodySnippet(responseBody.text)
      }
  };
}

async function executeJob(provider, job, deadlineAt) {
  if (provider.type === "remote") {
    if (job.kind === "price") {
      const remote = await requestRemote(
        provider,
        "/v1/catalog-prices",
        { items: job.items },
        "remote-catalog-prices",
        deadlineAt
      );
      return {
        ok:
          remote.ok &&
          remote.decoded?.prices &&
          typeof remote.decoded.prices === "object",
        statusCode: remote.statusCode,
        errorCode:
          remote.errorCode ||
          (remote.decoded?.prices ? null : "missing_remote_prices"),
        rateLimit: remote.rateLimit,
        body: remote.decoded
      };
    }

    const remote = await requestRemote(
      provider,
      "/v1/parent-bundles",
      { assetIds: [job.assetId], bypassCache: true },
      "remote-parent-bundles",
      deadlineAt
    );
    const entry =
      remote.decoded?.results?.[String(job.assetId)] || {
        state: "failed",
        code: remote.errorCode || "missing_remote_result",
        retryable: true
      };
    const entryFailed =
      String(entry.state || "").toLowerCase() === "failed";
    return {
      ok: remote.ok && !entryFailed,
      statusCode: remote.statusCode,
      errorCode:
        remote.errorCode ||
        (entryFailed ? entry.code || "remote_entry_failed" : null),
      rateLimit: remote.rateLimit,
      entry
    };
  }

  return job.kind === "price"
    ? requestLocalPrice(provider, job.items, deadlineAt)
    : requestLocalParent(provider, job.assetId, deadlineAt);
}

const requestQueue = [];
let webshareCursor = 0;
let wakeTimer = null;
let wakeAt = 0;

function providerSupportsJob(provider, job) {
  return job.kind === "price"
    ? provider.supportsPrice
    : provider.supportsParent;
}

function providerIsAvailable(provider, queued, now) {
  return (
    providerSupportsJob(provider, queued.job) &&
    !queued.attemptedProviderIds.has(provider.id) &&
    !provider.busy &&
    provider.cooldownUntil <= now
  );
}

function selectAvailableProvider(queued) {
  const now = Date.now();
  const available = providers.filter(provider =>
    providerIsAvailable(provider, queued, now)
  );
  if (available.length === 0) {
    return null;
  }

  const highestPriority = Math.min(
    ...available.map(provider => provider.priority)
  );
  const samePriority = available.filter(
    provider => provider.priority === highestPriority
  );

  if (highestPriority !== 3) {
    return samePriority[0];
  }

  const webshares = providers.filter(
    provider => provider.priority === 3
  );
  for (let offset = 0; offset < webshares.length; offset += 1) {
    const index = (webshareCursor + offset) % webshares.length;
    const provider = webshares[index];
    if (samePriority.includes(provider)) {
      webshareCursor = (index + 1) % webshares.length;
      return provider;
    }
  }

  return samePriority[0];
}

function providerCanBecomeAvailable(provider, queued) {
  if (
    !providerSupportsJob(provider, queued.job) ||
    queued.attemptedProviderIds.has(provider.id)
  ) {
    return false;
  }
  return provider.busy || provider.cooldownUntil < queued.deadlineAt;
}

function attachDebugTrace(queued, result) {
  if (!queued.job.debug) {
    return result;
  }
  return {
    ...result,
    providerAttempts: queued.providerAttempts
  };
}

function makeDeadlineResult(queued) {
  const last = queued.lastResult;
  return attachDebugTrace(queued, {
    providerId: last?.providerId || null,
    ok: false,
    statusCode: 504,
    errorCode: "job_deadline_exceeded",
    rateLimit: last?.rateLimit || null,
    body: {
      ok: false,
      code: "job_deadline_exceeded"
    },
    entry: {
      state: "failed",
      code: "job_deadline_exceeded",
      retryable: true
    }
  });
}

function makeNoProviderResult(queued) {
  if (queued.lastResult) {
    return attachDebugTrace(queued, queued.lastResult);
  }
  return attachDebugTrace(queued, {
    providerId: null,
    ok: false,
    statusCode: 503,
    errorCode: "no_providers_available",
    rateLimit: null,
    body: { ok: false, code: "no_providers_available" },
    entry: {
      state: "failed",
      code: "no_providers_available",
      retryable: true
    }
  });
}

function settleUnserviceableJobs() {
  const now = Date.now();
  for (let index = requestQueue.length - 1; index >= 0; index -= 1) {
    const queued = requestQueue[index];
    if (now >= queued.deadlineAt) {
      requestQueue.splice(index, 1);
      queued.resolve(makeDeadlineResult(queued));
      continue;
    }

    const hasFutureProvider = providers.some(provider =>
      providerCanBecomeAvailable(provider, queued)
    );
    if (!hasFutureProvider) {
      requestQueue.splice(index, 1);
      queued.resolve(makeNoProviderResult(queued));
    }
  }
}

function scheduleWake() {
  if (requestQueue.length === 0) {
    return;
  }

  const now = Date.now();
  const availableTimes = [];
  for (const queued of requestQueue) {
    availableTimes.push(queued.deadlineAt);
    for (const provider of providers) {
      if (
        providerSupportsJob(provider, queued.job) &&
        !queued.attemptedProviderIds.has(provider.id) &&
        !provider.busy &&
        provider.cooldownUntil > now &&
        provider.cooldownUntil < queued.deadlineAt
      ) {
        availableTimes.push(provider.cooldownUntil);
      }
    }
  }

  if (availableTimes.length === 0) {
    return;
  }

  const nextWake = Math.min(...availableTimes);
  if (wakeTimer && wakeAt <= nextWake) {
    return;
  }
  if (wakeTimer) {
    clearTimeout(wakeTimer);
  }
  wakeAt = nextWake;
  const delay = Math.max(1, nextWake - now);
  wakeTimer = setTimeout(() => {
    wakeTimer = null;
    wakeAt = 0;
    pumpQueue();
  }, delay);
}

function providerStateSnapshot() {
  const now = Date.now();
  return providers.map(provider => ({
    id: provider.id,
    priority: provider.priority,
    state: provider.busy
      ? "busy"
      : provider.cooldownUntil > now
        ? "cooldown"
        : "idle"
  }));
}

function runQueuedJob(queued, provider) {
  const selectionState = queued.job.debug
    ? providerStateSnapshot()
    : undefined;
  provider.busy = true;
  const attemptStartedAt = Date.now();

  executeJob(provider, queued.job, queued.deadlineAt)
    .catch(error => ({
      ok: false,
      statusCode: 502,
      errorCode: "unhandled_provider_error",
      rateLimit: null,
      body: {
        ok: false,
        code: "unhandled_provider_error",
        details: String(error?.message || error)
      },
      entry: {
        state: "failed",
        code: "unhandled_provider_error",
        retryable: true
      }
    }))
    .then(result => {
      const completed = {
        providerId: provider.id,
        ...result
      };
      updateProviderState(provider, result);
      provider.busy = false;

      queued.attemptedProviderIds.add(provider.id);
      queued.lastResult = completed;
      if (queued.job.debug) {
        queued.providerAttempts.push({
          attempt: queued.providerAttempts.length + 1,
          providerId: provider.id,
          priority: provider.priority,
          elapsedMs: Date.now() - attemptStartedAt,
          ok: result.ok,
          statusCode: result.statusCode,
          errorCode: result.errorCode || null,
          selectionState
        });
      }

      if (result.ok) {
        queued.resolve(attachDebugTrace(queued, completed));
      } else if (Date.now() >= queued.deadlineAt) {
        queued.resolve(makeDeadlineResult(queued));
      } else {
        // A failed request is retried before new work. Provider selection starts
        // at priority 1 again using the states that exist at this moment.
        requestQueue.unshift(queued);
      }
      pumpQueue();
    });
}

function pumpQueue() {
  settleUnserviceableJobs();

  while (requestQueue.length > 0) {
    let assignment = null;
    for (let index = 0; index < requestQueue.length; index += 1) {
      const queued = requestQueue[index];
      const provider = selectAvailableProvider(queued);
      if (provider) {
        assignment = { index, queued, provider };
        break;
      }
    }

    if (!assignment) {
      scheduleWake();
      return;
    }

    requestQueue.splice(assignment.index, 1);
    runQueuedJob(assignment.queued, assignment.provider);
  }
}

function enqueueJob(job) {
  return new Promise(resolve => {
    const now = Date.now();
    requestQueue.push({
      job,
      resolve,
      deadlineAt: now + JOB_TIMEOUT_MS,
      attemptedProviderIds: new Set(),
      providerAttempts: [],
      lastResult: null
    });
    pumpQueue();
  });
}

app.get(
  "/v1/proxy-test",
  requireProxyKey,
  asyncRoute(async (req, res) => {
    const localProviders = providers.filter(
      provider => provider.type === "local"
    );
    const results = await Promise.all(
      localProviders.map(async provider => {
        const startedAt = Date.now();
        try {
          const response = await fetchWithTimeout(
            "https://api.ipify.org?format=json",
            {
              method: "GET",
              headers: {
                Accept: "application/json",
                "User-Agent": `RobloxCatalogProviderPool/${SERVICE_VERSION}`
              },
              agent: provider.agent
            }
          );
          const body = await readResponseBody(response);
          return {
            providerId: provider.id,
            ok: response.ok,
            exitIp: body.json?.ip || null,
            elapsedMs: Date.now() - startedAt
          };
        } catch (error) {
          return {
            providerId: provider.id,
            ok: false,
            error: String(error?.message || error),
            elapsedMs: Date.now() - startedAt
          };
        }
      })
    );
    res.status(200).json({ ok: true, results });
  })
);

app.post(
  "/v1/catalog-prices",
  requireProxyKey,
  asyncRoute(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (!Array.isArray(req.body?.items)) {
      return res.status(400).json({
        ok: false,
        code: "items_must_be_an_array"
      });
    }
    if (req.body.items.length > MAX_PRICE_ITEMS) {
      return res.status(400).json({
        ok: false,
        code: "too_many_items",
        maxItems: MAX_PRICE_ITEMS
      });
    }

    const items = normalizePriceItems(req.body.items);
    if (items.length === 0) {
      return res.status(400).json({
        ok: false,
        code: "no_valid_items"
      });
    }

    const debug = req.body?.debug === true;
    const result = await enqueueJob({ kind: "price", items, debug });
    applyRateLimitHeaders(res, result.rateLimit, result.providerId);
    const body = {
      ...(result.body || { ok: result.ok }),
      selectedProvider: result.providerId,
      queueDepth: requestQueue.length,
      ...(debug
        ? { providerAttempts: result.providerAttempts || [] }
        : {})
    };
    return res.status(result.statusCode || 502).json(body);
  })
);

app.post(
  "/v1/parent-bundles",
  requireProxyKey,
  asyncRoute(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (!Array.isArray(req.body?.assetIds)) {
      return res.status(400).json({
        ok: false,
        code: "assetIds_must_be_an_array"
      });
    }
    if (req.body.assetIds.length > MAX_PARENT_ASSETS) {
      return res.status(400).json({
        ok: false,
        code: "too_many_asset_ids",
        maxItems: MAX_PARENT_ASSETS
      });
    }

    const assetIds = deduplicate(
      req.body.assetIds
        .map(positiveInteger)
        .filter(Boolean)
    );
    if (assetIds.length === 0) {
      return res.status(400).json({
        ok: false,
        code: "no_valid_asset_ids"
      });
    }

    const debug = req.body?.debug === true;
    const completed = await Promise.all(
      assetIds.map(assetId =>
        enqueueJob({ kind: "parent", assetId, debug })
      )
    );

    const results = {};
    const upstreamRateLimits = {};
    const selectedProviders = {};
    const providerAttempts = {};
    let rateLimited = false;
    let summary = null;

    for (let index = 0; index < assetIds.length; index += 1) {
      const assetId = assetIds[index];
      const completedJob = completed[index];
      results[String(assetId)] = {
        ...(completedJob.entry || {
          state: "failed",
          code: completedJob.errorCode || "missing_result",
          retryable: true
        }),
        selectedProvider: completedJob.providerId
      };
      selectedProviders[String(assetId)] = completedJob.providerId;
      if (debug) {
        providerAttempts[String(assetId)] =
          completedJob.providerAttempts || [];
      }
      if (completedJob.rateLimit) {
        upstreamRateLimits[String(assetId)] = completedJob.rateLimit;
        summary = completedJob.rateLimit;
        if (Number(completedJob.rateLimit.status) === 429) {
          rateLimited = true;
        }
      }
    }

    applyRateLimitHeaders(res, summary, "provider-pool");
    return res.status(200).json({
      ok: true,
      requestedCount: assetIds.length,
      upstreamRequestCount: assetIds.length,
      fetchedAt: Math.floor(Date.now() / 1000),
      queueDepth: requestQueue.length,
      rateLimited,
      selectedProviders,
      ...(debug ? { providerAttempts } : {}),
      upstreamRateLimitSummary: summary || undefined,
      upstreamRateLimits,
      results
    });
  })
);

app.get("/", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "roblox-catalog-provider-pool",
    version: SERVICE_VERSION,
    queueDepth: requestQueue.length,
    providerCount: providers.length,
    configuration: {
      renderDirectEnabled: ENABLE_RENDER_DIRECT,
      renderDirectLanes: ENABLE_RENDER_DIRECT
        ? RENDER_DIRECT_LANES
        : 0,
      requestedRenderDirectLanes: REQUESTED_RENDER_DIRECT_LANES,
      cloudflareEnabled: ENABLE_CLOUDFLARE,
      jobTimeoutMs: JOB_TIMEOUT_MS,
      providerAttemptTimeoutMs: PROVIDER_ATTEMPT_TIMEOUT_MS,
      webshareProviderCount: providers.filter(
        provider => provider.id.startsWith("webshare-")
      ).length,
      remoteProviderCount: providers.filter(
        provider => provider.type === "remote"
      ).length
    },
    providers: providers.map(provider => ({
      id: provider.id,
      type: provider.type,
      priority: provider.priority,
      supportsPrice: provider.supportsPrice,
      supportsParent: provider.supportsParent,
      busy: provider.busy,
      cooldownSeconds: Math.max(
        0,
        Math.ceil((provider.cooldownUntil - Date.now()) / 1000)
      ),
      requestCount: provider.requestCount,
      lastError: provider.lastError,
      lastRateLimit: provider.lastRateLimit
    })),
    endpoints: [
      "GET /v1/proxy-test",
      "POST /v1/catalog-prices",
      "POST /v1/parent-bundles",
      "GET /ping"
    ]
  });
});

app.get("/ping", (req, res) => {
  res.status(200).send("pong");
});

app.use((error, req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }
  console.error("Unhandled request error:", error);
  return res.status(500).json({
    ok: false,
    code: "internal_server_error",
    details: String(error?.message || error)
  });
});

app.listen(port, "0.0.0.0", () => {
  console.log(
    `Roblox catalog provider pool ${SERVICE_VERSION} listening on port ${port}`
  );
  console.log(
    `Providers: direct=${ENABLE_RENDER_DIRECT ? RENDER_DIRECT_LANES : 0}, ` +
      `webshare=${webshareUrls.length}, remote=${providers.filter(provider => provider.type === "remote").length}`
  );
});
