import express from "express";
import cors from "cors";
import axios from "axios";
import https from "https";

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());

const PRICE_URL_USD =
  "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=zcash&price_change_percentage=24h";
const PRICE_URL_BTC =
  "https://api.coingecko.com/api/v3/coins/markets?vs_currency=btc&ids=zcash&price_change_percentage=24h";
const TREASURY_URL =
  "https://api.coingecko.com/api/v3/companies/public_treasury/zcash";
const INFO_URL =
  "https://mainnet.zcashexplorer.app/api/v1/blockchain-info";
const MEMPOOL_URL = "https://zcashmetro.io:3000/mempool";
const PRICE_CACHE_TTL_MS = Number(process.env.PRICE_CACHE_TTL_MS ?? 60_000);
const TREASURY_CACHE_TTL_MS = Number(
  process.env.TREASURY_CACHE_TTL_MS ?? 15 * 60_000
);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS ?? 30_000);
const REQUEST_RETRIES = Number(process.env.REQUEST_RETRIES ?? 2);
const REQUEST_RETRY_DELAY_MS = Number(
  process.env.REQUEST_RETRY_DELAY_MS ?? 1_000
);

const LOCKBOX_MULTISIG_ADDRESS = "t3ev37Q2uL1sfTsiJQJiWJoFzQpDhmnUwYo";
const LOCKBOX_MULTISIG_TOKEN =
  process.env.THREEXPL_TOKEN ||
  "3A0_t3st3xplor3rpub11cb3t4efcd21748a5e";
const LOCKBOX_MULTISIG_URL = `https://api.3xpl.com/zcash/address/${LOCKBOX_MULTISIG_ADDRESS}?data=balances`;

const MEMPOOL_AGENT = new https.Agent({ rejectUnauthorized: false });
const RETRYABLE_ERROR_CODES = new Set([
  "ECONNABORTED",
  "ETIMEDOUT",
  "ECONNRESET",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
]);

async function getJSON(url, config = {}) {
  const {
    headers,
    timeout,
    httpsAgent,
    retries = REQUEST_RETRIES,
    retryDelayMs = REQUEST_RETRY_DELAY_MS,
  } = config;

  const axiosConfig = {
    headers: {
      accept: "application/json",
      "user-agent": "zcash-totem/1.0",
      ...headers,
    },
    timeout: timeout ?? REQUEST_TIMEOUT_MS,
    httpsAgent,
  };

  let attempt = 0;
  while (attempt <= retries) {
    try {
      const res = await axios.get(url, axiosConfig);
      return normalizeJSON(res.data);
    } catch (err) {
      attempt += 1;
      const status = err.response?.status ?? err.code ?? "request_failed";
      const retryable = isRetryableError(err);
      if (!retryable || attempt > retries) {
        throw new Error(`${url} -> HTTP ${status}`);
      }
      const delayMs = retryDelayMs * attempt;
      console.warn(`request retry ${attempt}/${retries} for ${url} (${status})`);
      await delay(delayMs);
    }
  }
}

const priceCache = {
  data: null,
  fetchedAt: 0,
  promise: null,
};

const treasuryCache = {
  data: null,
  fetchedAt: 0,
  promise: null,
};

const staticGrayscale = {
  sharesOutstanding: 4_829_300,
  zecPerShare: 0.08167081,
};

function getCachedPriceData() {
  const now = Date.now();
  if (priceCache.data && now - priceCache.fetchedAt <= PRICE_CACHE_TTL_MS) {
    return Promise.resolve(priceCache.data);
  }

  if (priceCache.promise) {
    return priceCache.promise;
  }

  const fetchPromise = Promise.all([
    getJSON(PRICE_URL_USD),
    getJSON(PRICE_URL_BTC),
  ])
    .then(([usdData, btcData]) => {
      const normalized = {
        usd: usdData,
        btc: btcData,
      };
      priceCache.data = normalized;
      priceCache.fetchedAt = Date.now();
      return normalized;
    })
    .catch((err) => {
      if (priceCache.data) {
        console.warn("price fetch error (serving cached):", err);
        return priceCache.data;
      }
      throw err;
    })
    .finally(() => {
      priceCache.promise = null;
    });

  priceCache.promise = fetchPromise;
  return fetchPromise;
}

