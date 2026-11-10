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
