// Merchant agent: every 3s it looks at the merchant's invoices on-chain and acts.
//   Paid       -> collect quotes in parallel, pick the best, assign_provider, request payout
//   Assigned   -> if no bank credit within the timeout: mark provider failed, reassign to next best
//   Underpaid  -> tell the customer what is missing; refund at the deadline
//   Bank webhook (credit matches the assigned quote) -> confirm_payout, releasing escrow to the provider
// All decisions are deterministic code. The optional LLM only rewords log text.
import { ASSETS, PROVIDER_NAMES, timings, type AssetKey, type Currency, type MerchantName, type ProviderName } from './config.ts';
import { advantagePct, pickQuote, rankQuotes, type Quote } from './auction.ts';
import { fmtAsset, fmtFiat } from './pricing.ts';
import type { Chain, Invoice } from './chain/types.ts';
import type { EventLog } from './events.ts';

interface InvoiceState {
  quotes: Quote[];
  failed: string[];
  current?: Quote;
  assignedAt?: number;
  underpaidNotice?: string; // `paid` value we last told the customer about
  paidLogged?: boolean;
  /** Quote chosen at checkout, before the customer paid. The invoice amount was set from it. */
  locked?: Quote;
  settled?: boolean;
}

export interface AgentDeps {
  chain: Chain;
  merchant: MerchantName;
  accountId: string;
  currency: Currency;
  bankAccount: string;
  providerAccounts: Record<ProviderName, string>;
  baseUrl: () => string;
  log: EventLog;
  /** customer-facing messages per invoice id (shown on checkout) */
  messages: Map<number, string>;
}

export class MerchantAgent {
  private state = new Map<number, InvoiceState>();
  private locks = new Map<number, Promise<unknown>>();
  private timer?: NodeJS.Timeout;
  private ticking = false;

  constructor(private d: AgentDeps) {}

  start() {
    this.timer = setInterval(() => this.tick().catch((e) => console.error(`[agent ${this.d.merchant}]`, e.message)), timings().loopMs);
  }
  stop() { clearInterval(this.timer); }

  quotesFor(id: number) { return this.state.get(id); }

  private st(id: number): InvoiceState {
    let s = this.state.get(id);
    if (!s) this.state.set(id, (s = { quotes: [], failed: [] }));
    return s;
  }

  /** Serialize work per invoice so the loop and the bank webhook never race. */
  private lock<T>(id: number, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(id, next.catch(() => {}));
    return next;
  }

  private assetKey(inv: Invoice): AssetKey {
    return (['near', 'eth', 'usdc'] as AssetKey[]).find((k) => this.d.chain.assetId(k) === inv.asset)!;
  }

