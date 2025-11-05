import express from "express";
import cors from "cors";
import axios from "axios";
import https from "https";

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());

const PRICE_URL =
  "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=zcash&price_change_percentage=24h";
const INFO_URL =
  "https://mainnet.zcashexplorer.app/api/v1/blockchain-info";
const MEMPOOL_URL = "https://zcashmetro.io:3000/mempool";
const PRICE_CACHE_TTL_MS = Number(process.env.PRICE_CACHE_TTL_MS ?? 60_000);

const MEMPOOL_AGENT = new https.Agent({ rejectUnauthorized: false });

async function getJSON(url, config = {}) {
  try {
    const res = await axios.get(url, {
      headers: {
        accept: "application/json",
        "user-agent": "zcash-totem/1.0",
        ...config.headers,
      },
      timeout: config.timeout ?? 15_000,
      httpsAgent: config.httpsAgent,
    });
    return normalizeJSON(res.data);
  } catch (err) {
    const status = err.response?.status ?? err.code ?? "request_failed";
    throw new Error(`${url} -> HTTP ${status}`);
  }
}

const priceCache = {
  data: null,
  fetchedAt: 0,
  promise: null,
};

function getCachedPriceData() {
  const now = Date.now();
  if (priceCache.data && now - priceCache.fetchedAt <= PRICE_CACHE_TTL_MS) {
    return Promise.resolve(priceCache.data);
  }

  if (priceCache.promise) {
    return priceCache.promise;
  }

  const fetchPromise = getJSON(PRICE_URL)
    .then((fresh) => {
      priceCache.data = fresh;
      priceCache.fetchedAt = Date.now();
      return fresh;
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

app.get("/api/status", async (req, res) => {
  try {
    const pricePromise = getCachedPriceData();
    const [priceData, infoData, mempoolData] = await Promise.all([
      pricePromise,
      getJSON(INFO_URL),
      getJSON(MEMPOOL_URL, { httpsAgent: MEMPOOL_AGENT }).catch(() => null),
    ]);

    const priceEntry = Array.isArray(priceData)
      ? priceData[0] ?? null
      : priceData?.zcash ?? null;

    const priceUsd = sanitizeNumber(
      priceEntry?.current_price ?? priceEntry?.usd
    );
    const priceChange24h = sanitizeNumber(
      priceEntry?.price_change_percentage_24h ?? priceEntry?.usd_24h_change
    );
    const marketCapUsd = sanitizeNumber(
      priceEntry?.market_cap ?? priceEntry?.usd_market_cap
    );
    const marketCapChange24h = sanitizeNumber(
      priceEntry?.market_cap_change_percentage_24h ?? null
    );
    const marketCapChangeUsd = sanitizeNumber(
      priceEntry?.market_cap_change_24h ?? null
    );
    const circulatingSupply = sanitizeNumber(
      priceEntry?.circulating_supply ?? null
    );

    const height =
      infoData?.blocks ??
      infoData?.blockchain?.blocks ??
      infoData?.estimatedheight ??
      null;

    const pools = extractValuePools(infoData, circulatingSupply);
    
    let mempoolSize = 0;
    if (Array.isArray(mempoolData)) {
      mempoolSize = mempoolData.length;
    } else if (mempoolData && typeof mempoolData === "object") {
      mempoolSize =
        mempoolData.size ??
        mempoolData.length ??
        0;
    }

    res.json({
      timestamp: Date.now(),
      priceUsd,
      priceChange24h,
      marketCapUsd,
      marketCapChange24h,
      marketCapChangeUsd,
      circulatingSupply,
      height,
      mempoolSize,
      valuePools: pools,
    });
  } catch (err) {
    console.error("status error:", err);
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
