// The one conversion function. Prices and FX rates are decimals; every amount that
// leaves this function is an integer (BigInt) in smallest units: yocto/wei/micro for
// assets, minor units (paise, cents) for fiat.
import { ASSETS, CURRENCIES, type AssetKey, type Currency } from './config.ts';

export interface Rates {
  /** USD price of one whole unit of each asset. */
  usd: Record<AssetKey, number>;
  /** Units of local currency per 1 USD. */
  fx: Record<Currency, number>;
  source: 'live' | 'fallback';
  at: number;
}

export type Unit = { asset: AssetKey } | { currency: Currency };

const SCALE = 10n ** 12n;

/** Decimal -> scaled BigInt (12 decimal places). */
function scaled(x: number): bigint {
  if (!Number.isFinite(x) || x <= 0) throw new Error(`bad rate ${x}`);
  return BigInt(Math.round(x * 1e12));
}

/** USD per whole unit, as a fraction num/den, plus the unit's decimals. */
function usdPerUnit(u: Unit, r: Rates): { num: bigint; den: bigint; decimals: number } {
  if ('asset' in u) return { num: scaled(r.usd[u.asset]), den: SCALE, decimals: ASSETS[u.asset].decimals };
  return { num: SCALE, den: scaled(r.fx[u.currency]), decimals: CURRENCIES[u.currency].minor };
}

/**
 * Convert `amount` (smallest units of `from`) into smallest units of `to`.
 * spreadBps: provider spread deducted from the result (80 = 0.8%): "I send X crypto, how much fiat arrives?"
 * grossUpBps: provider spread added on top instead: "the merchant must receive X fiat, how much crypto
 *             does the customer send?" (result / (1 - spread)).
 * round: 'down' (default, for payouts) or 'up' (for amounts a customer must pay).
 */
export function convert(
  amount: bigint,
  from: Unit,
  to: Unit,
  rates: Rates,
  opts: { spreadBps?: number; grossUpBps?: number; round?: 'down' | 'up' } = {},
): bigint {
  if (amount < 0n) throw new Error('negative amount');
  const f = usdPerUnit(from, rates);
  const t = usdPerUnit(to, rates);
  const bps = BigInt(opts.spreadBps ?? 0);
  const up = BigInt(opts.grossUpBps ?? 0);
  const num = amount * f.num * t.den * 10n ** BigInt(t.decimals) * (10000n - bps) * 10000n;
  const den = f.den * t.num * 10n ** BigInt(f.decimals) * 10000n * (10000n - up);
  const q = num / den;
  return opts.round === 'up' && q * den !== num ? q + 1n : q;
}

// ---- display helpers (strings only, never used for amounts) ----

export function formatUnits(amount: bigint, decimals: number, maxFrac = 6): string {
  const neg = amount < 0n;
  const a = neg ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const whole = a / base;
  let frac = (a % base).toString().padStart(decimals, '0').slice(0, maxFrac).replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}

export const fmtAsset = (amount: bigint, asset: AssetKey, maxFrac = 6) =>
  `${formatUnits(amount, ASSETS[asset].decimals, maxFrac)} ${ASSETS[asset].symbol}`;

export function fmtFiat(minor: bigint, currency: Currency): string {
  const d = CURRENCIES[currency].minor;
  const [w, f = ""] = formatUnits(minor, d, d).split(".");
  return `${w}${d ? "." + f.padEnd(d, "0") : ""} ${currency}`;
}

/** Parse a user-typed decimal ("420", "4.50") into minor units, exactly. */
export function parseUnits(text: string, decimals: number): bigint {
  const m = /^\s*(\d+)(?:\.(\d*))?\s*$/.exec(text);
  if (!m) throw new Error(`not a positive decimal: ${text}`);
  const frac = (m[2] ?? '').padEnd(decimals, '0');
  if (frac.length > decimals) throw new Error(`too many decimals: ${text}`);
  return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(frac || '0');
}