function getCachedTreasuryData() {
  const now = Date.now();
  if (treasuryCache.data && now - treasuryCache.fetchedAt <= TREASURY_CACHE_TTL_MS) {
    return Promise.resolve(treasuryCache.data);
  }

  if (treasuryCache.promise) {
    return treasuryCache.promise;
  }

  const fetchPromise = getJSON(TREASURY_URL)
    .then((fresh) => {
      const combined = {
        ...fresh,
        grayscale: staticGrayscale,
      };
      treasuryCache.data = combined;
      treasuryCache.fetchedAt = Date.now();
      return combined;
    })
    .catch((err) => {
      if (treasuryCache.data) {
        console.warn("treasury fetch error (serving cached):", err);
        return treasuryCache.data;
      }
      throw err;
    })
    .finally(() => {
      treasuryCache.promise = null;
    });

  treasuryCache.promise = fetchPromise;
  return fetchPromise;
}

function extractValuePools(info, circulatingSupply) {
  const vp = Array.isArray(info?.valuePools) ? info.valuePools : [];
  const find = (id) =>
    Number(vp.find((p) => p.id === id)?.chainValue ?? 0);

  let transparent = find("transparent");
  const sprout = find("sprout");
  const sapling = find("sapling");
  const orchard = find("orchard");
  const lockbox = find("lockbox");

  const shielded = sprout + sapling + orchard;
  const totalFromInfo = transparent + shielded + lockbox;
  const totalChain = Number.isFinite(circulatingSupply) && circulatingSupply > 0
    ? circulatingSupply
    : totalFromInfo;

  if ((!transparent || transparent <= 0) && Number.isFinite(totalChain)) {
    const inferred = totalChain - shielded - lockbox;
    if (Number.isFinite(inferred) && inferred > 0) {
      transparent = inferred;
    }
  }

  transparent = sanitizeNumber(transparent) ?? 0;

  return {
    transparent,
    sprout,
    sapling,
    orchard,
    lockbox,
    shielded,
    totalChain,
  };
}

