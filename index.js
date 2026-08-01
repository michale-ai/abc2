require("dotenv").config();

const express = require("express");

const app = express();
const port = Number(process.env.PORT) || 3000;

const PROXY_KEY =
  process.env.CATALOG_PROXY_KEY ||
  process.env.PROXY_KEY ||
  "";

const UPSTREAM_TIMEOUT_MS =
  Number(process.env.UPSTREAM_TIMEOUT_MS) || 5000;

const MAX_PRICE_ITEMS = 100;
const MAX_PARENT_ASSETS = 5;

const PARENT_CACHE_BASE_MS = 60 * 60 * 1000;
const PARENT_CACHE_JITTER = 0.10;
const MAX_PARENT_CACHE_ENTRIES = 10000;

const parentCache = new Map();

app.disable("x-powered-by");
app.use(express.json({ limit: "128kb" }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "content-type, x-proxy-key, x-bypass-worker-cache"
  );
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Expose-Headers",
    [
      "x-upstream-ratelimit-limit",
      "x-upstream-ratelimit-remaining",
      "x-upstream-ratelimit-reset",
      "x-upstream-retry-after",
      "x-upstream-status"
    ].join(", ")
  );

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

function requireProxyKey(req, res, next) {
  if (!PROXY_KEY) {
    return res.status(503).json({
      ok: false,
      code: "proxy_key_not_configured"
    });
  }

  const suppliedKey = req.get("x-proxy-key") || "";

  if (suppliedKey !== PROXY_KEY) {
    return res.status(401).json({
      ok: false,
      code: "unauthorized"
    });
  }

  next();
}

function asyncRoute(handler) {
  return function wrappedRoute(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function positiveInteger(value) {
  const number = Number(value);

  if (
    !Number.isSafeInteger(number) ||
    number <= 0
  ) {
    return null;
  }

  return number;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
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

function parseRetryAfter(value) {
  if (!value) {
    return null;
  }

  const seconds = Number(value);

  if (Number.isFinite(seconds)) {
    return Math.max(0, Math.ceil(seconds));
  }

  const timestamp = Date.parse(value);

  if (Number.isFinite(timestamp)) {
    return Math.max(
      0,
      Math.ceil((timestamp - Date.now()) / 1000)
    );
  }

  return null;
}

function safeBodySnippet(text) {
  if (!text) {
    return "";
  }

  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .trim();

  if (cleaned.length <= 1000) {
    return cleaned;
  }

  return `${cleaned.slice(0, 1000)}...<truncated>`;
}

function captureRateLimit(response, metadata = {}) {
  const limit = response.headers.get("x-ratelimit-limit");
  const remaining = response.headers.get("x-ratelimit-remaining");
  const reset = response.headers.get("x-ratelimit-reset");
  const retryAfter = response.headers.get("retry-after");
  const csrfToken = response.headers.get("x-csrf-token");

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

    retryAfterSeconds:
      parseRetryAfter(retryAfter) ?? undefined,

    csrfTokenReturned: Boolean(csrfToken)
  };
}

function applyRateLimitHeaders(res, info) {
  if (!info) {
    return;
  }

  if (info.limit) {
    res.setHeader(
      "x-upstream-ratelimit-limit",
      info.limit
    );
  }

  if (info.remaining) {
    res.setHeader(
      "x-upstream-ratelimit-remaining",
      info.remaining
    );
  }

  if (info.reset) {
    res.setHeader(
      "x-upstream-ratelimit-reset",
      info.reset
    );
  }

  if (info.retryAfter) {
    res.setHeader(
      "x-upstream-retry-after",
      info.retryAfter
    );
  }

  res.setHeader(
    "x-upstream-status",
    String(info.status)
  );
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, UPSTREAM_TIMEOUT_MS);

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
    return {
      text: "",
      data: null
    };
  }

  try {
    return {
      text,
      data: JSON.parse(text)
    };
  } catch {
    return {
      text,
      data: null
    };
  }
}

function normalizeItemType(value) {
  if (
    value === 2 ||
    String(value).toLowerCase().includes("bundle")
  ) {
    return {
      name: "Bundle",
      value: 2
    };
  }

  return {
    name: "Asset",
    value: 1
  };
}

function normalizePriceItems(rawItems) {
  const normalized = [];
  const seen = new Set();

  for (const rawItem of rawItems) {
    if (!rawItem || typeof rawItem !== "object") {
      continue;
    }

    const id = positiveInteger(rawItem.id ?? rawItem.Id);

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

    normalized.push({
      id,
      key,
      itemTypeName: itemType.name,
      itemTypeValue: itemType.value
    });
  }

  return normalized;
}

