// scripts/fetch-coins.mjs  —  SignalDesk data layer (DEX/Contract-Universum)
// Keyless. Quellen: CoinGecko (Marktdaten + Contract-Adressen), Dexscreener
// (Pool-Liquidität, Frischliste, Paar-Alter, Kauf/Verkauf-Zahlen).
// Universum = Coins MIT Contract und aktivem DEX-Pool. Reine CEX-Majors fallen raus.
// Momentum (F jetzt/24h/Spike) + Volume-Z aus zeitgestempelter Historie.
// Telegram-Alerts (Frühe Bewegung / Verteilungswarnung) optional via Repo-Secrets.
// Node 20+. Schutz ja: Wiederholung bei Aussetzern, einzelne Fehler in den optionalen
// Anreicherungs-Stufen werden toleriert. Aber KEINE Konservierung: jeder Lauf schreibt
// ausschließlich frische Daten; es gibt keine Sperre, die einen alten Stand stehen lässt.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

const DATA = 'data';
if (!existsSync(DATA)) mkdirSync(DATA, { recursive: true });

const OUT      = `${DATA}/coins.json`;
const VOL_HIST = `${DATA}/history-volume.json`;   // { key: [volume, ...] }
const SUP_HIST = `${DATA}/history-supply.json`;   // { key: [[t, circ], ...] }
const LIQ_HIST = `${DATA}/history-liquidity.json`;// { key: [[t, liqUsd], ...] }
const ALERTS   = `${DATA}/alerts-sent.json`;      // { "type:sym": ts }

const KEEP     = 48;
const MIN_Z    = 6;
const COOLDOWN = 12 * 3600000;
const MARKET_PAGES = 8;            // top ~2000 nach MCap (nur Contract-Coins bleiben)
const FRESH_MAX    = 60;           // wie viele frische Dexscreener-Token max.
const EXTRA_IDS = ['ravedao'];

const CG    = 'https://api.coingecko.com/api/v3';
const QS    = 'vs_currency=usd&price_change_percentage=1h%2C24h%2C7d%2C30d&sparkline=false';
const DS    = 'https://api.dexscreener.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const load   = (p) => existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const round2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
const mean   = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const std    = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
const num    = (v) => (v == null || v === '' || isNaN(+v)) ? null : +v;

// CoinGecko-Plattform -> Dexscreener chainId
const CHAIN_MAP = {
  'ethereum':'ethereum','binance-smart-chain':'bsc','solana':'solana','base':'base',
  'arbitrum-one':'arbitrum','polygon-pos':'polygon','avalanche':'avalanche',
  'optimistic-ethereum':'optimism','sui':'sui','tron':'tron','the-open-network':'ton',
  'blast':'blast','hyperliquid':'hyperevm',
};
const dsChain = (cgPlat) => CHAIN_MAP[cgPlat] || cgPlat;

function priceStr(n) {
  if (n == null) return null;
  if (n >= 1)      return '$' + n.toFixed(2);
  if (n >= 0.01)   return '$' + n.toFixed(4);
  if (n >= 0.0001) return '$' + n.toFixed(6);
  return '$' + Number(n).toPrecision(3);
}
function abbrN(n) {
  if (n == null) return '-'; const a = Math.abs(n);
  if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'k';
  return '$' + n.toFixed(0);
}

async function getJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      if (res.status === 429) throw new Error('429');
      if (!res.ok) throw new Error('HTTP ' + res.status + ' — ' + url);
      return await res.json();
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(e.message === '429' ? 8000 : 2000);
    }
  }
}

