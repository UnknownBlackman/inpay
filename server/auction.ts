// Pure quote ranking.
//
// Two kinds of quote:
//  - 'fiat_target' (checkout, before the customer pays): every provider promises the merchant's
//    full price; the provider needing the LEAST crypto wins, so the customer pays the least.
//  - 'crypto_in' (after payment, e.g. failover to another provider): the crypto amount is fixed;
//    the provider paying the merchant the MOST fiat wins.
// Ties go to the faster provider, then alphabetical provider name.
export interface Quote {
  quote_id: string;
  kind: 'fiat_target' | 'crypto_in';
  provider: string;
  asset: string;
  amount: string; // smallest units of the asset the provider receives
  currency: string;
  rate: number; // fiat per whole asset unit after spread, for display only
  fiat_amount: string; // minor units the provider pays the merchant
  spread_bps: number;
  eta_seconds: number;
  valid_until: number; // ms since epoch
}

const cmpBig = (a: bigint, b: bigint) => (a === b ? 0 : a < b ? -1 : 1);

export function rankQuotes(quotes: Quote[]): Quote[] {
  return [...quotes].sort((a, b) => {
    const primary = a.kind === 'fiat_target' && b.kind === 'fiat_target'
      ? cmpBig(BigInt(a.amount), BigInt(b.amount)) // less crypto from the customer is better
      : cmpBig(BigInt(b.fiat_amount), BigInt(a.fiat_amount)); // more fiat to the merchant is better
    if (primary !== 0) return primary;
    if (a.eta_seconds !== b.eta_seconds) return a.eta_seconds - b.eta_seconds;
    return a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0;
  });
}

/** Best quote whose provider hasn't failed this invoice and which is still valid. */
export function pickQuote(quotes: Quote[], failed: Iterable<string>, now: number): Quote | undefined {
  const bad = new Set(failed);
  return rankQuotes(quotes).find((q) => !bad.has(q.provider) && q.valid_until > now);
}

/** How much better the winner is than the worst quote, in percent (one decimal):
 *  fiat_target: how much less crypto the customer sends; crypto_in: how much more fiat the merchant gets. */
export function advantagePct(quotes: Quote[]): number {
  if (quotes.length < 2) return 0;
  const r = rankQuotes(quotes);
  const best = r[0], worst = r[r.length - 1];
  const [b, w] = best.kind === 'fiat_target'
    ? [BigInt(worst.amount), BigInt(best.amount)]
    : [BigInt(best.fiat_amount), BigInt(worst.fiat_amount)];
  if (w === 0n) return 0;
  return Number(((b - w) * 1000n) / w) / 10;
}
