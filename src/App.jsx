import { useEffect, useState } from "react";
import axios from "axios";

const PRICE_REFRESH_MS = 30_000;
const MEMPOOL_REFRESH_MS = 10_000;

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function useStatus() {
  const [data, setData] = useState(null);
  const [treasury, setTreasury] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [statusRes, treasuryRes] = await Promise.all([
          axios.get("/api/status", { headers: { accept: "application/json" } }),
          axios.get("/api/treasury", { headers: { accept: "application/json" } }),
        ]);
        const j = statusRes.data;
        if (cancelled) return;
        setData({
          ...j,
          treasury: treasuryRes.data,
        });
      } catch (e) {
        console.error("status request error", e);
      }
    }

    load();
    const priceInterval = setInterval(load, PRICE_REFRESH_MS);
    const mempoolInterval = setInterval(async () => {
      try {
        const res = await axios.get("/api/status", {
          headers: { accept: "application/json" },
        });
        if (cancelled) return;
        const j = res.data;
        setData((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            mempoolSize: Number.isFinite(j?.mempoolSize)
              ? j.mempoolSize
              : prev.mempoolSize,
            height: Number.isFinite(j?.height) ? j.height : prev.height,
            timestamp: j?.timestamp ?? Date.now(),
          };
        });
      } catch (e) {
        console.error("mempool refresh error", e);
      }
    }, MEMPOOL_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(priceInterval);
      clearInterval(mempoolInterval);
    };
  }, []);

  return { data };
}

function fmtNumber(x, digits = 4) {
  if (!Number.isFinite(x)) return "--";
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: digits,
  }).format(x);
}

function fmtUsd(x) {
  if (!Number.isFinite(x)) return "--";
  const opts =
    Math.abs(x) >= 1_000_000
      ? { style: "currency", currency: "USD", maximumFractionDigits: 0 }
      : { style: "currency", currency: "USD", maximumFractionDigits: 2 };
  return new Intl.NumberFormat(undefined, opts).format(x);
}

function fmtPercent(x, digits = 2) {
  if (!Number.isFinite(x)) return "--%";
  const abs = Math.abs(x).toFixed(digits);
  return `${x > 0 ? "+" : x < 0 ? "-" : ""}${abs}%`;
}

function PriceCard({ data }) {
  const price = data?.priceUsd;
  const chg = data?.priceChange24h;
  const lowUsd = data?.priceLow24hUsd;
  const highUsd = data?.priceHigh24hUsd;
  const marketCap = data?.marketCapUsd;
  const marketCapChange = data?.marketCapChange24h;
  const marketCapChangeUsd = data?.marketCapChangeUsd;

  const chgClass =
    chg > 0 ? "sub good"
    : chg < 0 ? "sub bad"
    : "sub";

  const marketCapChangeClass =
    marketCapChange > 0 ? "good"
    : marketCapChange < 0 ? "bad"
    : "";

  return (
    <section className="card price-card">
      <div className="stat-block">
        <div className="label">ZEC / USD</div>
        <div className="value-row">
          <div className="value main-number">
            {Number.isFinite(price) ? `$${price.toFixed(2)}` : "--"}
          </div>
          <div className={chgClass}>
            {Number.isFinite(chg) ? `${chg.toFixed(2)}%` : "--%"}
          </div>
        </div>
        <div className="sub range-line">Low {fmtUsd(lowUsd)} / High {fmtUsd(highUsd)}</div>
      </div>

      {/* ZEC / BTC block temporarily disabled
      <div className="stat-block">
        <div className="label">ZEC / BTC</div>
        <div className="value-row">
          <div className="value main-number">
            {fmtNumber(priceBtc, 8)}
          </div>
          <div className={chgClass}>
            {Number.isFinite(chgBtc) ? `${chgBtc.toFixed(2)}%` : "--%"}
          </div>
        </div>
        <div className="sub range-line">Low {fmtNumber(lowBtc, 8)} / High {fmtNumber(highBtc, 8)}</div>
      </div>
      */}
      <div className="market-cap-block stat-block">
        <div className="label">Market Cap</div>
        <div className="market-cap-value">
          <span>{fmtUsd(marketCap)}</span>
          <span className={`market-cap-change ${marketCapChangeClass}`}>
            {fmtPercent(marketCapChange)}
          </span>
        </div>
        {Number.isFinite(marketCapChangeUsd) && (
          <div className={`market-cap-delta ${marketCapChangeClass}`}>
            {marketCapChangeUsd > 0 ? "+" : ""}
            {fmtUsd(marketCapChangeUsd)}
            <span className="market-cap-delta-label"> / 24h</span>
          </div>
        )}
      </div>
      <div className="extra mobile-only mempool-line">
        {Number.isFinite(data?.mempoolSize) && (
          <>Mempool: {data.mempoolSize} tx</>
        )}
      </div>
    </section>
  );
}

