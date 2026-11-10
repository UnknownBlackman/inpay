// Sandbox tests for the inpay escrow contract (near-workspaces).
// Needs Linux or macOS (near-sandbox has no Windows binary). On Windows, `npm test`
// runs this file inside a node:20 Docker container.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Worker, type NearAccount } from 'near-workspaces';
import { parseUnits } from '../server/pricing.ts';

const RES = path.join(import.meta.dirname, '..', 'contract', 'res');
const INPAY_WASM = path.join(RES, 'inpay.wasm');
const FT_WASM = path.join(RES, 'fungible_token.wasm');
const TGAS = (n: number) => BigInt(n) * 10n ** 12n;
const near = (s: string) => parseUnits(s, 24);
const STORAGE = near('0.0125');

let worker: Worker;
let root: NearAccount, inpay: NearAccount, weth: NearAccount, usdc: NearAccount, fake: NearAccount;
let merchant: NearAccount, customer: NearAccount, provider: NearAccount, provider2: NearAccount, stranger: NearAccount;

async function deployFt(name: string, symbol: string, decimals: number, supply: string) {
  const ft = await root.createSubAccount(name, { initialBalance: near('10') });
  await ft.deploy(FT_WASM);
  await ft.call(ft, 'new', {
    owner_id: customer.accountId,
    total_supply: supply,
    metadata: { spec: 'ft-1.0.0', name: symbol, symbol, decimals, icon: null, reference: null, reference_hash: null },
  });
  for (const a of [inpay, provider, provider2]) {
    await root.call(ft, 'storage_deposit', { account_id: a.accountId }, { attachedDeposit: STORAGE });
  }
  return ft;
}

const ftBalance = async (ft: NearAccount, who: NearAccount) => BigInt(await ft.view('ft_balance_of', { account_id: who.accountId }) as string);
const nearBalance = async (who: NearAccount) => BigInt((await who.balance()).total);
const invoice = (id: number) => inpay.view('get_invoice', { id }) as Promise<any>;

async function create(asset: string, amount: string, minutes = 10): Promise<number> {
  return await merchant.call(inpay, 'create_invoice', { asset, amount, deadline_minutes: minutes }) as number;
}
async function payToken(ft: NearAccount, id: number, amount: string) {
  return customer.call(ft, 'ft_transfer_call',
    { receiver_id: inpay.accountId, amount, msg: JSON.stringify({ invoice_id: id }) },
    { attachedDeposit: 1n, gas: TGAS(150) });
}
async function payAndAssign(asset: string, amount: string): Promise<number> {
  const id = await create(asset, amount);
  if (asset === 'near') await customer.call(inpay, 'pay_near', { id }, { attachedDeposit: BigInt(amount) });
  else await payToken(asset === weth.accountId ? weth : usdc, id, amount);
  await merchant.call(inpay, 'assign_provider', { id, provider: provider.accountId, fiat_amount: '50000', fiat_currency: 'INR', quote_id: 'q1' });
  return id;
}

before(async () => {
  worker = await Worker.init();
  root = worker.rootAccount;
  const mk = (n: string, b = '50') => root.createSubAccount(n, { initialBalance: near(b) });
  [merchant, customer, provider, provider2, stranger] = await Promise.all(
    ['merchant', 'customer', 'provider', 'provider2', 'stranger'].map((n) => mk(n)));
  inpay = await mk('inpay', '20');
  await inpay.deploy(INPAY_WASM);
  weth = await deployFt('weth', 'wETH', 18, (10n ** 21n).toString());
  usdc = await deployFt('usdc', 'USDC', 6, (10n ** 12n).toString());
  fake = await deployFt('fake', 'FAKE', 6, (10n ** 12n).toString());
  await inpay.call(inpay, 'new', { tokens: [weth.accountId, usdc.accountId] });
});

after(async () => { await worker?.tearDown().catch(() => {}); });