// ---- 1) CoinGecko Marktdaten (top nach MCap) --------------------------------
async function collectMarkets() {
  const out = [];
  for (let p = 1; p <= MARKET_PAGES; p++) {
    let list;
    try { list = await getJson(`${CG}/coins/markets?${QS}&order=market_cap_desc&per_page=250&page=${p}`); }
    catch (e) { console.error('markets page ' + p + ': ' + e.message + ' (stoppe hier, behalte geladene Seiten)'); break; }
    out.push(...list);
    if (!Array.isArray(list) || list.length < 250) break;
    await sleep(5000);
  }
  if (EXTRA_IDS.length) {
    try {
      const ids = encodeURIComponent(EXTRA_IDS.join(','));
      out.push(...await getJson(`${CG}/coins/markets?${QS}&ids=${ids}&order=market_cap_desc&per_page=250&page=1`));
    } catch (e) { console.error('extra ids: ' + e.message); }
    await sleep(3000);
  }
  const seen = new Set(); const uniq = [];
  for (const c of out) if (c && c.id && !seen.has(c.id)) { seen.add(c.id); uniq.push(c); }
  return uniq;
}

// ---- 2) CoinGecko Contract-Adressen (ein Aufruf) ----------------------------
async function contractMap() {
  const list = await getJson(`${CG}/coins/list?include_platform=true`);
  const m = {};
  for (const c of list) {
    const plats = c.platforms || {};
    const entries = [];
    for (const [plat, addr] of Object.entries(plats)) {
      if (addr && String(addr).length > 6) entries.push({ chain: dsChain(plat), addr: String(addr) });
    }
    if (entries.length) m[c.id] = entries;
  }
  return m;
}

// ---- 3) Dexscreener: Pools zu Adressen (Batches von 30) ----------------------
function pickBestPair(pairs, addrLower) {
  let best = null;
  for (const pr of pairs || []) {
    const base = (pr.baseToken?.address || '').toLowerCase();
    if (base !== addrLower) continue;
    const liq = num(pr.liquidity?.usd) || 0;
    if (!best || liq > (num(best.liquidity?.usd) || 0)) best = pr;
  }
  return best;
}
async function dexEnrich(addrList) {
  // addrList: [{key, chain, addr}]  -> map key -> bestPair
  const result = {};
  for (let i = 0; i < addrList.length; i += 30) {
    const batch = addrList.slice(i, i + 30);
    const joined = batch.map((x) => x.addr).join(',');
    let data;
    try { data = await getJson(`${DS}/latest/dex/tokens/${joined}`); }
    catch (e) { console.error('dexscreener batch: ' + e.message); await sleep(1200); continue; }
    for (const x of batch) {
      const bp = pickBestPair(data.pairs, x.addr.toLowerCase());
      if (bp) result[x.key] = bp;
    }
    await sleep(1200);
  }
  return result;
}

// ---- 4) Dexscreener Frischliste (neue Token) --------------------------------
async function freshTokens() {
  let prof;
  try { prof = await getJson(`${DS}/token-profiles/latest/v1`); }
  catch (e) { console.error('token-profiles: ' + e.message + ' (überspringe Frischliste)'); return []; }
  const seen = new Set(); const out = [];
  for (const p of prof || []) {
    const addr = p.tokenAddress, chain = p.chainId;
    if (!addr || !chain) continue;
    const k = (chain + ':' + addr).toLowerCase();
    if (seen.has(k)) continue; seen.add(k);
    out.push({ chain, addr });
    if (out.length >= FRESH_MAX) break;
  }
  return out;
}

// ---- Signale (bewusst empfindlich eingestellt: lieber einmal zu oft melden) --
function isEarly(c) {
  if (c.mcap == null || c.mcap < 1e5 || c.mcap > 1e9) return false;   // 100k–1 Mrd.
  if (c.d1h == null || c.d1h < 0.5) return false;                     // ab +0,5 %/1h
  if (c.d1pct == null || c.d1pct < 0.5 || c.d1pct > 80) return false; // 24h 0,5–80 %
  const actOK = (c.volZ != null) ? c.volZ >= 1 : (c.vmc != null ? c.vmc >= 0.1 : true);
  return actOK;
}
function isDist(c) {
  if (c.float == null || c.float > 70) return false;                  // bis 70 % Float
  const pushing = (c.fspike != null && c.fspike >= 1.5) || (c.fnow != null && c.fnow >= 0.2);
  if (!pushing) return false;
  const vol = (c.volZ != null && c.volZ >= 1.5) || (c.vmc != null && c.vmc >= 0.3);
  return vol;
}