function getDetailPriceStatus(detail) {
  if (
    typeof detail.priceStatus === "string" &&
    detail.priceStatus
  ) {
    return detail.priceStatus;
  }

  if (Array.isArray(detail.itemStatus)) {
    const saleStatus = detail.itemStatus.find(status =>
      String(status).toLowerCase().includes("sale")
    );

    if (saleStatus) {
      return String(saleStatus);
    }
  }

  return null;
}

function inferForSale(explicitValue, priceStatus, price) {
  if (typeof explicitValue === "boolean") {
    return explicitValue;
  }

  const status = String(priceStatus || "").toLowerCase();

  if (
    status.includes("off sale") ||
    status.includes("not for sale")
  ) {
    return false;
  }

  if (status.includes("on sale")) {
    return true;
  }

  return price !== null;
}

async function requestCatalogDetails(items) {
  const requestBody = JSON.stringify({
    items: items.map(item => ({
      itemType: item.itemTypeValue,
      id: item.id
    }))
  });

  const attempts = [];
  let csrfToken = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const headers = {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "User-Agent": "RobloxCatalogProxy/2.0"
    };

    if (csrfToken) {
      headers["x-csrf-token"] = csrfToken;
    }

    const startedAt = Date.now();

    const response = await fetchWithTimeout(
      "https://catalog.roblox.com/v1/catalog/items/details",
      {
        method: "POST",
        headers,
        body: requestBody
      }
    );

    const elapsedMs = Date.now() - startedAt;

    const diagnostic = captureRateLimit(response, {
      endpoint: "catalog-items-details",
      attempt,
      elapsedMs
    });

    attempts.push(diagnostic);

    const body = await readResponseBody(response);

    const returnedCsrfToken =
      response.headers.get("x-csrf-token");

    if (
      attempt === 1 &&
      response.status === 403 &&
      returnedCsrfToken
    ) {
      csrfToken = returnedCsrfToken;
      continue;
    }

    return {
      response,
      data: body.data,
      text: body.text,
      attempts,
      diagnostic
    };
  }

  throw new Error("catalog_details_attempts_exhausted");
}

app.post(
  "/v1/catalog-prices",
  requireProxyKey,
  asyncRoute(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");

    const rawItems = req.body?.items;

    if (!Array.isArray(rawItems)) {
      return res.status(400).json({
        ok: false,
        code: "items_must_be_an_array"
      });
    }

    if (rawItems.length > MAX_PRICE_ITEMS) {
      return res.status(400).json({
        ok: false,
        code: "too_many_items",
        maxItems: MAX_PRICE_ITEMS
      });
    }

    const items = normalizePriceItems(rawItems);

    if (items.length === 0) {
      return res.status(400).json({
        ok: false,
        code: "no_valid_items"
      });
    }

    let upstream;

    try {
      upstream = await requestCatalogDetails(items);
    } catch (error) {
      return res.status(502).json({
        ok: false,
        code: "upstream_fetch_failed",
        details: String(error?.message || error)
      });
    }

    applyRateLimitHeaders(res, upstream.diagnostic);

    if (!upstream.response.ok) {
      const status =
        upstream.response.status === 429 ? 429 : 502;

      return res.status(status).json({
        ok: false,
        code:
          upstream.response.status === 429
            ? "upstream_rate_limited"
            : "upstream_http_error",
        upstreamStatus: upstream.response.status,
        retryAfterSeconds:
          upstream.diagnostic.retryAfterSeconds,
        upstreamRateLimit: upstream.diagnostic,
        upstreamAttempts: upstream.attempts,
        upstreamBody: safeBodySnippet(upstream.text)
      });
    }

    const details = Array.isArray(upstream.data?.data)
      ? upstream.data.data
      : Array.isArray(upstream.data)
        ? upstream.data
        : [];

    const requestedByKey = new Map(
      items.map(item => [item.key, item])
    );

    const requestedById = new Map();

    for (const item of items) {
      if (!requestedById.has(item.id)) {
        requestedById.set(item.id, item);
      }
    }

    const prices = {};

    for (const item of items) {
      prices[item.key] = {
        isForSale: false
      };
    }

    let returnedCount = 0;

    for (const detail of details) {
      if (!detail || typeof detail !== "object") {
        continue;
      }

      const id = positiveInteger(detail.id);

      if (!id) {
        continue;
      }

      const detailType = normalizeItemType(detail.itemType);
      const detailKey = `${detailType.name}:${id}`;

      const requestedItem =
        requestedByKey.get(detailKey) ||
        requestedById.get(id);

      if (!requestedItem) {
        continue;
      }

      const publicBasePrice = finiteNumber(detail.price);
      const lowestPrice = finiteNumber(detail.lowestPrice);
      const priceStatus = getDetailPriceStatus(detail);

      const isForSale = inferForSale(
        detail.isForSale,
        priceStatus,
        publicBasePrice
      );

      const entry = {
        isForSale
      };

      if (publicBasePrice !== null) {
        entry.publicBasePrice = publicBasePrice;
      }

      if (lowestPrice !== null) {
        entry.lowestPrice = lowestPrice;
      }

      if (priceStatus) {
        entry.priceStatus = priceStatus;
      }

      prices[requestedItem.key] = entry;
      returnedCount += 1;
    }

    return res.status(200).json({
      ok: true,
      requestedCount: items.length,
      returnedCount,
      upstreamRequestCount: upstream.attempts.length,
      fetchedAt: Math.floor(Date.now() / 1000),
      upstreamRateLimit: upstream.diagnostic,
      upstreamAttempts: upstream.attempts,
      prices
    });
  })
);

