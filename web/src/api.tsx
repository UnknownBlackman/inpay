import { useEffect, useRef, useState } from 'react';

export async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j as T;
}

/** Poll a GET endpoint every `ms`. Returns [data, error, refresh]. */
export function usePoll<T>(path: string | null, ms = 1500): [T | undefined, string | undefined, () => void] {
  const [data, setData] = useState<T>();
  const [err, setErr] = useState<string>();
  const tick = useRef(0);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!path) return;
    let alive = true;
    const run = () => api<T>(path).then((d) => { if (alive) { setData(d); setErr(undefined); } }).catch((e) => alive && setErr(e.message));
    run();
    const t = setInterval(run, ms);
    return () => { alive = false; clearInterval(t); };
  }, [path, ms, n]);
  return [data, err, () => { tick.current++; setN(tick.current); }];
}

let cfgCache: any;
export function useConfig(): any {
  const [cfg, setCfg] = useState<any>(cfgCache);
  useEffect(() => { api('/api/config').then((c) => { cfgCache = c; setCfg(c); }).catch(() => {}); }, []);
  return cfg;
}

export const SYMBOL: Record<string, string> = { near: 'NEAR', eth: 'ETH', usdc: 'USDC' };
export const CUR_SYMBOL: Record<string, string> = { INR: '₹', EUR: '€', KES: 'KSh ' };

export function fmtMinor(minor: string | bigint | null | undefined, currency: string, decimals = 2) {
  if (minor == null) return '-';
  const v = BigInt(minor);
  const base = 10n ** BigInt(decimals);
  const whole = (v / base).toLocaleString('en-US');
  const frac = (v % base).toString().padStart(decimals, '0');
  return `${CUR_SYMBOL[currency] ?? ''}${whole}.${frac} ${currency}`;
}

export function fmtUnits(amount: string | bigint, decimals: number, maxFrac = 6) {
  const v = BigInt(amount);
  const base = 10n ** BigInt(decimals);
  const frac = (v % base).toString().padStart(decimals, '0').slice(0, maxFrac).replace(/0+$/, '');
  return `${v / base}${frac ? '.' + frac : ''}`;
}

export function assetKeyOf(asset: string, cfg: any): 'near' | 'eth' | 'usdc' {
  if (asset === 'near') return 'near';
  return cfg?.tokens?.eth === asset ? 'eth' : 'usdc';
}

export function fmtAssetAmount(amount: string, asset: string, cfg: any) {
  const k = assetKeyOf(asset, cfg);
  const d = { near: 24, eth: 18, usdc: 6 }[k];
  return `${fmtUnits(amount, d)} ${SYMBOL[k]}`;
}

export function TxLink({ url, label = 'tx' }: { url?: string | null; label?: string }) {
  if (!url) return null;
  return <a className="tx" href={url} target="_blank" rel="noreferrer">{label} ↗</a>;
}

// ---- shared bits for the themed pages ----
export const MERCHANT_EMOJI: Record<string, string> = { 'bengaluru-cafe': '☕', 'berlin-bikes': '🚲', 'nairobi-tailor': '🧵' };
export const MERCHANT_IDS = ['bengaluru-cafe', 'berlin-bikes', 'nairobi-tailor'];

/** Plain words for the invoice states, as the merchant would say them. */
export const STATUS_LABEL: Record<string, string> = {
  Open: 'Waiting', Underpaid: 'Part paid', Paid: 'Paid', Assigned: 'Paying out', Settled: 'In your bank', Refunded: 'Refunded',
};

export function StatusPill({ status }: { status: string }) {
  return <span className={`pill s-${status}`}><i />{STATUS_LABEL[status] ?? status}</span>;
}

export function CoinIcon({ k }: { k: 'near' | 'eth' | 'usdc' }) {
  return <span className={`coin c-${k}`} aria-hidden="true">{({ near: 'N', eth: 'E', usdc: 'U' })[k]}</span>;
}

export const DECIMALS = { near: 24, eth: 18, usdc: 6 } as const;

/** Animates a number to its new value (stays put under reduced motion). */
export function useCountUp(target: number, ms = 900): number {
  const [v, setV] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || from.current === target) { setV(target); from.current = target; return; }
    const start = performance.now(), a = from.current;
    let raf = 0;
    const step = (t: number) => {
      const p = Math.min(1, (t - start) / ms), e = 1 - Math.pow(1 - p, 3);
      setV(a + (target - a) * e);
      if (p < 1) raf = requestAnimationFrame(step); else from.current = target;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return v;
}

export function Logo({ animated = false }: { animated?: boolean }) {
  return <a className="logo" href="/" aria-label="INPay home"><img src={animated ? '/brand/logo.svg' : '/brand/logo-still.svg'} alt="INPay" /></a>;
}