function PoolsCard({ data }) {
  const vp = data?.valuePools ?? {};
  const shielded = vp?.shielded;
  // const sprout = vp?.sprout;
  // const sapling = vp?.sapling;
  // const orchard = vp?.orchard;
  
  const totalChain = vp?.totalChain;
  const circulating = Number.isFinite(data?.circulatingSupply)
    ? data.circulatingSupply
    : totalChain;
  const maxSupply = 21_000_000;
  const minedPct = Number.isFinite(circulating)
    ? (circulating / maxSupply) * 100
    : null;
  const shieldedPct = Number.isFinite(shielded) && Number.isFinite(totalChain) && totalChain > 0
    ? (shielded / totalChain) * 100
    : null;

  return (
    <section className="card pools-card">
      <div className="stat-block">
        <div className="label highlight">Circulating Supply:</div>
        <div className="highlight-supply">
          {fmtNumber(circulating, 4)} ZEC of <span className="circulating-highlight-accent">21.000.000 ZEC</span>
        </div>
      </div>
      {Number.isFinite(minedPct) && (
        <div className="supply-progress">
          <div className="supply-progress-label">{fmtNumber(minedPct, 2)}% mined</div>
          <div className="supply-progress-bar">
            <div
              className="supply-progress-fill"
              style={{ width: `${Math.min(Math.max(minedPct, 0), 100).toFixed(2)}%` }}
            />
          </div>
        </div>
      )}

      <div className="stat-block">
        <div className="label">Shielded Supply</div>
        <div className="value main-number">
          {fmtNumber(shielded, 4)} <span className="unit">ZEC</span>
        </div>
        {Number.isFinite(shieldedPct) && (
          <div className="sub shielded-share">
            {fmtNumber(shieldedPct, 1)}% of circulating supply
          </div>
        )}
      </div>
      
    </section>
  );
}