function parentCacheTtlMs() {
  const jitter =
    1 +
    ((Math.random() * 2 - 1) * PARENT_CACHE_JITTER);

  return Math.round(PARENT_CACHE_BASE_MS * jitter);
}

function getCachedParent(assetId) {
  const cached = parentCache.get(assetId);

  if (!cached) {
    return null;
  }

  if (cached.expiresAt <= Date.now()) {
    parentCache.delete(assetId);
    return null;
  }

  return {
    ...cached.value,
    cacheHit: true
  };
}

function setCachedParent(assetId, value) {
  if (
    parentCache.size >= MAX_PARENT_CACHE_ENTRIES &&
    !parentCache.has(assetId)
  ) {
    const oldestKey = parentCache.keys().next().value;

    if (oldestKey !== undefined) {
      parentCache.delete(oldestKey);
    }
  }

  parentCache.set(assetId, {
    expiresAt: Date.now() + parentCacheTtlMs(),
    value: {
      ...value,
      cacheHit: false
    }
  });
}

function normalizeParentIds(rawIds) {
  const normalized = [];
  const seen = new Set();

  for (const rawId of rawIds) {
    const id = positiveInteger(rawId);

    if (!id || seen.has(id)) {
      continue;
    }

    seen.add(id);
    normalized.push(id);
  }

  return normalized;
}

async function requestParentBundle(assetId, bypassCache) {
  if (!bypassCache) {
    const cached = getCachedParent(assetId);

    if (cached) {
      return {
        entry: cached,
        upstreamRequestCount: 0,
        rateLimit: null
      };
    }
  }

  const fetchedAt = Math.floor(Date.now() / 1000);
  const startedAt = Date.now();

  let response;

  try {
    response = await fetchWithTimeout(
      `https://catalog.roblox.com/v1/assets/${assetId}/bundles`,
      {
        method: "GET",
        headers: {
          "Accept": "application/json",
          "User-Agent": "RobloxCatalogProxy/2.0"
        }
      }
    );
  } catch (error) {
    return {
      entry: {
        state: "failed",
        code: "upstream_fetch_failed",
        retryable: true,
        details: String(error?.message || error),
        fetchedAt,
        cacheHit: false
      },
      upstreamRequestCount: 1,
      rateLimit: null
    };
  }

  const elapsedMs = Date.now() - startedAt;

  const rateLimit = captureRateLimit(response, {
    endpoint: "asset-parent-bundles",
    attempt: 1,
    elapsedMs
  });

  const body = await readResponseBody(response);

  if (!response.ok) {
    return {
      entry: {
        state: "failed",
        code:
          response.status === 429
            ? "upstream_rate_limited"
            : "upstream_http_error",
        retryable:
          response.status === 429 ||
          response.status >= 500,
        retryAfterSeconds:
          rateLimit.retryAfterSeconds,
        upstreamStatus: response.status,
        upstreamBody: safeBodySnippet(body.text),
        upstreamRateLimit: rateLimit,
        fetchedAt,
        cacheHit: false
      },
      upstreamRequestCount: 1,
      rateLimit
    };
  }

  const bundles = Array.isArray(body.data?.data)
    ? body.data.data
    : Array.isArray(body.data)
      ? body.data
      : null;

  if (!bundles) {
    return {
      entry: {
        state: "failed",
        code: "invalid_upstream_response",
        retryable: true,
        upstreamRateLimit: rateLimit,
        upstreamBody: safeBodySnippet(body.text),
        fetchedAt,
        cacheHit: false
      },
      upstreamRequestCount: 1,
      rateLimit
    };
  }

  if (bundles.length === 0) {
    const entry = {
      state: "none",
      fetchedAt,
      cacheHit: false
    };

    setCachedParent(assetId, entry);

    return {
      entry: {
        ...entry,
        upstreamRateLimit: rateLimit
      },
      upstreamRequestCount: 1,
      rateLimit
    };
  }

  const bundle = bundles[0];
  const bundleId = positiveInteger(bundle.id);

  if (!bundleId) {
    return {
      entry: {
        state: "failed",
        code: "invalid_bundle_id",
        retryable: true,
        upstreamRateLimit: rateLimit,
        fetchedAt,
        cacheHit: false
      },
      upstreamRequestCount: 1,
      rateLimit
    };
  }

  const product =
    bundle.product &&
    typeof bundle.product === "object"
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

  const rawPriceStatus =
    product.priceStatus ||
    bundle.priceStatus ||
    null;

  const isForSale = inferForSale(
    explicitForSale,
    rawPriceStatus,
    publicBasePrice
  );

  const priceStatus =
    rawPriceStatus ||
    (isForSale ? "On Sale" : "Off Sale");

  const entry = {
    state: "found",
    bundleId,
    isForSale,
    priceStatus,
    fetchedAt,
    cacheHit: false
  };

  if (publicBasePrice !== null) {
    entry.publicBasePrice = publicBasePrice;
  }

  setCachedParent(assetId, entry);

  return {
    entry: {
      ...entry,
      upstreamRateLimit: rateLimit
    },
    upstreamRequestCount: 1,
    rateLimit
  };
}

