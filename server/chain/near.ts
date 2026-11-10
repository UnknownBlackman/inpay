// Real NEAR testnet adapter (near-api-js). Keys are read from .keys/ (written by `npm run setup`).
// Server-held keys are a testnet demo convenience only.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Account, JsonRpcProvider, getTransactionLastResult, type KeyPairString } from 'near-api-js';
import { EXPLORER } from '../config.ts';
import type { Chain, Invoice, TxResult } from './types.ts';

export const KEYS_DIR = path.join(import.meta.dirname, '..', '..', '.keys');
export const RPC_URL = process.env.NEAR_RPC_URL ?? 'https://test.rpc.fastnear.com';

export interface Deployment {
  network: 'testnet';
  master: string;
  contract: string;
  tokens: { eth: string; usdc: string };
  merchants: Record<string, string>;
  customer: string;
  providers: Record<string, string>;
  deploy_tx?: Record<string, string>;
}

export function loadDeployment(): Deployment | null {
  const f = path.join(KEYS_DIR, 'deployment.json');
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
}

export function loadKey(accountId: string): KeyPairString {
  const f = path.join(KEYS_DIR, `${accountId}.json`);
  if (!existsSync(f)) throw new Error(`no key for ${accountId} in .keys/ (run npm run setup)`);
  return JSON.parse(readFileSync(f, 'utf8')).private_key;
}

const TGAS = 10n ** 12n;

export class NearChain implements Chain {
  readonly kind = 'near' as const;
  readonly provider: JsonRpcProvider;
  private accounts = new Map<string, Account>();

  constructor(readonly dep: Deployment) {
    this.provider = new JsonRpcProvider({ url: RPC_URL });
  }
  get contractId() { return this.dep.contract; }

  account(id: string): Account {
    let a = this.accounts.get(id);
    if (!a) this.accounts.set(id, (a = new Account(id, this.provider, loadKey(id))));
    return a;
  }

  assetId(asset: 'near' | 'eth' | 'usdc') { return asset === 'near' ? 'near' : this.dep.tokens[asset]; }
  txUrl(hash: string) { return `${EXPLORER}/txns/${hash}`; }

  // Public testnet RPCs rate-limit (HTTP 429). View results are cached for a moment (the
  // agent loop and several browser tabs ask for the same data) and dropped after our own txs.
  private cache = new Map<string, { at: number; p: Promise<unknown> }>();

  private async retry<T>(fn: () => Promise<T>): Promise<T> {
    for (let i = 0; ; i++) {
      try { return await fn(); } catch (e: any) {
        const msg = String(e?.message ?? e);
        if (i >= 5 || !/429|rate limit/i.test(msg)) throw e;
        await new Promise((r) => setTimeout(r, 500 * 2 ** i));
      }
    }
  }

  private cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.p as Promise<T>;
    const p = this.retry(fn);
    this.cache.set(key, { at: Date.now(), p });
    p.catch(() => this.cache.delete(key));
    return p;
  }

  view<T>(contractId: string, method: string, args: Record<string, unknown> = {}, ttlMs = 1500): Promise<T> {
    return this.cached(`${contractId}|${method}|${JSON.stringify(args)}`, ttlMs,
      async () => (await this.provider.callFunction({ contractId, method, args })) as T);
  }

  async call<T>(signer: string, contractId: string, methodName: string, args: Record<string, unknown>,
    opts: { deposit?: bigint; gas?: bigint } = {}): Promise<TxResult<T>> {
    const res = await this.retry(() => this.account(signer).callFunctionRaw({
      contractId, methodName, args, deposit: opts.deposit ?? 0n, gas: opts.gas ?? 100n * TGAS,
    }));
    this.cache.clear();
    return { hash: res.transaction.hash, value: getTransactionLastResult(res as any) as T };
  }

  getInvoice(id: number) { return this.view<Invoice | null>(this.contractId, 'get_invoice', { id }); }
  getInvoices(merchant: string) { return this.view<Invoice[]>(this.contractId, 'get_invoices', { merchant }); }

  createInvoice(merchant: string, asset: string, amount: bigint, deadlineMinutes: number) {
    return this.call<number>(merchant, this.contractId, 'create_invoice', { asset, amount: amount.toString(), deadline_minutes: deadlineMinutes });
  }

  pay(payer: string, id: number, asset: string, amount: bigint) {
    if (asset === 'near') return this.call(payer, this.contractId, 'pay_near', { id }, { deposit: amount, gas: 50n * TGAS });
    return this.call(payer, asset, 'ft_transfer_call',
      { receiver_id: this.contractId, amount: amount.toString(), msg: JSON.stringify({ invoice_id: id }) },
      { deposit: 1n, gas: 150n * TGAS });
  }

  assignProvider(merchant: string, id: number, provider: string, fiatAmount: bigint, currency: string, quoteId: string, reassign: boolean) {
    return this.call(merchant, this.contractId, reassign ? 'reassign_provider' : 'assign_provider',
      { id, provider, fiat_amount: fiatAmount.toString(), fiat_currency: currency, quote_id: quoteId });
  }

  confirmPayout(merchant: string, id: number, payoutRef: string) {
    return this.call(merchant, this.contractId, 'confirm_payout', { id, payout_ref: payoutRef });
  }

  refund(caller: string, id: number) {
    return this.call(caller, this.contractId, 'refund', { id });
  }

  async balanceOf(account: string, asset: string): Promise<bigint> {
    if (asset === 'near') {
      const a = new Account(account, this.provider);
      return this.cached(`state|${account}`, 10_000, async () => (await a.getState()).balance.available);
    }
    return BigInt((await this.view<string>(asset, 'ft_balance_of', { account_id: account }, 10_000)) ?? '0');
  }
}