  private log(kind: string, text: string, extra: { invoice_id?: number; tx?: string; data?: unknown } = {}) {
    this.d.log.add({ merchant: this.d.merchant, kind, text, ...extra, tx_url: extra.tx ? this.d.chain.txUrl(extra.tx) : undefined });
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const invoices = (await this.d.chain.getInvoices(this.d.accountId))
        .filter((i) => i.status === 'Paid' || i.status === 'Assigned' || i.status === 'Underpaid');
      await Promise.all(invoices.map((inv) => this.lock(inv.id, () => this.handle(inv.id)).catch((e) =>
        this.log('error', `invoice #${inv.id}: ${e.message}`, { invoice_id: inv.id }))));
    } finally {
      this.ticking = false;
    }
  }

  private async handle(id: number) {
    const inv = await this.d.chain.getInvoice(id); // fresh read inside the lock
    if (!inv) return;
    const s = this.st(id);
    switch (inv.status) {
      case 'Paid': return this.onPaid(inv, s);
      case 'Assigned': return this.onAssigned(inv, s);
      case 'Underpaid': return this.onUnderpaid(inv, s);
      default: return;
    }
  }

  // ---------------------------------------------------------------- quotes

  /** Ask every provider in parallel. { fiat }: price-first quotes for checkout; { amount }: after payment. */
  async collectQuotes(asset: AssetKey, ask: { amount: bigint } | { fiat: bigint }): Promise<Quote[]> {
    const t = timings();
    const param = 'fiat' in ask ? `fiat_amount=${ask.fiat}` : `amount=${ask.amount}`;
    const res = await Promise.all(PROVIDER_NAMES.map(async (p) => {
      try {
        const url = `${this.d.baseUrl()}/providers/${p}/quote?asset=${asset}&${param}&currency=${this.d.currency}`;
        const r = await fetch(url, { signal: AbortSignal.timeout(t.quoteTimeoutMs) });
        if (r.status === 422) return null; // provider doesn't support this asset
        if (!r.ok) return null;
        return (await r.json()) as Quote;
      } catch { return null; } // timeout or error: skip
    }));
    return res.filter((q): q is Quote => q !== null);
  }

  private describeQuotes(quotes: Quote[]) {
    return rankQuotes(quotes).map((q) => q.kind === 'fiat_target'
      ? `${q.provider} needs ${fmtAsset(BigInt(q.amount), q.asset as AssetKey)}`
      : `${q.provider} ${fmtFiat(BigInt(q.fiat_amount), this.d.currency)}`).join(', ');
  }

  /**
   * Checkout, before the customer pays: every provider quotes how much crypto it needs to pay
   * the merchant the full price. Returns all quotes and the best one (least crypto for the customer).
   */
  async checkoutQuotes(asset: AssetKey, fiat: bigint): Promise<{ quotes: Quote[]; best?: Quote }> {
    const quotes = await this.collectQuotes(asset, { fiat });
    return { quotes, best: pickQuote(quotes, [], Date.now()) };
  }

  /** Bind the checkout auction to the invoice that was created from its winner, and log it. */
  lockQuote(invoiceId: number, quotes: Quote[], best: Quote) {
    const s = this.st(invoiceId);
    s.quotes = quotes;
    s.locked = best;
    const asset = best.asset as AssetKey;
    const skipped = PROVIDER_NAMES.filter((p) => !quotes.some((q) => q.provider === p));
    this.log('quotes',
      `checkout quotes to pay ${fmtFiat(BigInt(best.fiat_amount), this.d.currency)} for invoice #${invoiceId}: ${this.describeQuotes(quotes)}` +
      (skipped.length ? ` (${skipped.join(', ')} skipped: no ${ASSETS[asset].symbol} support)` : '') +
      `; ${best.provider} locked before payment` +
      (quotes.length > 1 ? `, customer pays ${advantagePct(quotes)}% less than with the worst quote` : ''),
      { invoice_id: invoiceId, data: { quotes: rankQuotes(quotes), winner: best.quote_id } });
  }

  // ---------------------------------------------------------------- states

  private async onPaid(inv: Invoice, s: InvoiceState) {
    const asset = this.assetKey(inv);
    const amount = BigInt(inv.amount);
    const locked = s.locked && s.locked.amount === inv.amount && s.locked.valid_until > Date.now() ? s.locked : undefined;
    if (!s.paidLogged) {
      s.paidLogged = true;
      this.log('paid', `payment of ${fmtAsset(amount, asset)} received for invoice #${inv.id} from ${inv.customer}; ` +
        (locked ? `assigning the quote locked at checkout (${locked.provider})` : `no valid locked quote, asking ${PROVIDER_NAMES.length} providers`), { invoice_id: inv.id });
    }
    if (locked) return this.assign(inv, s, locked, false);
    // Fallback (e.g. agent restarted and lost the checkout quote): auction the fixed crypto amount.
    s.quotes = await this.collectQuotes(asset, { amount });
    const skipped = PROVIDER_NAMES.filter((p) => !s.quotes.some((q) => q.provider === p));
    const best = pickQuote(s.quotes, s.failed, Date.now());
    if (!best) {
      this.log('no_quotes', `no provider quoted ${ASSETS[asset].symbol} -> ${this.d.currency} for invoice #${inv.id}; retrying`, { invoice_id: inv.id });
      return;
    }
    const adv = advantagePct(s.quotes);
    this.log('quotes',
      `${s.quotes.length} quote${s.quotes.length === 1 ? '' : 's'} for invoice #${inv.id}: ${this.describeQuotes(s.quotes)}` +
      (skipped.length ? ` (${skipped.join(', ')} skipped: no ${ASSETS[asset].symbol} support)` : '') +
      `; ${best.provider} wins` + (s.quotes.length > 1 ? `, merchant gets ${adv}% more than the worst quote` : ''),
      { invoice_id: inv.id, data: { quotes: rankQuotes(s.quotes), winner: best.quote_id } });
    await this.assign(inv, s, best, false);
  }

  private async assign(inv: Invoice, s: InvoiceState, q: Quote, reassign: boolean) {
    const tx = await this.d.chain.assignProvider(this.d.accountId, inv.id, this.d.providerAccounts[q.provider as ProviderName],
      BigInt(q.fiat_amount), this.d.currency, q.quote_id, reassign);
    s.current = q;
    s.assignedAt = Date.now();
    this.log(reassign ? 'reassigned' : 'assigned',
      `${reassign ? 'reassigned' : 'assigned'} invoice #${inv.id} to ${q.provider} on-chain for ${fmtFiat(BigInt(q.fiat_amount), this.d.currency)}; requesting payout`,
      { invoice_id: inv.id, tx: tx.hash });
    this.requestPayout(inv.id, q);
  }

  /** Not awaited: the provider responds after its ETA; the bank webhook is the real signal. */
  private requestPayout(invoiceId: number, q: Quote, attempt = 1) {
    fetch(`${this.d.baseUrl()}/providers/${q.provider}/payout`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quote_id: q.quote_id, invoice_id: invoiceId, merchant_bank_account: this.d.bankAccount }),
    }).then(async (r) => {
      const body: any = await r.json().catch(() => ({}));
      if (r.status >= 500 && attempt < 3) { // provider hiccup (e.g. RPC rate limit): ask again
        setTimeout(() => this.requestPayout(invoiceId, q, attempt + 1), 1000 * timings().scale);
        return;
      }
      if (r.status >= 300 || body.accepted) {
        this.log('payout_response', `${q.provider} answered payout request for invoice #${invoiceId}: ${body.error ?? body.note ?? r.status}`, { invoice_id: invoiceId });
      }
    }).catch((e) => this.log('payout_response', `payout request to ${q.provider} failed: ${e.message}`, { invoice_id: invoiceId }));
  }

  private async onAssigned(inv: Invoice, s: InvoiceState) {
    if (!s.current) {
      // Agent restarted: adopt the on-chain assignment and start the timeout now.
      s.current = { quote_id: inv.quote_id!, provider: PROVIDER_NAMES.find((p) => this.d.providerAccounts[p] === inv.provider) ?? inv.provider!,
        asset: this.assetKey(inv), amount: inv.amount, currency: inv.fiat_currency!, rate: 0, fiat_amount: inv.fiat_amount!,
        kind: 'crypto_in', spread_bps: 0, eta_seconds: 0, valid_until: 0 };
      s.assignedAt = Date.now();
      return;
    }
    const t = timings();
    if (Date.now() - s.assignedAt! < t.payoutTimeoutMs) return;
    const failed = s.current.provider;
    s.failed.push(failed);
    // The escrowed crypto amount is fixed now, so only quotes for exactly that amount can be used;
    // checkout quotes from other providers were for different amounts. Re-quote if needed.
    let next = pickQuote(s.quotes.filter((q) => q.kind === 'crypto_in' && q.amount === inv.amount), s.failed, Date.now());
    if (!next) {
      s.quotes = await this.collectQuotes(this.assetKey(inv), { amount: BigInt(inv.amount) });
      next = pickQuote(s.quotes, s.failed, Date.now());
    }
    const price = s.locked ? BigInt(s.locked.fiat_amount) : undefined;
    const shortfall = next && price !== undefined && BigInt(next.fiat_amount) < price
      ? ` (${fmtFiat(price - BigInt(next.fiat_amount), this.d.currency)} less than the locked quote: the fallback provider has a wider spread)` : '';
    this.log('timeout', `no bank credit from ${failed} within ${Math.round(t.payoutTimeoutMs / 1000 / t.scale)}s for invoice #${inv.id}; marking ${failed} failed` +
      (next ? `, next best is ${next.provider} paying ${fmtFiat(BigInt(next.fiat_amount), this.d.currency)}${shortfall}` : '; no other provider available, will retry'), { invoice_id: inv.id });
    if (!next) { s.assignedAt = Date.now(); s.failed = []; return; }
    await this.assign(inv, s, next, true);
  }

  private async onUnderpaid(inv: Invoice, s: InvoiceState) {
    const asset = this.assetKey(inv);
    if (Date.now() > inv.deadline) {
      const tx = await this.d.chain.refund(this.d.accountId, inv.id);
      const msg = `Invoice #${inv.id} expired while underpaid; ${fmtAsset(BigInt(inv.paid), asset)} refunded to ${inv.customer}.`;
      this.d.messages.set(inv.id, msg);
      this.log('refunded', msg, { invoice_id: inv.id, tx: tx.hash });
      return;
    }
    if (s.underpaidNotice === inv.paid) return;
    s.underpaidNotice = inv.paid;
    const missing = BigInt(inv.amount) - BigInt(inv.paid);
    const mins = Math.max(0, Math.round((inv.deadline - Date.now()) / 60000));
    const msg = `We received ${fmtAsset(BigInt(inv.paid), asset)} of ${fmtAsset(BigInt(inv.amount), asset)}. ` +
      `Please send the missing ${fmtAsset(missing, asset, 8)} within ${mins} min, or the payment will be refunded.`;
    this.d.messages.set(inv.id, msg);
    this.log('underpaid', `invoice #${inv.id} underpaid by ${fmtAsset(missing, asset, 8)}; told the customer: "${msg}"`, { invoice_id: inv.id });
  }

  // ---------------------------------------------------------------- bank webhook

  /** Returns true if the credit settled one of this merchant's invoices. */
  async onBankCredit(c: { account: string; amount: string; currency: string; ref: string; txn_id: string; from: string }): Promise<boolean> {
    if (c.account !== this.d.bankAccount) return false;
    const entry = [...this.state.entries()].find(([, s]) => s.quotes.some((q) => q.quote_id === c.ref) || s.current?.quote_id === c.ref);
    if (!entry) {
      this.log('bank_credit', `bank credit ${fmtFiat(BigInt(c.amount), c.currency as Currency)} with unknown ref ${c.ref}; ignored`);
      return false;
    }
    const [id, s] = entry;
    return this.lock(id, async () => {
      const q = s.current;
      if (!q || q.quote_id !== c.ref) {
        this.log('bank_credit', `late bank credit from ${c.from} (${fmtFiat(BigInt(c.amount), c.currency as Currency)}) for invoice #${id} after reassignment; needs manual reconciliation`, { invoice_id: id });
        return false;
      }
      if (c.amount !== q.fiat_amount || c.currency !== q.currency) {
        this.log('bank_mismatch', `bank credit ${c.amount} ${c.currency} does not match quote ${q.fiat_amount} ${q.currency} for invoice #${id}; not releasing`, { invoice_id: id });
        return false;
      }
      const inv = await this.d.chain.getInvoice(id);
      if (inv?.status !== 'Assigned') return false;
      const secs = ((Date.now() - s.assignedAt!) / 1000 / timings().scale).toFixed(1);
      this.log('bank_credit', `bank credited ${fmtFiat(BigInt(c.amount), this.d.currency)} from ${c.from} (ref ${c.ref}, ${secs}s after assignment); matches quote`, { invoice_id: id });
      const tx = await this.d.chain.confirmPayout(this.d.accountId, id, c.txn_id);
      s.settled = true;
      this.log('settled', `confirm_payout sent: ${fmtAsset(BigInt(inv.amount), this.assetKey(inv))} released from escrow to ${q.provider}; invoice #${id} settled`, { invoice_id: id, tx: tx.hash });
      return true;
    });
  }
}
