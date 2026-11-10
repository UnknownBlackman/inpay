// Static configuration: assets, currencies, providers, merchants, timings.
export type AssetKey = 'near' | 'eth' | 'usdc';
export type Currency = 'INR' | 'EUR' | 'KES';

export const ASSETS: Record<AssetKey, { symbol: string; decimals: number; coingecko: string; label: string }> = {
  near: { symbol: 'NEAR', decimals: 24, coingecko: 'near', label: 'NEAR (native testnet NEAR)' },
  eth: { symbol: 'ETH', decimals: 18, coingecko: 'ethereum', label: 'ETH (wETH test token, testnet stand-in)' },
  usdc: { symbol: 'USDC', decimals: 6, coingecko: 'usd-coin', label: 'USDC (test token, testnet stand-in)' },
};
export const ASSET_KEYS = Object.keys(ASSETS) as AssetKey[];

export const CURRENCIES: Record<Currency, { minor: number; symbol: string }> = {
  INR: { minor: 2, symbol: '₹' },
  EUR: { minor: 2, symbol: '€' },
  KES: { minor: 2, symbol: 'KSh' },
};

export type ProviderName = 'swiftcash' | 'payrail' | 'quickfx';
export const PROVIDERS: Record<ProviderName, { spreadBps: number; etaSeconds: number; assets: AssetKey[] }> = {
  swiftcash: { spreadBps: 80, etaSeconds: 5, assets: ['near', 'usdc'] },
  payrail: { spreadBps: 150, etaSeconds: 3, assets: ['near', 'eth', 'usdc'] },
  quickfx: { spreadBps: 250, etaSeconds: 2, assets: ['near', 'eth'] },
};
export const PROVIDER_NAMES = Object.keys(PROVIDERS) as ProviderName[];

export type MerchantName = 'bengaluru-cafe' | 'berlin-bikes' | 'nairobi-tailor';
export const MERCHANTS: Record<MerchantName, { currency: Currency; display: string; bankAccount: string }> = {
  'bengaluru-cafe': { currency: 'INR', display: 'Bengaluru Cafe', bankAccount: 'IN-bengaluru-cafe' },
  'berlin-bikes': { currency: 'EUR', display: 'Berlin Bikes', bankAccount: 'DE-berlin-bikes' },
  'nairobi-tailor': { currency: 'KES', display: 'Nairobi Tailor', bankAccount: 'KE-nairobi-tailor' },
};
export const MERCHANT_NAMES = Object.keys(MERCHANTS) as MerchantName[];

/** Durations in ms, multiplied by TIME_SCALE (the offline sim runs ~20x faster). */
export function timings() {
  const scale = Number(process.env.TIME_SCALE ?? 1);
  const payoutTimeout = Number(process.env.DEMO_TIMEOUT_SECONDS ?? 60);
  return {
    scale,
    loopMs: 3000 * scale,
    quoteTimeoutMs: Math.max(1000, 3000 * scale), // never below 1s, even in the sped-up sim
    quoteValidityMs: 60_000 * scale,
    payoutTimeoutMs: payoutTimeout * 1000 * scale,
    invoiceMinutes: 10,
  };
}

export const EXPLORER = 'https://testnet.nearblocks.io';