describe('inpay', () => {
  test('1. NEAR: exact payment -> Paid; overpayment -> Paid and excess returned', async () => {
    const one = near('1').toString();
    const a = await create('near', one);
    await customer.call(inpay, 'pay_near', { id: a }, { attachedDeposit: BigInt(one) });
    let inv = await invoice(a);
    assert.equal(inv.status, 'Paid');
    assert.equal(inv.paid, one);
    assert.equal(inv.customer, customer.accountId);

    const b = await create('near', one);
    const before = await nearBalance(customer);
    await customer.call(inpay, 'pay_near', { id: b }, { attachedDeposit: near('3') });
    const spent = before - (await nearBalance(customer));
    inv = await invoice(b);
    assert.equal(inv.status, 'Paid');
    assert.equal(inv.paid, one);
    // spent = 1 NEAR + gas; the 2 NEAR excess came back
    assert.ok(spent >= BigInt(one) && spent < BigInt(one) + 10n ** 22n, `spent ${spent}`);
  });

  test('2. Token: underpayment -> Underpaid; top-up -> Paid', async () => {
    const id = await create(usdc.accountId, '5000000'); // 5 USDC
    await payToken(usdc, id, '4000000');
    let inv = await invoice(id);
    assert.equal(inv.status, 'Underpaid');
    assert.equal(inv.paid, '4000000');
    const before = await ftBalance(usdc, customer);
    await payToken(usdc, id, '1500000'); // 0.5 too much -> returned
    inv = await invoice(id);
    assert.equal(inv.status, 'Paid');
    assert.equal(inv.paid, '5000000');
    assert.equal(before - (await ftBalance(usdc, customer)), 1000000n);
  });

  test('3. non-allowlisted token and wrong token are rejected', async () => {
    const id = await create(weth.accountId, '1000');
    const fakeBefore = await ftBalance(fake, customer);
    await payToken(fake, id, '1000');
    assert.equal(await ftBalance(fake, customer), fakeBefore, 'fake token refunded');
    const usdcBefore = await ftBalance(usdc, customer);
    await payToken(usdc, id, '1000');
    assert.equal(await ftBalance(usdc, customer), usdcBefore, 'wrong token refunded');
    await assert.rejects(customer.call(inpay, 'pay_near', { id }, { attachedDeposit: 1000n }));
    const inv = await invoice(id);
    assert.equal(inv.status, 'Open');
    assert.equal(inv.paid, '0');
    await assert.rejects(merchant.call(inpay, 'create_invoice', { asset: fake.accountId, amount: '1', deadline_minutes: 5 }));
  });

  test('4. only the merchant can assign, reassign and confirm', async () => {
    const amt = near('0.5').toString();
    const id = await create('near', amt);
    await customer.call(inpay, 'pay_near', { id }, { attachedDeposit: BigInt(amt) });
    const args = { id, provider: provider.accountId, fiat_amount: '100', fiat_currency: 'EUR', quote_id: 'q' };
    await assert.rejects(stranger.call(inpay, 'assign_provider', args));
    await assert.rejects(merchant.call(inpay, 'reassign_provider', args), 'reassign needs Assigned');
    await merchant.call(inpay, 'assign_provider', args);
    await assert.rejects(stranger.call(inpay, 'reassign_provider', { ...args, provider: provider2.accountId }));
    await merchant.call(inpay, 'reassign_provider', { ...args, provider: provider2.accountId, quote_id: 'q2' });
    await assert.rejects(stranger.call(inpay, 'confirm_payout', { id, payout_ref: 'x' }, { gas: TGAS(100) }));
    await merchant.call(inpay, 'confirm_payout', { id, payout_ref: 'bank-1' }, { gas: TGAS(100) });
    const inv = await invoice(id);
    assert.equal(inv.status, 'Settled');
    assert.equal(inv.provider, provider2.accountId);
  });

  test('5. confirm_payout sends the right asset to the provider', async () => {
    const amt = near('2').toString();
    const n = await payAndAssign('near', amt);
    const nb = await nearBalance(provider);
    await merchant.call(inpay, 'confirm_payout', { id: n, payout_ref: 'r-near' }, { gas: TGAS(100) });
    assert.equal((await nearBalance(provider)) - nb, BigInt(amt));
    assert.equal((await invoice(n)).status, 'Settled');

    const t = await payAndAssign(weth.accountId, '2000000000000000'); // 0.002 wETH
    const tb = await ftBalance(weth, provider);
    const ub = await ftBalance(usdc, provider);
    await merchant.call(inpay, 'confirm_payout', { id: t, payout_ref: 'r-weth' }, { gas: TGAS(100) });
    assert.equal((await ftBalance(weth, provider)) - tb, 2000000000000000n);
    assert.equal(await ftBalance(usdc, provider), ub);
    const inv = await invoice(t);
    assert.equal(inv.status, 'Settled');
    assert.equal(inv.payout_ref, 'r-weth');
  });

  test('6. refund only after the deadline and only when not Paid', async () => {
    const under = await create(usdc.accountId, '3000000', 1);
    await payToken(usdc, under, '1000000');
    const paid = await create('near', '1000', 1);
    await customer.call(inpay, 'pay_near', { id: paid }, { attachedDeposit: 1000n });

    await assert.rejects(stranger.call(inpay, 'refund', { id: under }, { gas: TGAS(100) }), 'before deadline');

    // move chain time past the 1-minute deadline
    const deadline = (await invoice(under)).deadline as number;
    for (let i = 0; i < 20; i++) {
      await worker.provider.fastForward(100);
      const block: any = await worker.provider.block({ finality: 'final' });
      if (Number(BigInt(block.header.timestamp) / 1_000_000n) > deadline + 1000) break;
    }

    await assert.rejects(stranger.call(inpay, 'refund', { id: paid }, { gas: TGAS(100) }), 'Paid cannot be refunded');
    const before = await ftBalance(usdc, customer);
    await stranger.call(inpay, 'refund', { id: under }, { gas: TGAS(100) });
    assert.equal((await ftBalance(usdc, customer)) - before, 1000000n);
    assert.equal((await invoice(under)).status, 'Refunded');
    assert.equal((await invoice(paid)).status, 'Paid');
    await assert.rejects(stranger.call(inpay, 'refund', { id: under }, { gas: TGAS(100) }), 'no double refund');
  });
});