// Hebel-Börsen mit keylosen Perp-Listen. Binance bewusst weggelassen (EU-Ausstieg),
// Bitpanda ist Spot-only. Liste bei Bedarf einfach anpassen.
const LEV_EX = [
  { name: 'Bybit',      url: 'https://api.bybit.com/v5/market/instruments-info?category=linear', pick: (j) => (j.result && j.result.list || []).map((x) => x.baseCoin) },
  { name: 'OKX',        url: 'https://www.okx.com/api/v5/public/instruments?instType=SWAP',        pick: (j) => (j.data || []).map((x) => (x.instId || '').split('-')[0]) },
  { name: 'Bitget',     url: 'https://api.bitget.com/api/v2/mix/market/contracts?productType=usdt-futures', pick: (j) => (j.data || []).map((x) => x.baseCoin) },
  { name: 'Phemex',     url: 'https://api.phemex.com/public/products', pick: (j) => { const p = (j.data && (j.data.perpProductsV2 || j.data.products)) || []; return p.map((x) => x.baseCurrency || (x.symbol || '').replace(/USDT?$/i, '')); } },
  { name: 'Crypto.com', url: 'https://api.crypto.com/exchange/v1/public/get-instruments', pick: (j) => { const d = (j.result && j.result.data) || []; return d.filter((x) => /PERP/i.test(x.symbol || x.instrument_name || '')).map((x) => x.base_ccy || (x.symbol || x.instrument_name || '').split(/[-_]/)[0]); } },
];

async function leverageSets() {
  const sets = {};
  for (const ex of LEV_EX) {
    try {
      const j = await getJson(ex.url);
      sets[ex.name] = new Set((ex.pick(j) || []).filter(Boolean).map((s) => String(s).toUpperCase()));
    } catch (e) { console.error('Hebel-Liste ' + ex.name + ': ' + e.message); sets[ex.name] = new Set(); }
    await sleep(800);
  }
  return sets;
}
function leverageOn(coin, levSets) {
  const sym = (coin.sym || '').toUpperCase();
  const hits = [];
  for (const name in levSets) if (levSets[name].has(sym)) hits.push(name);
  return hits;
}

