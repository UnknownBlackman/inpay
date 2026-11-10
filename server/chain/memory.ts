// In-memory stand-in for the inpay contract, mirroring its rules. Used by `npm run sim`
// and agent unit tests so they run with no network and no keys.
import { randomBytes } from 'node:crypto';
import type { Chain, Invoice, TxResult } from './types.ts';

const TOKENS: Record<string, string> = { near: 'near', eth: 'weth.sim', usdc: 'usdc.sim' };

export class MemoryChain implements Chain {
  readonly kind = 'memory' as const;
  readonly contractId = 'inpay.sim';
  private invoices: Invoice[] = [];
  private balances = new Map<string, bigint>(); // `${asset}|${account}`
  readonly txs: { hash: string; method: string; args: unknown }[] = [];

  constructor(private now: () => number = Date.now) {}

  assetId(asset: 'near' | 'eth' | 'usdc') { return TOKENS[asset]; }
  txUrl() { return undefined; }

  mint(account: string, asset: string, amount: bigint) { this.add(account, asset, amount); }
  async balanceOf(account: string, asset: string) { return this.balances.get(`${asset}|${account}`) ?? 0n; }

  private add(account: string, asset: string, delta: bigint) {
    const k = `${asset}|${account}`;
    const v = (this.balances.get(k) ?? 0n) + delta;
    if (v < 0n) throw new Error(`insufficient ${asset} balance for ${account}`);
    this.balances.set(k, v);
  }
  private tx<T>(method: string, args: unknown, value?: T): TxResult<T> {
    const hash = 'sim' + randomBytes(8).toString('hex');
    this.txs.push({ hash, method, args });
    return { hash, value };
  }
  private get(id: number): Invoice {
    const inv = this.invoices[id];
    if (!inv) throw new Error('invoice not found');
    return inv;
  }

  async getInvoice(id: number) { const i = this.invoices[id]; return i ? { ...i } : null; }
  async getInvoices(merchant: string) { return this.invoices.filter((i) => i.merchant === merchant).map((i) => ({ ...i })); }

  async createInvoice(merchant: string, asset: string, amount: bigint, deadlineMinutes: number) {
    if (!Object.values(TOKENS).includes(asset)) throw new Error('asset must be "near" or an allowlisted token');
    if (amount <= 0n) throw new Error('amount must be positive');
    const id = this.invoices.length;
    const now = this.now();
    this.invoices.push({
      id, merchant, asset, amount: amount.toString(), paid: '0', customer: null, status: 'Open',
      provider: null, fiat_amount: null, fiat_currency: null, quote_id: null, payout_ref: null,
      deadline: now + deadlineMinutes * 60_000, created_at: now,
    });
    return this.tx('create_invoice', { merchant, asset, amount: amount.toString() }, id);
  }

  async pay(payer: string, id: number, asset: string, amount: bigint) {
    const inv = this.get(id);
    if (inv.asset !== asset) throw new Error('wrong asset for this invoice');
    if (inv.status !== 'Open' && inv.status !== 'Underpaid') throw new Error('invoice is not awaiting payment');
    if (this.now() > inv.deadline) throw new Error('invoice deadline has passed');
    if (amount <= 0n) throw new Error('payment must be positive');
    this.add(payer, asset, -amount);
    inv.customer ??= payer;
    const total = BigInt(inv.paid) + amount;
    const due = BigInt(inv.amount);
    const paid = total >= due ? due : total;
    const excess = total - paid;
    if (excess > 0n) this.add(payer, asset, excess);
    this.add(this.contractId, asset, amount - excess);
    inv.paid = paid.toString();
    inv.status = paid >= due ? 'Paid' : 'Underpaid';
    return this.tx('pay', { payer, id, amount: amount.toString() });
  }

  async assignProvider(merchant: string, id: number, provider: string, fiatAmount: bigint, currency: string, quoteId: string, reassign: boolean) {
    const inv = this.get(id);
    if (merchant !== inv.merchant) throw new Error('only the merchant can do this');
    if (inv.status !== (reassign ? 'Assigned' : 'Paid')) throw new Error(`invoice must be ${reassign ? 'Assigned' : 'Paid'}`);
    Object.assign(inv, { status: 'Assigned', provider, fiat_amount: fiatAmount.toString(), fiat_currency: currency, quote_id: quoteId });
    return this.tx(reassign ? 'reassign_provider' : 'assign_provider', { id, provider });
  }

  async confirmPayout(merchant: string, id: number, payoutRef: string) {
    const inv = this.get(id);
    if (merchant !== inv.merchant) throw new Error('only the merchant can do this');
    if (inv.status !== 'Assigned') throw new Error('invoice must be Assigned to confirm');
    this.add(this.contractId, inv.asset, -BigInt(inv.amount));
    this.add(inv.provider!, inv.asset, BigInt(inv.amount));
    Object.assign(inv, { status: 'Settled', payout_ref: payoutRef });
    return this.tx('confirm_payout', { id, payoutRef });
  }

  async refund(caller: string, id: number) {
    const inv = this.get(id);
    if (inv.status !== 'Open' && inv.status !== 'Underpaid') throw new Error('only Open or Underpaid invoices can be refunded');
    if (this.now() <= inv.deadline) throw new Error('deadline has not passed');
    if (inv.customer && BigInt(inv.paid) > 0n) {
      this.add(this.contractId, inv.asset, -BigInt(inv.paid));
      this.add(inv.customer, inv.asset, BigInt(inv.paid));
    }
    inv.status = 'Refunded';
    return this.tx('refund', { caller, id });
  }

  /** Test/sim helper: move an invoice's deadline (simulates time passing). */
  expire(id: number) { this.get(id).deadline = this.now() - 1; }
}
