require("dotenv").config();

const express = require("express");
const fetch = require("node-fetch");
const HttpsProxyAgent = require("https-proxy-agent");

const app = express();
const port = Number(process.env.PORT) || 3000;

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

// Use 1 on an ordinary Render service. Use 3 only after assigning a
// three-address Render dedicated outbound IP set. These are scheduler lanes;
// Render itself still decides which of its assigned IPs carries a connection.
const RENDER_DIRECT_LANES = clampInteger(
  process.env.RENDER_DIRECT_LANES,
  1,
  1,
  16
);

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

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    UPSTREAM_TIMEOUT_MS
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
    ...provider
  });
}

if (ENABLE_RENDER_DIRECT) {
  for (let lane = 1; lane <= RENDER_DIRECT_LANES; lane += 1) {
    addProvider({
      id: `render-direct-${lane}`,
      type: "local",
      agent: undefined
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
      agent: new HttpsProxyAgent(proxyUrl)
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
        baseUrl: parsed.origin
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

async function requestLocalPrice(provider, items) {
  const requestBody = JSON.stringify({
    items: items.map(item => ({
      itemType: item.itemTypeValue,
      id: item.id
    }))
  });

  const attempts = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const headers = {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "RobloxCatalogProviderPool/3.0"
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
        }
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

async function requestLocalParent(provider, assetId) {
  let response;
  const startedAt = Date.now();
  try {
    response = await fetchWithTimeout(
      `https://catalog.roblox.com/v1/assets/${assetId}/bundles`,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          "User-Agent": "RobloxCatalogProviderPool/3.0"
        },
        agent: provider.agent
      }
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

async function requestRemote(provider, path, payload, endpoint) {
  let response;
  try {
    response = await fetchWithTimeout(`${provider.baseUrl}${path}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-proxy-key": PROXY_KEY,
        "User-Agent": "RobloxCatalogProviderPool/3.0"
      },
      body: JSON.stringify(payload)
    });
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
  return {
    ok: response.ok && responseBody.json?.ok !== false,
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

async function executeJob(provider, job) {
  if (provider.type === "remote") {
    if (job.kind === "price") {
      const remote = await requestRemote(
        provider,
        "/v1/catalog-prices",
        { items: job.items },
        "remote-catalog-prices"
      );
      return {
        ok: remote.ok,
        statusCode: remote.statusCode,
        errorCode: remote.errorCode,
        rateLimit: remote.rateLimit,
        body: remote.decoded
      };
    }

    const remote = await requestRemote(
      provider,
      "/v1/parent-bundles",
      { assetIds: [job.assetId], bypassCache: true },
      "remote-parent-bundles"
    );
    return {
      ok: remote.ok,
      statusCode: remote.statusCode,
      errorCode: remote.errorCode,
      rateLimit: remote.rateLimit,
      entry:
        remote.decoded?.results?.[String(job.assetId)] || {
          state: "failed",
          code: remote.errorCode || "missing_remote_result",
          retryable: true
        }
    };
  }

  return job.kind === "price"
    ? requestLocalPrice(provider, job.items)
    : requestLocalParent(provider, job.assetId);
}

const requestQueue = [];
let roundRobinCursor = 0;
let wakeTimer = null;

function selectAvailableProvider() {
  if (providers.length === 0) {
    return null;
  }
  const now = Date.now();
  for (let offset = 0; offset < providers.length; offset += 1) {
    const index = (roundRobinCursor + offset) % providers.length;
    const provider = providers[index];
    if (!provider.busy && provider.cooldownUntil <= now) {
      roundRobinCursor = (index + 1) % providers.length;
      return provider;
    }
  }
  return null;
}

function scheduleWakeForCooldown() {
  if (wakeTimer || requestQueue.length === 0) {
    return;
  }
  const now = Date.now();
  const availableTimes = providers
    .filter(provider => !provider.busy)
    .map(provider => provider.cooldownUntil)
    .filter(timestamp => timestamp > now);
  if (availableTimes.length === 0) {
    return;
  }
  const delay = Math.max(1, Math.min(...availableTimes) - now);
  wakeTimer = setTimeout(() => {
    wakeTimer = null;
    pumpQueue();
  }, delay);
}

function pumpQueue() {
  if (providers.length === 0) {
    while (requestQueue.length > 0) {
      requestQueue.shift().resolve({
        providerId: null,
        ok: false,
        statusCode: 503,
        errorCode: "no_providers_configured",
        rateLimit: null,
        body: { ok: false, code: "no_providers_configured" },
        entry: {
          state: "failed",
          code: "no_providers_configured",
          retryable: true
        }
      });
    }
    return;
  }

  while (requestQueue.length > 0) {
    const provider = selectAvailableProvider();
    if (!provider) {
      scheduleWakeForCooldown();
      return;
    }

    const queued = requestQueue.shift();
    provider.busy = true;
    executeJob(provider, queued.job)
      .then(result => {
        updateProviderState(provider, result);
        queued.resolve({ providerId: provider.id, ...result });
      })
      .catch(error => {
        const result = {
          providerId: provider.id,
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
        };
        updateProviderState(provider, result);
        queued.resolve(result);
      })
      .finally(() => {
        provider.busy = false;
        pumpQueue();
      });
  }
}

function enqueueJob(job) {
  return new Promise(resolve => {
    requestQueue.push({ job, resolve });
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
                "User-Agent": "RobloxCatalogProviderPool/3.0"
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

    const result = await enqueueJob({ kind: "price", items });
    applyRateLimitHeaders(res, result.rateLimit, result.providerId);
    const body = {
      ...(result.body || { ok: result.ok }),
      selectedProvider: result.providerId,
      queueDepth: requestQueue.length
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

    const completed = await Promise.all(
      assetIds.map(assetId =>
        enqueueJob({ kind: "parent", assetId })
      )
    );

    const results = {};
    const upstreamRateLimits = {};
    const selectedProviders = {};
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
    version: "3.0.0",
    queueDepth: requestQueue.length,
    providerCount: providers.length,
    configuration: {
      renderDirectEnabled: ENABLE_RENDER_DIRECT,
      renderDirectLanes: ENABLE_RENDER_DIRECT
        ? RENDER_DIRECT_LANES
        : 0,
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
    `Roblox catalog provider pool 3.0.0 listening on port ${port}`
  );
  console.log(
    `Providers: direct=${ENABLE_RENDER_DIRECT ? RENDER_DIRECT_LANES : 0}, ` +
      `webshare=${webshareUrls.length}, remote=${providers.filter(provider => provider.type === "remote").length}`
  );
});