function primaryRemaining(info) {
  if (!info || !Array.isArray(info.remainingValues)) {
    return Number.POSITIVE_INFINITY;
  }

  for (const rawValue of info.remainingValues) {
    const number = Number(rawValue);

    if (Number.isFinite(number)) {
      return number;
    }
  }

  return Number.POSITIVE_INFINITY;
}

function selectRateLimitSummary(infos) {
  const available = infos.filter(Boolean);

  if (available.length === 0) {
    return null;
  }

  available.sort((left, right) => {
    const leftLimited = left.status === 429 ? 0 : 1;
    const rightLimited = right.status === 429 ? 0 : 1;

    if (leftLimited !== rightLimited) {
      return leftLimited - rightLimited;
    }

    return (
      primaryRemaining(left) -
      primaryRemaining(right)
    );
  });

  return available[0];
}

app.post(
  "/v1/parent-bundles",
  requireProxyKey,
  asyncRoute(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");

    const rawAssetIds = req.body?.assetIds;

    if (!Array.isArray(rawAssetIds)) {
      return res.status(400).json({
        ok: false,
        code: "assetIds_must_be_an_array"
      });
    }

    if (rawAssetIds.length > MAX_PARENT_ASSETS) {
      return res.status(400).json({
        ok: false,
        code: "too_many_asset_ids",
        maxItems: MAX_PARENT_ASSETS
      });
    }

    const assetIds = normalizeParentIds(rawAssetIds);

    if (assetIds.length === 0) {
      return res.status(400).json({
        ok: false,
        code: "no_valid_asset_ids"
      });
    }

    const bypassCache =
      req.body?.bypassCache === true ||
      req.get("x-bypass-worker-cache") === "true";

    // 최대 5개의 Roblox GET을 동시에 실행합니다.
    const lookups = await Promise.all(
      assetIds.map(assetId =>
        requestParentBundle(assetId, bypassCache)
      )
    );

    const results = {};
    const upstreamRateLimits = {};

    let cacheHitCount = 0;
    let upstreamRequestCount = 0;
    let rateLimited = false;

    for (let index = 0; index < assetIds.length; index += 1) {
      const assetId = assetIds[index];
      const lookup = lookups[index];

      results[String(assetId)] = lookup.entry;

      if (lookup.entry.cacheHit) {
        cacheHitCount += 1;
      }

      upstreamRequestCount +=
        lookup.upstreamRequestCount;

      if (lookup.rateLimit) {
        upstreamRateLimits[String(assetId)] =
          lookup.rateLimit;

        if (lookup.rateLimit.status === 429) {
          rateLimited = true;
        }
      }
    }

    const summary = selectRateLimitSummary(
      lookups.map(lookup => lookup.rateLimit)
    );

    applyRateLimitHeaders(res, summary);

    return res.status(200).json({
      ok: true,
      requestedCount: assetIds.length,
      cacheHitCount,
      upstreamRequestCount,
      fetchedAt: Math.floor(Date.now() / 1000),
      rateLimited,
      upstreamRateLimitSummary: summary || undefined,
      upstreamRateLimits,
      results
    });
  })
);

app.get("/", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "roblox-catalog-proxy",
    version: "2.0.0",
    endpoints: [
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

  if (error?.type === "entity.too.large") {
    return res.status(413).json({
      ok: false,
      code: "request_body_too_large"
    });
  }

  return res.status(500).json({
    ok: false,
    code: "internal_server_error",
    details: String(error?.message || error)
  });
});

app.listen(port, "0.0.0.0", () => {
  console.log(
    `Roblox catalog proxy listening on port ${port}`
  );

  if (!PROXY_KEY) {
    console.warn(
      "CATALOG_PROXY_KEY/PROXY_KEY is not configured."
    );
  }
});
