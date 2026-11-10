// Live crypto prices (CoinGecko) and FX (open.er-api.com).
//
// - Each source is fetched on its own (10 s timeout; open.er-api.com can take ~6 s).
// - Rates are refreshed every 60 s in the background; callers get the current value right away,
//   so a slow API never blocks a checkout.
// - The last good live values are saved to .state/rates.last.json and preferred over the fixed
//   rates.fallback.json, so a hiccup never flips pricing to stale fixed numbers.
// - OFFLINE=1 (npm run sim, unit tests) always uses rates.fallback.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ASSETS, ASSET_KEYS, CURRENCIES, type AssetKey, type Currency } from './config.ts';
import type { Rates } from './pricing.ts';

const ROOT = path.join(import.meta.dirname, '..');
const FALLBACK_FILE = path.join(ROOT, 'rates.fallback.json');
const LAST_FILE = path.join(ROOT, '.state', 'rates.last.json');
const REFRESH_MS = 60_000;

export function fallbackRates(): Rates {
  const j = JSON.parse(readFileSync(FALLBACK_FILE, 'utf8'));
  return { usd: j.usd, fx: j.fx, source: 'fallback', at: Date.now() };
}

async function getJson(url: string, ms = 10_000): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${new URL(url).host} -> HTTP ${res.status}`);
  return res.json();
}

async function fetchPrices(): Promise<Rates['usd']> {
  const ids = ASSET_KEYS.map((k) => ASSETS[k].coingecko).join(',');
  const cg = await getJson(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`);
  const usd = {} as Record<AssetKey, number>;
  for (const k of ASSET_KEYS) {
    const p = cg?.[ASSETS[k].coingecko]?.usd;
    if (typeof p !== 'number' || p <= 0) throw new Error(`no price for ${k}`);
    usd[k] = p;
  }
  return usd;
}

async function fetchFx(): Promise<Rates['fx']> {
  const j = await getJson('https://open.er-api.com/v6/latest/USD');
  const fx = {} as Record<Currency, number>;
  for (const c of Object.keys(CURRENCIES) as Currency[]) {
    const v = j?.rates?.[c];
    if (typeof v !== 'number' || v <= 0) throw new Error(`no fx for ${c}`);
    fx[c] = v;
  }
  return fx;
}

interface Part<T> { value: T; live: boolean; at: number }
let prices: Part<Rates['usd']> | undefined;
let fx: Part<Rates['fx']> | undefined;
let refreshing: Promise<void> | undefined;
let lastAttempt = 0;

function loadInitial() {
  if (prices && fx) return;
  const fb = fallbackRates();
  let last: any;
  try { if (existsSync(LAST_FILE)) last = JSON.parse(readFileSync(LAST_FILE, 'utf8')); } catch { /* ignore */ }
  const fresh = (t?: number) => t !== undefined && Date.now() - t < 24 * 3600_000;
  prices = last?.usd && fresh(last.usd_at) ? { value: last.usd, live: true, at: last.usd_at } : { value: fb.usd, live: false, at: 0 };
  fx = last?.fx && fresh(last.fx_at) ? { value: last.fx, live: true, at: last.fx_at } : { value: fb.fx, live: false, at: 0 };
}

function persist() {
  if (!prices?.live && !fx?.live) return;
  try {
    mkdirSync(path.dirname(LAST_FILE), { recursive: true });
    writeFileSync(LAST_FILE, JSON.stringify({ usd: prices?.live ? prices.value : undefined, usd_at: prices?.live ? prices.at : undefined,
      fx: fx?.live ? fx.value : undefined, fx_at: fx?.live ? fx.at : undefined }, null, 2));
  } catch { /* best effort */ }
}

function refresh(): Promise<void> {
  if (refreshing) return refreshing;
  lastAttempt = Date.now();
  refreshing = (async () => {
    const [p, f] = await Promise.allSettled([fetchPrices(), fetchFx()]);
    if (p.status === 'fulfilled') prices = { value: p.value, live: true, at: Date.now() };
    else console.warn(`[rates] CoinGecko unavailable (${(p.reason as Error).message}); keeping ${prices?.live ? 'last live' : 'fallback'} prices`);
    if (f.status === 'fulfilled') fx = { value: f.value, live: true, at: Date.now() };
    else console.warn(`[rates] open.er-api.com unavailable (${(f.reason as Error).message}); keeping ${fx?.live ? 'last live' : 'fallback'} FX`);
    persist();
  })().finally(() => { refreshing = undefined; });
  return refreshing;
}

function current(): Rates {
  const live = prices!.live && fx!.live;
  return { usd: prices!.value, fx: fx!.value, source: live ? 'live' : 'fallback', at: Math.min(prices!.at, fx!.at) || Date.now() };
}

export async function getRates(): Promise<Rates> {
  if (process.env.OFFLINE === '1') return fallbackRates();
  const first = !prices;
  loadInitial();
  const stale = Date.now() - Math.min(prices!.at, fx!.at) > REFRESH_MS;
  if (stale && Date.now() - lastAttempt > 15_000) {
    const r = refresh();
    if (first) await r; // first call waits once for live data; later calls never block
  }
  return current();
}
