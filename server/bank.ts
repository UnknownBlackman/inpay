// SIMULATED bank. Accounts hold a local-currency balance in minor units. A credit posts
// a webhook to the merchant agent, like a real bank's payment notification.
import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { JsonStore } from './store.ts';
import { MERCHANTS, MERCHANT_NAMES } from './config.ts';

export interface BankTxn { txn_id: string; ts: number; amount: string; currency: string; ref: string; from: string; balance_after: string }
export interface BankAccount { account: string; owner: string; currency: string; balance: string; statement: BankTxn[] }
export interface Credit { account: string; amount: string; currency: string; ref: string; from?: string }

export class MockBank {
  store: JsonStore<{ accounts: Record<string, BankAccount> }>;
  constructor(dir: string | null, private webhookUrl: () => string) {
    this.store = new JsonStore(dir, 'bank', () => ({ accounts: {} }));
    for (const m of MERCHANT_NAMES) {
      const { bankAccount, currency } = MERCHANTS[m];
      this.store.data.accounts[bankAccount] ??= { account: bankAccount, owner: m, currency, balance: '0', statement: [] };
    }
    this.store.save();
  }

  get(account: string) { return this.store.data.accounts[account]; }

  async credit(c: Credit): Promise<BankTxn> {
    const acct = this.get(c.account);
    if (!acct) throw Object.assign(new Error('unknown account'), { status: 404 });
    if (acct.currency !== c.currency) throw Object.assign(new Error(`account is in ${acct.currency}`), { status: 400 });
    const amount = BigInt(c.amount);
    if (amount <= 0n) throw Object.assign(new Error('amount must be positive'), { status: 400 });
    acct.balance = (BigInt(acct.balance) + amount).toString();
    const txn: BankTxn = {
      txn_id: 'BNK-' + randomBytes(5).toString('hex').toUpperCase(),
      ts: Date.now(), amount: c.amount, currency: c.currency, ref: c.ref, from: c.from ?? 'unknown', balance_after: acct.balance,
    };
    acct.statement.push(txn);
    this.store.save();
    // Notify the merchant agent (fire and forget, like a bank webhook).
    fetch(this.webhookUrl(), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: acct.account, ...txn }),
    }).catch((e) => console.warn('[bank] webhook failed:', e.message));
    return txn;
  }

  router() {
    const r = Router();
    r.post('/credit', async (req, res) => {
      try { res.json(await this.credit(req.body)); } catch (e: any) { res.status(e.status ?? 500).json({ error: e.message }); }
    });
    r.get('/statement/:account', (req, res) => {
      const a = this.get(req.params.account);
      a ? res.json(a) : res.status(404).json({ error: 'unknown account' });
    });
    return r;
  }
}
