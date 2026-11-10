// SIMULATED offramp providers. Each quotes a local-currency payout for a crypto amount,
// and on /payout pays the merchant's (simulated) bank after its ETA. Before paying, a
// provider checks on-chain that the invoice is escrowed and assigned to it, because it
// only receives the crypto after the merchant confirms the bank credit.
import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { ASSETS, PROVIDERS, timings, type AssetKey, type Currency, type ProviderName } from './config.ts';
import { convert } from './pricing.ts';
import { getRates } from './rates.ts';
import type { Quote } from './auction.ts';
import type { Chain } from './chain/types.ts';
import type { MockBank } from './bank.ts';

export class Provider {
  private quotes = new Map<string, Quote>();
  private paidQuotes = new Set<string>();
  constructor(
    readonly name: ProviderName,
    readonly accountId: string,
    private chain: Chain,
    private bank: MockBank,
  ) {}

  get cfg() { return PROVIDERS[this.name]; }
  get failing() { return process.env.FAIL_PROVIDER === this.name; }

  /**
   * Two ways to ask:
   *  - { fiat }: "the merchant must receive exactly this much fiat; how much crypto do you need?"
   *    (used at checkout, before the customer pays; valid as long as the invoice)
   *  - { amount }: "you get exactly this much crypto; how much fiat do you pay?" (used after payment)
   * fiat_amount = amount x usd_price(asset) x fx(currency) x (1 - spread), in minor units.
   */
  async quote(asset: AssetKey, req: { amount: bigint } | { fiat: bigint }, currency: Currency): Promise<Quote | { error: string; status: number }> {
    if (!this.cfg.assets.includes(asset)) return { status: 422, error: `${this.name} does not accept ${ASSETS[asset].symbol}` };
    const rates = await getRates();
    const spread = this.cfg.spreadBps;
    let amount: bigint, fiat: bigint, kind: Quote['kind'], validMs: number;
    if ('fiat' in req) {
      if (req.fiat <= 0n) return { status: 400, error: 'fiat_amount must be positive' };
      kind = 'fiat_target';
      fiat = req.fiat;
      amount = convert(fiat, { currency }, { asset }, rates, { grossUpBps: spread, round: 'up' });
      // rounding guard: the crypto we ask for must really cover the promised fiat
      while (convert(amount, { asset }, { currency }, rates, { spreadBps: spread }) < fiat) amount += 1n;
      validMs = (timings().invoiceMinutes + 1) * 60_000;
    } else {
      if (req.amount <= 0n) return { status: 400, error: 'amount must be positive' };
      kind = 'crypto_in';
      amount = req.amount;
      fiat = convert(amount, { asset }, { currency }, rates, { spreadBps: spread });
      validMs = timings().quoteValidityMs;
    }
    const q: Quote = {
      quote_id: `${this.name}-${randomBytes(4).toString('hex')}`,
      kind, provider: this.name,
      asset, amount: amount.toString(), currency,
      rate: rates.usd[asset] * rates.fx[currency] * (1 - spread / 10000),
      fiat_amount: fiat.toString(),
      spread_bps: spread,
      eta_seconds: this.cfg.etaSeconds,
      valid_until: Date.now() + validMs,
    };
    this.prune();
    this.quotes.set(q.quote_id, q);
    return q;
  }

  /** Forget quotes that expired long ago (keep ones that may still be paid out). */
  private prune() {
    const cutoff = Date.now() - 60 * 60_000;
    for (const [id, q] of this.quotes) if (q.valid_until < cutoff) this.quotes.delete(id);
  }

  async payout(quoteId: string, invoiceId: number, bankAccount: string): Promise<{ status: number; body: unknown }> {
    const q = this.quotes.get(quoteId);
    if (!q) return { status: 404, body: { error: 'unknown quote' } };
    if (this.paidQuotes.has(quoteId)) return { status: 409, body: { error: 'already paid out' } };
    let inv;
    try { inv = await this.chain.getInvoice(invoiceId); } catch (e: any) { return { status: 503, body: { error: `cannot verify escrow: ${e.message}` } }; }
    const ok = inv && inv.status === 'Assigned' && inv.provider === this.accountId && inv.quote_id === quoteId
      && inv.amount === q.amount && inv.fiat_amount === q.fiat_amount;
    if (!ok) return { status: 409, body: { error: 'invoice is not escrowed and assigned to this provider for this quote' } };
    this.paidQuotes.add(quoteId);
    await new Promise((r) => setTimeout(r, this.cfg.etaSeconds * 1000 * timings().scale));
    if (this.failing) {
      // FAIL_PROVIDER: accepts the job and never pays.
      return { status: 202, body: { accepted: true, provider: this.name, note: 'accepted (will never pay: FAIL_PROVIDER)' } };
    }
    const txn = await this.bank.credit({ account: bankAccount, amount: q.fiat_amount, currency: q.currency, ref: quoteId, from: this.name });
    return { status: 200, body: { payout_ref: txn.txn_id, provider: this.name, quote_id: quoteId } };
  }

  router() {
    const r = Router();
    r.get('/quote', async (req, res) => {
      try {
        const asset = String(req.query.asset) as AssetKey;
        const currency = String(req.query.currency) as Currency;
        if (!(asset in ASSETS)) return void res.status(422).json({ error: 'unknown asset' });
        const ask = req.query.fiat_amount !== undefined ? { fiat: BigInt(String(req.query.fiat_amount)) } : { amount: BigInt(String(req.query.amount)) };
        const q = await this.quote(asset, ask, currency);
        'error' in q ? res.status(q.status).json({ error: q.error }) : res.json(q);
      } catch (e: any) { res.status(400).json({ error: e.message }); }
    });
    r.post('/payout', async (req, res) => {
      const { quote_id, invoice_id, merchant_bank_account } = req.body ?? {};
      const out = await this.payout(String(quote_id), Number(invoice_id), String(merchant_bank_account));
      res.status(out.status).json(out.body);
    });
    return r;
  }
}
