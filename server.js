import express from "express";
import cors from "cors";
import axios from "axios";
import https from "https";
import config from "./config.json" with { type: "json" };

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());

/* ─── upstream URLs ─── */
const PRICE_URL_USD =
  "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=zcash&price_change_percentage=24h";
const PRICE_URL_BTC =
  "https://api.coingecko.com/api/v3/coins/markets?vs_currency=btc&ids=zcash&price_change_percentage=24h";
const TREASURY_URL =
  "https://api.coingecko.com/api/v3/companies/public_treasury/zcash";
const INFO_URL =
  "https://mainnet.zcashexplorer.app/api/v1/blockchain-info";
const MEMPOOL_URL = "https://zcashmetro.io:3000/mempool";

const LOCKBOX_MULTISIG_ADDRESS = "t3ev37Q2uL1sfTsiJQJiWJoFzQpDhmnUwYo";
const LOCKBOX_MULTISIG_TOKEN =
  process.env.THREEXPL_TOKEN ||
  "3A0_t3st3xplor3rpub11cb3t4efcd21748a5e";
const LOCKBOX_MULTISIG_URL = `https://api.3xpl.com/zcash/address/${LOCKBOX_MULTISIG_ADDRESS}?data=balances`;

/* ─── tunables ─── */
const REQUEST_TIMEOUT_MS    = Number(process.env.REQUEST_TIMEOUT_MS    ?? 10_000);
const REQUEST_RETRIES       = Number(process.env.REQUEST_RETRIES       ?? 1);
const REQUEST_RETRY_DELAY_MS = Number(process.env.REQUEST_RETRY_DELAY_MS ?? 1_000);

const PRICE_CACHE_TTL_MS    = Number(process.env.PRICE_CACHE_TTL_MS    ?? 60_000);
const TREASURY_CACHE_TTL_MS = Number(process.env.TREASURY_CACHE_TTL_MS ?? 15 * 60_000);
const INFO_CACHE_TTL_MS     = Number(process.env.INFO_CACHE_TTL_MS     ?? 30_000);
const MEMPOOL_CACHE_TTL_MS  = Number(process.env.MEMPOOL_CACHE_TTL_MS  ?? 8_000);
const LOCKBOX_CACHE_TTL_MS  = Number(process.env.LOCKBOX_CACHE_TTL_MS  ?? 5 * 60_000);

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

/* ─── helpers ─── */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeJSON(value) {
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return value; }
  }
  return value;
}

function sanitizeNumber(value) {
  if (value === null || value === undefined) return null;
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : null;
}

function isRetryableError(err) {
  const statusCode = err.response?.status ?? null;
  if (typeof statusCode === "number") {
    return statusCode === 429 || statusCode >= 500;
  }
  return RETRYABLE_ERROR_CODES.has(err.code ?? "");
}

function pickPriceEntry(raw) {
  if (Array.isArray(raw)) return raw[0] ?? null;
  if (raw && typeof raw === "object" && raw.zcash) return raw.zcash;
  return raw ?? null;
}

/* ─── HTTP fetcher with retry ─── */
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
      if (!isRetryableError(err) || attempt > retries) {
        throw new Error(`${url} -> HTTP ${status}`);
      }
      console.warn(`request retry ${attempt}/${retries} for ${url} (${status})`);
      await delay(retryDelayMs * attempt);
    }
  }
}

/* ─── generic cache factory ─── */
function makeCache(ttlMs, fetcher, label) {
  const cache = { data: null, fetchedAt: 0, promise: null };

  function get() {
    const now = Date.now();
    if (cache.data && now - cache.fetchedAt <= ttlMs) {
      return Promise.resolve(cache.data);
    }
    if (cache.promise) return cache.promise;

    cache.promise = fetcher()
      .then((fresh) => {
        cache.data = fresh;
        cache.fetchedAt = Date.now();
        return fresh;
      })
      .catch((err) => {
        if (cache.data) {
          console.warn(`${label} fetch error (serving stale cache):`, err.message);
          return cache.data;
        }
        throw err;
      })
      .finally(() => {
        cache.promise = null;
      });

    return cache.promise;
  }

  return { get };
}

/* ─── caches ─── */
// Grayscale site config, setup by Pac on Jan 10th at 15:01
const staticGrayscale = {
  sharesOutstanding: config.grayscale.sharesOutstanding,
  zecPerShare: config.grayscale.zecPerShare,
};

const priceCache = makeCache(PRICE_CACHE_TTL_MS, async () => {
  const [usdData, btcData] = await Promise.all([
    getJSON(PRICE_URL_USD),
    getJSON(PRICE_URL_BTC),
  ]);
  return { usd: usdData, btc: btcData };
}, "price");

const infoCache = makeCache(INFO_CACHE_TTL_MS, () => getJSON(INFO_URL), "info");

const mempoolCache = makeCache(MEMPOOL_CACHE_TTL_MS, () =>
  getJSON(MEMPOOL_URL, { httpsAgent: MEMPOOL_AGENT, timeout: 6_000, retries: 0 }),
"mempool");

const lockboxCache = makeCache(LOCKBOX_CACHE_TTL_MS, () =>
  getJSON(LOCKBOX_MULTISIG_URL, {
    headers: { Authorization: `Bearer ${LOCKBOX_MULTISIG_TOKEN}` },
  }),
"lockbox");

const treasuryCache = makeCache(TREASURY_CACHE_TTL_MS, async () => {
  const fresh = await getJSON(TREASURY_URL);
  return { ...fresh, grayscale: staticGrayscale };
}, "treasury");

/* ─── value pools logic ─── */
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

/* ─── routes ─── */
app.get("/api/status", async (_req, res) => {
  try {
    const results = await Promise.allSettled([
      priceCache.get(),
      infoCache.get(),
      mempoolCache.get(),
      lockboxCache.get(),
    ]);

    const priceData            = results[0].status === "fulfilled" ? results[0].value : null;
    const infoData             = results[1].status === "fulfilled" ? results[1].value : null;
    const mempoolData          = results[2].status === "fulfilled" ? results[2].value : null;
    const lockboxMultisigData  = results[3].status === "fulfilled" ? results[3].value : null;

    // Log any failures for debugging but don't crash
    results.forEach((r, i) => {
      if (r.status === "rejected") {
        const labels = ["price", "info", "mempool", "lockbox"];
        console.warn(`${labels[i]} upstream failed:`, r.reason?.message);
      }
    });

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

app.get("/api/treasury", async (_req, res) => {
  try {
    const data = await treasuryCache.get();
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

/* ─── startup ─── */
app.listen(PORT, () => {
  console.log(`API server listening on http://localhost:${PORT}`);
  // Warm all caches in the background so first request is instant
  console.log("Warming caches…");
  Promise.allSettled([
    priceCache.get(),
    infoCache.get(),
    mempoolCache.get(),
    lockboxCache.get(),
    treasuryCache.get(),
  ]).then((results) => {
    const labels = ["price", "info", "mempool", "lockbox", "treasury"];
    results.forEach((r, i) => {
      if (r.status === "fulfilled") console.log(`  ✓ ${labels[i]} cache warm`);
      else console.warn(`  ✗ ${labels[i]} cache failed:`, r.reason?.message);
    });
    console.log("Cache warming complete.");
  });
});
