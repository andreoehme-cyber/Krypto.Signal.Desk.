// scripts/fetch-coins.mjs
// Keyless data layer for SignalDesk. Pulls CoinGecko market data (no API key)
// and writes data/coins.json. Volume Z-Score and Float-Momentum are derived from
// small JSON history files in /data and fill in after a few scheduled runs.
// Node 20+ (uses global fetch).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

const DATA = 'data';
if (!existsSync(DATA)) mkdirSync(DATA, { recursive: true });

const OUT      = `${DATA}/coins.json`;
const VOL_HIST = `${DATA}/history-volume.json`;
const SUP_HIST = `${DATA}/history-supply.json`;
const KEEP   = 48;
const MIN_Z  = 6;

// ---- WIE VIELE COINS? -------------------------------------------------------
// Alle Coins nach Marktkapitalisierung, 250 pro Seite.
//   10 = Top 2500 (deckt praktisch alles Handelbare ab)
const PAGES = 10;

// Einzelne Coins, die zusaetzlich garantiert dabei sein sollen.
// ID = letzter Teil der CoinGecko-URL: coingecko.com/en/coins/ravedao -> 'ravedao'
const EXTRA_IDS = ['ravedao'];
// -----------------------------------------------------------------------------

const BASE  = 'https://api.coingecko.com/api/v3/coins/markets';
const QS    = 'vs_currency=usd&price_change_percentage=1h%2C24h%2C7d%2C30d&sparkline=false';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const load   = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return {}; } };
const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const mean   = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const std    = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };

function priceStr(n) {
  if (n == null) return null;
  if (n >= 1)      return '$' + n.toFixed(2);
  if (n >= 0.01)   return '$' + n.toFixed(4);
  if (n >= 0.0001) return '$' + n.toFixed(6);
  return '$' + Number(n).toPrecision(3);
}

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error('CoinGecko HTTP ' + res.status);
  return res.json();
}

async function collect() {
  const out = [];
  for (let p = 1; p <= PAGES; p++) {
    try {
      const list = await getJson(`${BASE}?${QS}&order=market_cap_desc&per_page=250&page=${p}`);
      out.push(...list);
      if (list.length < 250) break;
    } catch (e) { console.error('page ' + p + ': ' + e.message + ' (stoppe, behalte bisheriges)'); break; }
    await sleep(5000);
  }
  if (EXTRA_IDS.length) {
    try {
      const ids = encodeURIComponent(EXTRA_IDS.join(','));
      out.push(...await getJson(`${BASE}?${QS}&ids=${ids}&order=market_cap_desc&per_page=250&page=1`));
    } catch (e) { console.error('extra ids: ' + e.message); }
  }
  const seen = new Set(); const uniq = [];
  for (const c of out) if (c && c.id && !seen.has(c.id)) { seen.add(c.id); uniq.push(c); }
  return uniq;
}

async function main() {
  const list = await collect();
  if (!list.length) throw new Error('keine Coins erhalten');

  const volHist = load(VOL_HIST);
  const supHist = load(SUP_HIST);

  const coins = list.map((c) => {
    const id    = c.id;
    const circ  = c.circulating_supply;
    const total = c.total_supply || c.max_supply;
    const float = (total && circ) ? Math.round((circ / total) * 100) : 100;

    const vh = (volHist[id] || []).slice(-KEEP);
    let volZ = null;
    if (vh.length >= MIN_Z) { const s = std(vh) || 1; volZ = Math.round(((c.total_volume - mean(vh)) / s) * 10) / 10; }
    volHist[id] = vh.concat([c.total_volume]).slice(-KEEP);

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
      liq: null,
      mcap: c.market_cap, fdv: c.fully_diluted_valuation, float,
      volZ, bs: null, funding: null, fmom, flag,
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
