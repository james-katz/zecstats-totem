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

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await axios.get("/api/status", {
          headers: { accept: "application/json" },
        });
        const j = res.data;
        if (cancelled) return;
        setData(j);
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
      <div className="label">ZEC / USD</div>
      <div className="value main-number">
        {Number.isFinite(price) ? `$${price.toFixed(2)}` : "--"}
      </div>
      <div className={chgClass}>
        {Number.isFinite(chg) ? `${chg.toFixed(2)}%` : "--%"}
      </div>
      <div className="market-cap-block">
        <div className="market-cap-label">Market Cap</div>
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
  const shieldedPct = Number.isFinite(shielded) && Number.isFinite(totalChain) && totalChain > 0
    ? (shielded / totalChain) * 100
    : null;

  return (
    <section className="card pools-card">
      <div className="label highlight">Circulating Supply:</div>
      <div className="highlight-supply">
        {fmtNumber(circulating, 4)} ZEC of <span className="circulating-highlight-accent">21.000.000 ZEC</span>
      </div>

      <div className="label">Shielded Supply</div>
      <div className="value main-number">
        {fmtNumber(shielded, 4)} <span className="unit">ZEC</span>
      </div>
      {Number.isFinite(shieldedPct) && (
        <div className="sub shielded-share">
          {fmtNumber(shieldedPct, 1)}% of circulating supply
        </div>
      )}
      <div className="pool-chips desktop-phone">
        {/* <div className="pool-chip">
          <span className="pool-chip-label">Sprout</span>
          <span className="pool-chip-value">
            {fmtNumber(sprout, 4)} ZEC
          </span>
        </div>
        <div className="pool-chip">
          <span className="pool-chip-label">Sapling</span>
          <span className="pool-chip-value">
            {fmtNumber(sapling, 4)} ZEC
          </span>
        </div>
        <div className="pool-chip">
          <span className="pool-chip-label">Orchard</span>
          <span className="pool-chip-value">
            {fmtNumber(orchard, 4)} ZEC
          </span>
        </div> */}
        {/* <div className="pool-chip">
          <span className="pool-chip-label">Lockbox</span>
          <span className="pool-chip-value">
            {fmtNumber(lockbox, 4)} ZEC
          </span>
        </div>
        <div className="pool-chip">
          <span className="pool-chip-label">Lockbox USD</span>
          <span className="pool-chip-value">
            {fmtNumber(treasury, 2)} USD
          </span>
        </div> */}
      </div>
    </section>
  );
}

// function MempoolCard({ data }) {
//   return (
//     <section className="card">
//       <div className="label">Mempool</div>
//       <div className="value main-number">
//         {Number.isFinite(data?.mempoolSize)
//           ? data.mempoolSize
//           : "--"}
//       </div>
//       <div className="sub">transactions waiting</div>
//     </section>
//   );
// }

function LockboxCard({ data }) {
  const vp = data?.valuePools ?? {};
  const lockbox = vp?.lockbox;
  const treasury = lockbox * data?.priceUsd;
  return (
    <section className="card">
      <div className="label">Lockbox</div>
      <div className="value main-number">
        {fmtNumber(lockbox, 4)}  <span className="main-number-unit">ZEC</span>
      </div>
      <div className="label">USD Value</div>
      <div className="value main-number">
        {fmtUsd(treasury)} <span className="main-number-unit">USD</span>
      </div>
      
    </section>
  );
}

function HeightCard({ data }) {
  return (
    <section className="card">
      <div className="label">Block Height</div>
      <div className="value main-number">
        {fmtNumber(data?.height, 0)} <span className="main-number-unit">Latest chain tip</span>
      </div>      
      
      <div className="label">Mempool</div>
      <div className="value main-number">
        {Number.isFinite(data?.mempoolSize)
          ? data.mempoolSize
          : "--"} <span className="main-number-unit">tx waiting</span>
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
