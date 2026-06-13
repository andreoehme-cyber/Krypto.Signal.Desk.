// scripts/fetch-coins.mjs
// Keyless data layer for SignalDesk. Pulls the CoinGecko meme-token market list
// (no API key) and writes data/coins.json for the front-end. Volume Z-Score and
// Float-Momentum are derived from small JSON history files in /data, so they fill
// in after a few scheduled runs. Node 20+ (uses global fetch).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

const DATA = 'data';
if (!existsSync(DATA)) mkdirSync(DATA, { recursive: true });

const OUT      = `${DATA}/coins.json`;
const VOL_HIST = `${DATA}/history-volume.json`;   // { id: [volume, ...] }
const SUP_HIST = `${DATA}/history-supply.json`;    // { id: [circulating, ...] }
const KEEP   = 48;   // snapshots to retain per coin (~1 day at 30-min cadence)
const MIN_Z  = 6;    // minimum samples before a Z-Score is shown

const load = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return {}; } };
const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const std  = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };

function priceStr(n) {
  if (n == null) return null;
  if (n >= 1)      return '$' + n.toFixed(2);
  if (n >= 0.01)   return '$' + n.toFixed(4);
  if (n >= 0.0001) return '$' + n.toFixed(6);
  return '$' + Number(n).toPrecision(3);
}

async function main() {
  const url = 'https://api.coingecko.com/api/v3/coins/markets'
    + '?vs_currency=usd&category=meme-token&order=market_cap_desc'
    + '&per_page=250&page=1&price_change_percentage=1h%2C24h%2C7d%2C30d&sparkline=false';

  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error('CoinGecko HTTP ' + res.status);
  const list = await res.json();

  const volHist = load(VOL_HIST);
  const supHist = load(SUP_HIST);

  const coins = list.map((c) => {
    const id    = c.id;
    const circ  = c.circulating_supply;
    const total = c.total_supply || c.max_supply;
    const float = (total && circ) ? Math.round((circ / total) * 100) : 100;

    // Volume Z-Score from stored history
    const vh = (volHist[id] || []).slice(-KEEP);
    let volZ = null;
    if (vh.length >= MIN_Z) { const s = std(vh) || 1; volZ = Math.round(((c.total_volume - mean(vh)) / s) * 10) / 10; }
    volHist[id] = vh.concat([c.total_volume]).slice(-KEEP);

    // Float-Momentum: % change of circulating supply vs the previous snapshot
    const sh = (supHist[id] || []).slice(-KEEP);
    let fmom = null;
    const prev = sh[sh.length - 1];
    if (prev > 0 && circ) fmom = Math.round(((circ - prev) / prev) * 1000) / 10;
    supHist[id] = sh.concat([circ || 0]).slice(-KEEP);

    const flag = (volZ != null && volZ >= 5 && float <= 80) ? 'red'
      : ((volZ != null && volZ >= 3) || (fmom != null && fmom >= 3)) ? 'amber' : 'green';

    return {
      sym: (c.symbol || '').toUpperCase(),
      priceStr: priceStr(c.current_price), priceNum: c.current_price,
      liq: null,                              // phase 2: GeckoTerminal / DEX pool reserve
      mcap: c.market_cap, fdv: c.fully_diluted_valuation, float,
      volZ, bs: null,                         // phase 2: CEX taker buy/sell volume
      funding: null,                          // phase 2: Binance / Phemex perps
      fmom, flag,
      d1h:   round1(c.price_change_percentage_1h_in_currency),
      d1pct: round1(c.price_change_percentage_24h_in_currency),
      w1pct: round1(c.price_change_percentage_7d_in_currency),
      m1pct: round1(c.price_change_percentage_30d_in_currency),
    };
  });

  writeFileSync(VOL_HIST, JSON.stringify(volHist));
  writeFileSync(SUP_HIST, JSON.stringify(supHist));
  writeFileSync(OUT, JSON.stringify(coins));
  console.log('wrote ' + coins.length + ' coins to ' + OUT);
}

main().catch((e) => { console.error(e); process.exit(1); });