function isRetryableError(err) {
  const statusCode = err.response?.status ?? null;
  if (typeof statusCode === "number") {
    return statusCode === 429 || statusCode >= 500;
  }
  const code = err.code ?? "";
  return RETRYABLE_ERROR_CODES.has(code);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pickPriceEntry(raw) {
  if (Array.isArray(raw)) return raw[0] ?? null;
  if (raw && typeof raw === "object" && raw.zcash) return raw.zcash;
  return raw ?? null;
}

function parseGrayscaleHtml() {
  return staticGrayscale;
}

app.get("/api/status", async (req, res) => {
  try {
    const pricePromise = getCachedPriceData();
    const [priceData, infoData, mempoolData, lockboxMultisigData] = await Promise.all([
      pricePromise,
      getJSON(INFO_URL),
      getJSON(MEMPOOL_URL, { httpsAgent: MEMPOOL_AGENT }).catch(() => null),
      getJSON(LOCKBOX_MULTISIG_URL, {
        headers: { Authorization: `Bearer ${LOCKBOX_MULTISIG_TOKEN}` },
      }).catch(() => null),
    ]);

    const priceEntryUsd = pickPriceEntry(priceData?.usd ?? priceData);
    const priceEntryBtc = pickPriceEntry(priceData?.btc ?? null);

    const priceUsd = sanitizeNumber(
      priceEntryUsd?.current_price ?? priceEntryUsd?.usd
    );
    const priceBtc = sanitizeNumber(
      priceEntryBtc?.current_price ?? priceEntryBtc?.btc
    );
    const priceChange24h = sanitizeNumber(
      priceEntryUsd?.price_change_percentage_24h ?? priceEntryUsd?.usd_24h_change
    );
    const priceChange24hBtc = sanitizeNumber(
      priceEntryBtc?.price_change_percentage_24h ?? priceEntryBtc?.btc_24h_change
    );
    const priceLow24hUsd = sanitizeNumber(
      priceEntryUsd?.low_24h ?? priceEntryUsd?.usd_24h_low
    );
    const priceHigh24hUsd = sanitizeNumber(
      priceEntryUsd?.high_24h ?? priceEntryUsd?.usd_24h_high
    );
    const priceLow24hBtc = sanitizeNumber(priceEntryBtc?.low_24h ?? null);
    const priceHigh24hBtc = sanitizeNumber(priceEntryBtc?.high_24h ?? null);
    const marketCapUsd = sanitizeNumber(
      priceEntryUsd?.market_cap ?? priceEntryUsd?.usd_market_cap
    );
    const marketCapChange24h = sanitizeNumber(
      priceEntryUsd?.market_cap_change_percentage_24h ?? null
    );
    const marketCapChangeUsd = sanitizeNumber(
      priceEntryUsd?.market_cap_change_24h ?? null
    );
    const circulatingSupply = sanitizeNumber(
      priceEntryUsd?.circulating_supply ?? null
    );

    const height =
      infoData?.blocks ??
      infoData?.blockchain?.blocks ??
      infoData?.estimatedheight ??
      null;

    const pools = extractValuePools(infoData, circulatingSupply);
    const lockboxMultisigZats = sanitizeNumber(
      lockboxMultisigData?.data?.balances?.["zcash-main"]?.zcash?.balance ??
      lockboxMultisigData?.balance ??
      null
    );
    const lockboxMultisig = Number.isFinite(lockboxMultisigZats)
      ? lockboxMultisigZats / 1e8
      : null;
    const lockboxCombined = [pools.lockbox, lockboxMultisig]
      .filter((v) => Number.isFinite(v))
      .reduce((sum, v) => sum + v, 0);
    const valuePools = {
      ...pools,
      lockbox: Number.isFinite(lockboxCombined) ? lockboxCombined : pools.lockbox,
      lockboxMultisig,
    };
    
    let mempoolSize = null;
    if (Array.isArray(mempoolData)) {
      mempoolSize = sanitizeNumber(mempoolData.length);
    } else if (mempoolData && typeof mempoolData === "object") {
      const candidate = mempoolData.size ?? mempoolData.length ?? null;
      mempoolSize = sanitizeNumber(candidate);
    }

    res.json({
      timestamp: Date.now(),
      priceUsd,
      priceLow24hUsd,
      priceHigh24hUsd,
      priceChange24h,
      priceBtc,
      priceLow24hBtc,
      priceHigh24hBtc,
      priceChange24hBtc,
      marketCapUsd,
      marketCapChange24h,
      marketCapChangeUsd,
      circulatingSupply,
      height,
      mempoolSize,
      valuePools,
    });
  } catch (err) {
    console.error("status error:", err);
    res.status(500).json({ error: "upstream_failed" });
  }
});

app.get("/api/treasury", async (req, res) => {
  try {
    const data = await getCachedTreasuryData();
    const totalHoldings = sanitizeNumber(data?.total_holdings);
    const totalValueUsd = sanitizeNumber(data?.total_value_usd);
    const marketCapDominance = sanitizeNumber(data?.market_cap_dominance);
    const grayscale = data?.grayscale ?? null;
    const grayscaleShares = sanitizeNumber(grayscale?.sharesOutstanding);
    const grayscaleZecPerShare = sanitizeNumber(grayscale?.zecPerShare);
    const grayscaleHoldings = sanitizeNumber(
      grayscale?.holdings ??
      (Number.isFinite(grayscaleShares) && Number.isFinite(grayscaleZecPerShare)
        ? grayscaleShares * grayscaleZecPerShare
        : null)
    );

    res.json({
      totalHoldings,
      totalValueUsd,
      marketCapDominance,
      companies: Array.isArray(data?.companies) ? data.companies : [],
      grayscale: {
        holdings: grayscaleHoldings,
        sharesOutstanding: grayscaleShares,
        zecPerShare: grayscaleZecPerShare,
      },
      timestamp: Date.now(),
    });
  } catch (err) {
    console.error("treasury error:", err);
    res.status(500).json({ error: "upstream_failed" });
  }
});

app.listen(PORT, () => {
  console.log(`API server listening on http://localhost:${PORT}`);
});

function normalizeJSON(value) {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

function sanitizeNumber(value) {
  if (value === null || value === undefined) return null;
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : null;
}
