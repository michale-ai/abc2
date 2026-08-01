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

const WEBSHARE_PROXY_URL =
  process.env.WEBSHARE_PROXY_URL || "";

const UPSTREAM_TIMEOUT_MS =
  Number(process.env.UPSTREAM_TIMEOUT_MS) || 7000;

const MAX_PRICE_ITEMS = 100;
const MAX_PARENT_ASSETS = 5;

let webshareAgent = null;
let proxyConfigurationError = null;

if (WEBSHARE_PROXY_URL) {
  try {
    const parsedProxyUrl = new URL(WEBSHARE_PROXY_URL);

    if (
      parsedProxyUrl.protocol !== "http:" &&
      parsedProxyUrl.protocol !== "https:"
    ) {
      throw new Error(
        `unsupported proxy protocol: ${parsedProxyUrl.protocol}`
      );
    }

    webshareAgent = new HttpsProxyAgent(
      WEBSHARE_PROXY_URL
    );

    console.log(
      `Webshare proxy configured: ${parsedProxyUrl.hostname}:${parsedProxyUrl.port}`
    );
  } catch (error) {
    proxyConfigurationError =
      String(error?.message || error);

    console.error(
      "Invalid WEBSHARE_PROXY_URL:",
      proxyConfigurationError
    );
  }
} else {
  proxyConfigurationError =
    "WEBSHARE_PROXY_URL is not configured";

  console.warn(proxyConfigurationError);
}

app.disable("x-powered-by");
app.use(express.json({ limit: "128kb" }));

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
      "x-proxy-enabled"
    ].join(", ")
  );

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

function asyncRoute(handler) {
  return function wrappedRoute(req, res, next) {
    Promise.resolve(handler(req, res, next))
      .catch(next);
  };
}

function requireProxyKey(req, res, next) {
  if (!PROXY_KEY) {
    return res.status(503).json({
      ok: false,
      code: "proxy_key_not_configured"
    });
  }

  const suppliedKey =
    req.get("x-proxy-key") || "";

  if (suppliedKey !== PROXY_KEY) {
    return res.status(401).json({
      ok: false,
      code: "unauthorized"
    });
  }

  next();
}

function requireWebshareProxy(req, res, next) {
  if (!webshareAgent) {
    return res.status(503).json({
      ok: false,
      code: "webshare_proxy_not_configured",
      details: proxyConfigurationError
    });
  }

  next();
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
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : null;
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

  const dateValue = Date.parse(value);

  if (Number.isFinite(dateValue)) {
    return Math.max(
      0,
      Math.ceil((dateValue - Date.now()) / 1000)
    );
  }

  return null;
}

function safeBodySnippet(text) {
  const cleaned = String(text || "")
    .replace(/[\r\n\t]+/g, " ")
    .trim();

  if (cleaned.length <= 1000) {
    return cleaned;
  }

  return `${cleaned.slice(0, 1000)}...<truncated>`;
}