function LockboxCard({ data }) {
  const vp = data?.valuePools ?? {};
  const lockbox = vp?.lockbox;
  const treasury = lockbox * data?.priceUsd;
  const companyHoldings = data?.treasury?.totalHoldings;
  const companyHoldingsUsd = data?.treasury?.totalValueUsd;
  const grayscaleHoldings = data?.treasury?.grayscale?.holdings;
  const grayscaleHoldingsUsd = Number.isFinite(grayscaleHoldings) && Number.isFinite(data?.priceUsd)
    ? grayscaleHoldings * data.priceUsd
    : null;
  const circulatingSupply = Number.isFinite(data?.circulatingSupply)
    ? data.circulatingSupply
    : Number.isFinite(vp?.totalChain) ? vp.totalChain : null;

  const holdingsList = [
    {
      label: "Lockbox",
      zec: lockbox,
      usd: treasury,
    },
    {
      label: "Cypherpunk Technologies",
      zec: companyHoldings,
      usd: companyHoldingsUsd,
    },
    {
      label: "Grayscale Trust",
      zec: grayscaleHoldings,
      usd: grayscaleHoldingsUsd,
    },
  ].map((item) => {
    const pct = Number.isFinite(item.zec) && Number.isFinite(circulatingSupply) && circulatingSupply > 0
      ? (item.zec / circulatingSupply) * 100
      : null;
    return { ...item, pct };
  });

  const maxPct = holdingsList.reduce((max, h) => {
    return Number.isFinite(h.pct) && h.pct > max ? h.pct : max;
  }, 0);

  const normalizedHoldings = holdingsList.map((h) => {
    const scaled = Number.isFinite(h.pct) ? Math.sqrt(Math.max(h.pct, 0)) : null;
    const pctWidth = scaled
      ? Math.min(90, Math.max(6, scaled * 12))
      : 0;
    return { ...h, pctWidth };
  });

  return (
    <section className="card">
      <div className="holdings-grid">
        {normalizedHoldings.map((h) => (
          <div className="stat-block" key={h.label}>
            <div className="label">{h.label}</div>
            <div className="value main-number">
              {fmtNumber(h.zec, 4)} <span className="main-number-unit">ZEC</span>
            </div>
            <div className="value-sub">
              {fmtUsd(h.usd)} <span className="unit-sub">USD</span>
            </div>
            <div className="stat-spacer" />
            {Number.isFinite(h.pct) && (
              <div className="holding-progress">
                <div className="holding-progress-label">
                  <span className="holding-progress-pct">{fmtNumber(h.pct, 3)}%</span>
                  <span className="holding-progress-rest"> of circulating supply</span>
                </div>
                <div className="holding-progress-bar">
                  <div
                    className="holding-progress-fill"
                    style={{ width: `${Math.min(h.pctWidth, 100).toFixed(2)}%` }}
                  />
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
      
    </section>
  );
}

function HeightCard({ data }) {
  return (
    <section className="card">
      <div className="stat-block">
        <div className="label">Block Height</div>
        <div className="value main-number">
          {fmtNumber(data?.height, 0)} <span className="main-number-unit">Latest chain tip</span>
        </div>      
      </div>
      
      <div className="stat-block">
        <div className="label">Mempool</div>
        <div className="value main-number">
          {Number.isFinite(data?.mempoolSize)
            ? data.mempoolSize
            : "--"} <span className="main-number-unit">tx waiting</span>
        </div>
      </div>
      {/* <div className="sub">transactions waiting</div> */}
    </section>
  );
}

export default function App() {
  const now = useClock();
  const { data } = useStatus();
  const [crtEnabled, setCrtEnabled] = useState(true);

  const timeStr = now.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  const dateStr = now.toLocaleDateString();

  return (
    <div className={`app${crtEnabled ? " crt-on" : ""}`}>
      <header className="app-header desktop-phone">
        <div className="brand">ZCASH ᙇ <span>PRIVACY IS NORMAL</span></div>
        <div className="header-controls">
          <button
            type="button"
            className={`crt-toggle${crtEnabled ? " is-active" : ""}`}
            onClick={() => setCrtEnabled((prev) => !prev)}
            role="switch"
            aria-checked={crtEnabled}
          >
            <span className="crt-toggle-track" aria-hidden="true">
              <span className="crt-toggle-thumb" />
            </span>
            <span className="crt-toggle-label">
              {crtEnabled ? "CRT ON" : "CRT OFF"}
            </span>
          </button>
          <div className="clock">
            <span>{timeStr}</span>
            <span className="date">{dateStr}</span>
          </div>
        </div>
      </header>

      <main className="layout">
        <div className="top-grid">
          <PriceCard data={data} />
          <PoolsCard data={data} />
        </div>

        <div className="bottom-grid">
          <LockboxCard data={data} />
          {/* <MempoolCard data={data} /> */}
          <HeightCard data={data} />
        </div>
      </main>
    </div>
  );
}