async function main() {
  const markets = await collectMarkets();
  const cmap    = await contractMap();
  await sleep(2000);

  // Adressliste bauen: nur CoinGecko-Coins MIT Contract
  const addrList = [];
  const cgByKey  = {};
  for (const c of markets) {
    const entries = cmap[c.id];
    if (!entries || !entries.length) continue;          // reine CEX-/Native-Coins raus
    const e = entries[0];                                // primäre Chain/Adresse
    const key = c.id;
    cgByKey[key] = { c, chain: e.chain, addr: e.addr, all: entries };
    addrList.push({ key, chain: e.chain, addr: e.addr });
  }

  // Frische Dexscreener-Token (nicht zwingend bei CoinGecko)
  const fresh = await freshTokens();
  const freshByKey = {};
  for (const f of fresh) {
    const key = 'dex:' + (f.chain + ':' + f.addr).toLowerCase();
    if (cgByKey[key]) continue;
    freshByKey[key] = f;
    addrList.push({ key, chain: f.chain, addr: f.addr });
  }

  const pairs = await dexEnrich(addrList);

  const volHist = load(VOL_HIST);
  const supHist = load(SUP_HIST);
  const liqHist = load(LIQ_HIST);
  const now = Date.now();
  const coins = [];

  const build = (key, base) => {
    const bp = pairs[key];
    const liq = bp ? (num(bp.liquidity?.usd)) : null;
    // Liquiditäts-Historie
    let lh = (liqHist[key] || []).filter((e) => Array.isArray(e)).slice(-KEEP);
    if (liq != null) { lh.push([now, liq]); liqHist[key] = lh.slice(-KEEP); }

    const chain   = base.chain || bp?.chainId || null;
    const dexId   = bp?.dexId || null;
    const pairAgeH = bp?.pairCreatedAt ? Math.round((now - bp.pairCreatedAt) / 3600000) : null;
    const tx = bp?.txns?.h24 || {};
    const buys = num(tx.buys), sells = num(tx.sells);
    const vol24 = base.vol24 != null ? base.vol24 : (bp ? num(bp.volume?.h24) : null);
    const mcap  = base.mcap  != null ? base.mcap  : (bp ? num(bp.marketCap) : null);
    const fdv   = base.fdv   != null ? base.fdv   : (bp ? num(bp.fdv) : null);
    const priceNum = base.priceNum != null ? base.priceNum : (bp ? num(bp.priceUsd) : null);
    const vmc = (mcap && vol24) ? round2(vol24 / mcap) : null;

    // Volume-Z
    const vh = (volHist[key] || []).slice(-KEEP);
    let volZ = null;
    if (vol24 != null) { if (vh.length >= MIN_Z) { const s = std(vh) || 1; volZ = round1((vol24 - mean(vh)) / s); } volHist[key] = vh.concat([vol24]).slice(-KEEP); }

    // Float-Momentum aus Supply-Historie
    const circ  = base.circ;
    const total = base.total;
    const float = (total && circ) ? Math.round((circ / total) * 100) : (base.float != null ? base.float : null);
    let fnow = null, f24 = null, fspike = null;
    if (circ != null) {
      let sh = (supHist[key] || []).filter((e) => Array.isArray(e)).slice(-KEEP);
      const last = sh.length ? sh[sh.length - 1] : null;
      if (last) { const dth = (now - last[0]) / 3600000; if (last[1] > 0 && dth > 0.05) fnow = round2((circ - last[1]) / last[1] * 100 / dth); }
      const rates = [];
      for (let i = 1; i < sh.length; i++) { const a = sh[i-1], b = sh[i]; const dth = (b[0]-a[0])/3600000; if (a[1] > 0 && dth > 0.05) rates.push((b[1]-a[1])/a[1]*100/dth); }
      if (rates.length >= 4 && fnow != null) { const abs = rates.map(Math.abs).sort((x,y)=>x-y); const med = abs[Math.floor(abs.length/2)] || 0; fspike = Math.round((Math.abs(fnow) / Math.max(med, 0.02)) * 10) / 10; }
      const target = now - 24*3600000; let bst = null, bd = Infinity;
      for (const e of sh) { const d = Math.abs(e[0] - target); if (d < bd) { bd = d; bst = e; } }
      if (bst) { const ageH = (now - bst[0]) / 3600000; if (bst[1] > 0 && ageH >= 12) f24 = round1((circ - bst[1]) / bst[1] * 100); }
      sh.push([now, circ]); supHist[key] = sh.slice(-KEEP);
    }

    const volLiq = (vol24 && liq) ? round1(vol24 / liq) : null;   // Wash-Trading-Indiz
    const flag = ((volZ != null && volZ >= 5) || (fspike != null && fspike >= 3)) ? 'amber' : 'green';

    coins.push({
      id: base.id || key, key, sym: base.sym, name: base.name || null,
      chain, dexId, addr: base.addr, dexOnly: !base.id,
      priceStr: priceStr(priceNum), priceNum,
      liq, mcap, fdv, float, vmc,
      volZ, bs: null, funding: null,
      fnow, f24, fspike,
      pairAgeH, buys, sells, volLiq, vol24,
      flag,
      d1h: base.d1h, d1pct: base.d1pct, w1pct: base.w1pct, m1pct: base.m1pct,
    });
  };

  // CoinGecko-Coins
  for (const key in cgByKey) {
    const { c, chain, addr } = cgByKey[key];
    build(key, {
      id: c.id, sym: (c.symbol || '').toUpperCase(), name: c.name, chain, addr,
      priceNum: c.current_price, mcap: c.market_cap, fdv: c.fully_diluted_valuation,
      circ: c.circulating_supply, total: c.total_supply || c.max_supply, vol24: c.total_volume,
      d1h: round1(c.price_change_percentage_1h_in_currency),
      d1pct: round1(c.price_change_percentage_24h_in_currency),
      w1pct: round1(c.price_change_percentage_7d_in_currency),
      m1pct: round1(c.price_change_percentage_30d_in_currency),
    });
  }
  // Frische Dexscreener-Coins (nur wenn ein Pool gefunden wurde)
  for (const key in freshByKey) {
    const f = freshByKey[key]; const bp = pairs[key];
    if (!bp) continue;
    build(key, {
      id: null, sym: (bp.baseToken?.symbol || '?').toUpperCase(), name: bp.baseToken?.name || null,
      chain: f.chain, addr: f.addr, priceNum: num(bp.priceUsd),
      mcap: num(bp.marketCap), fdv: num(bp.fdv), circ: null, total: null, vol24: num(bp.volume?.h24),
      d1h: round1(num(bp.priceChange?.h1)), d1pct: round1(num(bp.priceChange?.h24)),
      w1pct: null, m1pct: null,
    });
  }

  coins.sort((a, b) => (b.mcap || 0) - (a.mcap || 0));
  writeFileSync(VOL_HIST, JSON.stringify(volHist));
  writeFileSync(SUP_HIST, JSON.stringify(supHist));
  writeFileSync(LIQ_HIST, JSON.stringify(liqHist));
  writeFileSync(OUT, JSON.stringify(coins));
  console.log('wrote ' + coins.length + ' coins (' + Object.keys(cgByKey).length + ' CG + fresh) to ' + OUT);

  // ---- Alerts -> Telegram ---------------------------------------------------
  const sentMap = load(ALERTS);
  const newAlerts = [];
  for (const c of coins) {
    if (isDist(c))  { const k = 'dist:'  + c.sym; if (!sentMap[k] || now - sentMap[k] > COOLDOWN) { sentMap[k] = now; newAlerts.push({ type: 'dist',  c }); } }
    if (isEarly(c)) { const k = 'early:' + c.sym; if (!sentMap[k] || now - sentMap[k] > COOLDOWN) { sentMap[k] = now; newAlerts.push({ type: 'early', c }); } }
  }
  for (const k in sentMap) if (now - sentMap[k] > 48 * 3600000) delete sentMap[k];
  writeFileSync(ALERTS, JSON.stringify(sentMap));

  const TOKEN = process.env.TELEGRAM_TOKEN, CHAT = process.env.TELEGRAM_CHAT_ID;
  if (TOKEN && CHAT && newAlerts.length) {
    const levSets = await leverageSets();
    const dist  = newAlerts.filter((a) => a.type === 'dist').slice(0, 15);
    const early = newAlerts.filter((a) => a.type === 'early').slice(0, 15);
    const fmtPct = (v) => (v == null ? '?' : (v >= 0 ? '+' : '') + v + '%');
    const nameOf = (c) => c.name ? c.sym + ' (' + c.name + ')' : c.sym;
    const lineFor = ({ c }) => { const lev = leverageOn(c, levSets); return '\u2022 ' + nameOf(c) + '  \u00b7  ' + (lev.length ? 'Hebel: ' + lev.join(', ') : 'kein Hebel-Markt') + '  \u00b7  24h ' + fmtPct(c.d1pct); };
    const lines = [];
    if (dist.length) {
      lines.push('\u26A0 VERTEILUNGSWARNUNG');
      for (const a of dist) lines.push(lineFor(a));
      lines.push('');
    }
    if (early.length) {
      lines.push('\u25B2 FR\u00DCHE BEWEGUNG');
      for (const a of early) lines.push(lineFor(a));
    }
    const text = 'SignalDesk Alerts\n\n' + lines.join('\n');
    try {
      const r = await fetch('https://api.telegram.org/bot' + TOKEN + '/sendMessage', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: CHAT, text, disable_web_page_preview: true }),
      });
      if (!r.ok) throw new Error('Telegram HTTP ' + r.status);
      console.log('Telegram: ' + newAlerts.length + ' Alerts gesendet');
    } catch (e) { console.error('Telegram: ' + e.message + ' (Daten wurden trotzdem geschrieben)'); }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