function captureRateLimit(response, metadata) {
  const limit =
    response.headers.get("x-ratelimit-limit");

  const remaining =
    response.headers.get("x-ratelimit-remaining");

  const reset =
    response.headers.get("x-ratelimit-reset");

  const retryAfter =
    response.headers.get("retry-after");

  const csrfToken =
    response.headers.get("x-csrf-token");

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

  res.setHeader("x-proxy-enabled", "webshare");

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

async function fetchThroughWebshare(
  url,
  options = {}
) {
  if (!webshareAgent) {
    throw new Error(
      proxyConfigurationError ||
      "webshare_proxy_unavailable"
    );
  }

  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, UPSTREAM_TIMEOUT_MS);

  try {
    return await fetch(url, {
      ...options,
      agent: webshareAgent,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function readResponseBody(response) {
  const text = await response.text();

  if (!text) {
    return {
      text: "",
      json: null
    };
  }

  try {
    return {
      text,
      json: JSON.parse(text)
    };
  } catch {
    return {
      text,
      json: null
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

function inferPriceStatus(detail, price) {
  if (
    typeof detail.priceStatus === "string" &&
    detail.priceStatus
  ) {
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

  return price !== null
    ? "On Sale"
    : "Off Sale";
}

function inferForSale(explicit, status, price) {
  if (typeof explicit === "boolean") {
    return explicit;
  }

  const normalized =
    String(status || "").toLowerCase();

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

async function requestCatalogDetails(items) {
  const body = JSON.stringify({
    items: items.map(item => ({
      itemType: item.itemTypeValue,
      id: item.id
    }))
  });

  const attempts = [];
  let csrfToken = null;

  // 같은 Webshare 프록시 agent를 사용하므로
  // CSRF 재요청도 같은 프록시를 통과합니다.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const headers = {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "User-Agent": "RobloxCatalogProxy/2.1"
    };

    if (csrfToken) {
      headers["x-csrf-token"] = csrfToken;
    }

    const startedAt = Date.now();

    const response = await fetchThroughWebshare(
      "https://catalog.roblox.com/v1/catalog/items/details",
      {
        method: "POST",
        headers,
        body
      }
    );

    const diagnostic = captureRateLimit(
      response,
      {
        endpoint: "catalog-items-details",
        attempt,
        elapsedMs: Date.now() - startedAt
      }
    );

    attempts.push(diagnostic);

    const responseBody =
      await readResponseBody(response);

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
      responseBody,
      attempts,
      diagnostic
    };
  }

  throw new Error(
    "catalog_details_attempts_exhausted"
  );
}

app.get(
  "/v1/proxy-test",
  requireProxyKey,
  requireWebshareProxy,
  asyncRoute(async (req, res) => {
    const startedAt = Date.now();

    let response;

    try {
      response = await fetchThroughWebshare(
        "https://api.ipify.org?format=json",
        {
          method: "GET",
          headers: {
            "Accept": "application/json",
            "User-Agent":
              "RobloxCatalogProxy/2.1"
          }
        }
      );
    } catch (error) {
      return res.status(502).json({
        ok: false,
        code: "proxy_connection_failed",
        details: String(
          error?.message || error
        )
      });
    }

    const body = await readResponseBody(response);

    if (!response.ok) {
      return res.status(502).json({
        ok: false,
        code: "proxy_ip_check_failed",
        upstreamStatus: response.status,
        upstreamBody:
          safeBodySnippet(body.text)
      });
    }

    return res.status(200).json({
      ok: true,
      proxyEnabled: true,
      provider: "Webshare",
      exitIp: body.json?.ip || null,
      elapsedMs: Date.now() - startedAt
    });
  })
);

app.post(
  "/v1/catalog-prices",
  requireProxyKey,
  requireWebshareProxy,
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

    const items = [];
    const seen = new Set();

    for (const rawItem of req.body.items) {
      const id = positiveInteger(
        rawItem?.id ?? rawItem?.Id
      );

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

    if (items.length === 0) {
      return res.status(400).json({
        ok: false,
        code: "no_valid_items"
      });
    }

    let upstream;

    try {
      upstream =
        await requestCatalogDetails(items);
    } catch (error) {
      return res.status(502).json({
        ok: false,
        code: "proxy_or_upstream_failed",
        proxyEnabled: true,
        details: String(
          error?.message || error
        )
      });
    }

    applyRateLimitHeaders(
      res,
      upstream.diagnostic
    );

    if (!upstream.response.ok) {
      return res.status(
        upstream.response.status === 429
          ? 429
          : 502
      ).json({
        ok: false,
        code:
          upstream.response.status === 429
            ? "upstream_rate_limited"
            : "upstream_http_error",
        proxyEnabled: true,
        upstreamStatus:
          upstream.response.status,
        retryAfterSeconds:
          upstream.diagnostic.retryAfterSeconds,
        upstreamRateLimit:
          upstream.diagnostic,
        upstreamAttempts:
          upstream.attempts,
        upstreamBody: safeBodySnippet(
          upstream.responseBody.text
        )
      });
    }

    const rawJson =
      upstream.responseBody.json;

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
      prices[item.key] = {
        isForSale: false
      };
    }

    let returnedCount = 0;

    for (const detail of details) {
      const id = positiveInteger(detail?.id);

      if (!id) {
        continue;
      }

      const responseItemType =
        normalizeItemType(detail.itemType);

      const responseKey =
        `${responseItemType.name}:${id}`;

      const requestedItem =
        requestedByKey.get(responseKey) ||
        requestedById.get(id);

      if (!requestedItem) {
        continue;
      }

      const publicBasePrice =
        finiteNumber(detail.price);

      const lowestPrice =
        finiteNumber(detail.lowestPrice);

      const priceStatus =
        inferPriceStatus(
          detail,
          publicBasePrice
        );

      const isForSale =
        inferForSale(
          detail.isForSale,
          priceStatus,
          publicBasePrice
        );

      const entry = {
        isForSale,
        priceStatus
      };

      if (publicBasePrice !== null) {
        entry.publicBasePrice =
          publicBasePrice;
      }

      if (lowestPrice !== null) {
        entry.lowestPrice =
          lowestPrice;
      }

      prices[requestedItem.key] = entry;
      returnedCount += 1;
    }

    return res.status(200).json({
      ok: true,
      proxyEnabled: true,
      provider: "Webshare",
      requestedCount: items.length,
      returnedCount,
      upstreamRequestCount:
        upstream.attempts.length,
      fetchedAt:
        Math.floor(Date.now() / 1000),
      upstreamRateLimit:
        upstream.diagnostic,
      upstreamAttempts:
        upstream.attempts,
      prices
    });
  })
);

async function requestParentBundle(assetId) {
  const startedAt = Date.now();

  let response;

  try {
    response = await fetchThroughWebshare(
      `https://catalog.roblox.com/v1/assets/${assetId}/bundles`,
      {
        method: "GET",
        headers: {
          "Accept": "application/json",
          "User-Agent":
            "RobloxCatalogProxy/2.1"
        }
      }
    );
  } catch (error) {
    return {
      entry: {
        state: "failed",
        code: "proxy_connection_failed",
        retryable: true,
        details: String(
          error?.message || error
        ),
        cacheHit: false
      },
      rateLimit: null
    };
  }

  const diagnostic = captureRateLimit(
    response,
    {
      endpoint: "asset-parent-bundles",
      attempt: 1,
      elapsedMs: Date.now() - startedAt
    }
  );

  const responseBody =
    await readResponseBody(response);

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
        upstreamStatus: response.status,
        retryAfterSeconds:
          diagnostic.retryAfterSeconds,
        upstreamBody:
          safeBodySnippet(responseBody.text),
        upstreamRateLimit: diagnostic,
        cacheHit: false
      },
      rateLimit: diagnostic
    };
  }

  const bundles =
    Array.isArray(responseBody.json?.data)
      ? responseBody.json.data
      : null;

  if (!bundles) {
    return {
      entry: {
        state: "failed",
        code: "invalid_upstream_response",
        retryable: true,
        upstreamBody:
          safeBodySnippet(responseBody.text),
        upstreamRateLimit: diagnostic,
        cacheHit: false
      },
      rateLimit: diagnostic
    };
  }

  const fetchedAt =
    Math.floor(Date.now() / 1000);

  if (bundles.length === 0) {
    return {
      entry: {
        state: "none",
        fetchedAt,
        cacheHit: false,
        upstreamRateLimit: diagnostic
      },
      rateLimit: diagnostic
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
        fetchedAt,
        cacheHit: false,
        upstreamRateLimit: diagnostic
      },
      rateLimit: diagnostic
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

  const entry = {
    state: "found",
    bundleId,
    isForSale,
    priceStatus:
      rawPriceStatus ||
      (isForSale ? "On Sale" : "Off Sale"),
    fetchedAt,
    cacheHit: false,
    upstreamRateLimit: diagnostic
  };

  if (publicBasePrice !== null) {
    entry.publicBasePrice =
      publicBasePrice;
  }

  return {
    entry,
    rateLimit: diagnostic
  };
}

app.post(
  "/v1/parent-bundles",
  requireProxyKey,
  requireWebshareProxy,
  asyncRoute(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");

    if (!Array.isArray(req.body?.assetIds)) {
      return res.status(400).json({
        ok: false,
        code: "assetIds_must_be_an_array"
      });
    }

    if (
      req.body.assetIds.length >
      MAX_PARENT_ASSETS
    ) {
      return res.status(400).json({
        ok: false,
        code: "too_many_asset_ids",
        maxItems: MAX_PARENT_ASSETS
      });
    }

    const assetIds = [];
    const seen = new Set();

    for (const rawId of req.body.assetIds) {
      const assetId =
        positiveInteger(rawId);

      if (!assetId || seen.has(assetId)) {
        continue;
      }

      seen.add(assetId);
      assetIds.push(assetId);
    }

    if (assetIds.length === 0) {
      return res.status(400).json({
        ok: false,
        code: "no_valid_asset_ids"
      });
    }

    const lookups = await Promise.all(
      assetIds.map(assetId =>
        requestParentBundle(assetId)
      )
    );

    const results = {};
    const upstreamRateLimits = {};

    let rateLimited = false;
    let summary = null;

    for (
      let index = 0;
      index < assetIds.length;
      index += 1
    ) {
      const assetId = assetIds[index];
      const lookup = lookups[index];

      results[String(assetId)] =
        lookup.entry;

      if (lookup.rateLimit) {
        upstreamRateLimits[String(assetId)] =
          lookup.rateLimit;

        summary = lookup.rateLimit;

        if (lookup.rateLimit.status === 429) {
          rateLimited = true;
        }
      }
    }

    applyRateLimitHeaders(res, summary);

    return res.status(200).json({
      ok: true,
      proxyEnabled: true,
      provider: "Webshare",
      requestedCount: assetIds.length,
      cacheHitCount: 0,
      upstreamRequestCount:
        assetIds.length,
      fetchedAt:
        Math.floor(Date.now() / 1000),
      rateLimited,
      upstreamRateLimitSummary:
        summary || undefined,
      upstreamRateLimits,
      results
    });
  })
);

app.get("/", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "roblox-catalog-proxy",
    version: "2.1.0",
    webshareProxyConfigured:
      Boolean(webshareAgent),
    proxyConfigurationError:
      webshareAgent
        ? undefined
        : proxyConfigurationError,
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

  console.error(
    "Unhandled request error:",
    error
  );

  return res.status(500).json({
    ok: false,
    code: "internal_server_error",
    details: String(
      error?.message || error
    )
  });
});

app.listen(port, "0.0.0.0", () => {
  console.log(
    `Roblox catalog proxy 2.1.0 listening on port ${port}`
  );
});
