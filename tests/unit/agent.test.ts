// Agent tests: the real agent, providers and mock bank over HTTP on 127.0.0.1 with the
// in-memory chain, fixed rates and a 50x faster clock.
process.env.OFFLINE = '1';
process.env.TIME_SCALE = '0.02';
process.env.DEMO_TIMEOUT_SECONDS = '15';

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryChain } from '../../server/chain/memory.ts';
import { createApp, simAccounts } from '../../server/app.ts';
import { parseUnits } from '../../server/pricing.ts';

const chain = new MemoryChain();
const accounts = simAccounts();
const sys = createApp({ chain, accounts, stateDir: null });
let srv: Awaited<ReturnType<typeof sys.listen>>;

const api = async (path: string, body?: unknown) => {
  const r = await fetch(srv.url + path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j: any = await r.json();
  if (!r.ok) throw new Error(j.error);
  return j;
};
const until = async (id: number, status: string, ms = 10_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const inv = await chain.getInvoice(id);
    if (inv?.status === status) return inv;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`invoice ${id} never reached ${status} (is ${(await chain.getInvoice(id))?.status})`);
};
async function checkout(merchant: string, price: string, asset: string) {
  const link = await api('/api/links', { merchant, price });
  const c = await api(`/api/links/${link.id}/checkout`, { asset });
  return { link, id: c.invoice.id as number };
}

before(async () => {
  chain.mint(accounts.customer, 'near', parseUnits('10', 24));
  chain.mint(accounts.customer, chain.assetId('eth'), parseUnits('1', 18));
  chain.mint(accounts.customer, chain.assetId('usdc'), parseUnits('100', 6));
  srv = await sys.listen(0);
});
after(() => srv.close());

test('quote locked before payment; on payment it is assigned, paid out, and escrow released', async () => {
  delete process.env.FAIL_PROVIDER;
  const link = await api('/api/links', { merchant: 'bengaluru-cafe', price: '420' });
  const preview = await api(`/api/links/${link.id}`);
  const nearOpt = preview.options.find((o: any) => o.asset === 'near');
  assert.equal(nearOpt.provider, 'swiftcash'); // lowest spread that accepts NEAR
  const c = await api(`/api/links/${link.id}/checkout`, { asset: 'near' });
  const id = c.invoice.id as number;
  // the customer is shown the exact amount before paying, and the invoice is for exactly that
  assert.equal(c.invoice.amount, nearOpt.amount);
  assert.equal((await chain.getInvoice(id))!.amount, nearOpt.amount);
  assert.equal(c.invoice.quote.provider, 'swiftcash');
  assert.equal(c.invoice.quote.fiat_amount, '42000');
  await api(`/api/links/${link.id}/pay`, {});
  const inv = await until(id, 'Settled');
  assert.equal(inv.provider, accounts.providers.swiftcash);
  assert.equal(inv.quote_id, c.invoice.quote.quote_id, 'the locked quote is the one assigned on-chain');
  assert.equal(inv.fiat_amount, '42000', 'merchant receives the full price');
  assert.equal(sys.bank.get('IN-bengaluru-cafe').balance, '42000');
  assert.equal(await chain.balanceOf(accounts.providers.swiftcash, 'near'), BigInt(inv.amount));
  const kinds = sys.log.list('bengaluru-cafe').map((e) => e.kind);
  for (const k of ['paid', 'quotes', 'assigned', 'bank_credit', 'settled']) assert.ok(kinds.includes(k), k);
});

test('unsupported providers are skipped; failing winner is replaced after the timeout', async () => {
  process.env.FAIL_PROVIDER = 'payrail';
  const { link, id } = await checkout('berlin-bikes', '4.50', 'eth');
  await api(`/api/links/${link.id}/pay`, {});
  await until(id, 'Assigned');
  assert.equal((await chain.getInvoice(id))!.provider, accounts.providers.payrail);
  const inv = await until(id, 'Settled');
  assert.equal(inv.provider, accounts.providers.quickfx);
  // fallback re-quoted for the fixed escrowed amount: wider spread, slightly less than 4.50 EUR
  assert.ok(BigInt(inv.fiat_amount!) < 450n && BigInt(inv.fiat_amount!) >= 440n, inv.fiat_amount!);
  const st = sys.agents['berlin-bikes'].quotesFor(id)!;
  assert.deepEqual(st.failed, ['payrail']);
  assert.ok(!st.quotes.some((q) => q.provider === 'swiftcash'), 'swiftcash does not accept ETH');
  assert.equal(chain.txs.filter((t) => t.method === 'reassign_provider').length, 1);
  delete process.env.FAIL_PROVIDER;
});

test('Underpaid: customer told what is missing; top-up settles', async () => {
  const { link, id } = await checkout('nairobi-tailor', '650', 'usdc');
  await api(`/api/links/${link.id}/pay`, { fraction: 0.8 });
  await until(id, 'Underpaid');
  const page = await api(`/api/links/${link.id}`);
  const missing = BigInt(page.invoice.amount) - BigInt(page.invoice.paid);
  assert.ok(page.message.includes(`missing ${Number(missing) / 1e6} USDC`), page.message);
  await api(`/api/links/${link.id}/pay`, {});
  await until(id, 'Settled');
});

test('Underpaid at the deadline -> agent refunds the customer', async () => {
  const { link, id } = await checkout('nairobi-tailor', '650', 'usdc');
  const usdc = chain.assetId('usdc');
  const before = await chain.balanceOf(accounts.customer, usdc);
  await api(`/api/links/${link.id}/pay`, { fraction: 0.8 });
  await until(id, 'Underpaid');
  chain.expire(id);
  await until(id, 'Refunded');
  assert.equal(await chain.balanceOf(accounts.customer, usdc), before);
});

test('bank credit that does not match the quote does not release escrow', async () => {
  process.env.FAIL_PROVIDER = 'swiftcash';
  const { link, id } = await checkout('bengaluru-cafe', '100', 'near');
  await api(`/api/links/${link.id}/pay`, {});
  const inv = await until(id, 'Assigned');
  await sys.bank.credit({ account: 'IN-bengaluru-cafe', amount: '1', currency: 'INR', ref: inv.quote_id!, from: 'swiftcash' });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await chain.getInvoice(id))!.status, 'Assigned');
  delete process.env.FAIL_PROVIDER;
  await until(id, 'Settled'); // times out on swiftcash, reassigned to payrail, which pays
});
