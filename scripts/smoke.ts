// npm run smoke — testnet gate: NEAR payment -> assign -> confirm_payout, a USDC token
// payment, and an underpaid invoice refunded after its 1-minute deadline. Prints explorer links
// and writes them to .keys/smoke.json (copied into the README).
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { NearChain, loadDeployment, KEYS_DIR } from '../server/chain/near.ts';
import { convert, fmtAsset } from '../server/pricing.ts';
import { getRates } from '../server/rates.ts';
import { PROVIDERS } from '../server/config.ts';

const dep = loadDeployment();
if (!dep) { console.error('No .keys/deployment.json. Run npm run setup first.'); process.exit(1); }
const chain = new NearChain(dep);
const out: Record<string, string> = {};
const step = (name: string, hash: string) => { out[name] = hash; console.log(`  ${name.padEnd(22)} ${chain.txUrl(hash)}`); };
const merchant = dep.merchants['bengaluru-cafe'];
const tailor = dep.merchants['nairobi-tailor'];

console.log(`Smoke test on testnet, contract ${dep.contract}`);
const rates = await getRates();

// 1. NEAR: create (~100 INR), pay, assign to swiftcash with a real quote, confirm payout.
const amount = convert(10000n, { currency: 'INR' }, { asset: 'near' }, rates, { round: 'up' });
const created = await chain.createInvoice(merchant, 'near', amount, 10);
const id = created.value!;
step(`create_invoice #${id}`, created.hash);
step('pay_near', (await chain.pay(dep.customer, id, 'near', amount)).hash);
const fiat = convert(amount, { asset: 'near' }, { currency: 'INR' }, rates, { spreadBps: PROVIDERS.swiftcash.spreadBps });
step('assign_provider', (await chain.assignProvider(merchant, id, dep.providers.swiftcash, fiat, 'INR', 'smoke-quote', false)).hash);
const before = await chain.balanceOf(dep.providers.swiftcash, 'near');
step('confirm_payout', (await chain.confirmPayout(merchant, id, 'SMOKE-BANK-REF')).hash);
const inv = await chain.getInvoice(id);
const gained = (await chain.balanceOf(dep.providers.swiftcash, 'near')) - before;
console.log(`  invoice #${id}: ${inv?.status}, ${fmtAsset(amount, 'near')} escrowed; provider balance +${fmtAsset(gained, 'near')}`);

// 2. Token payment (USDC) + 3. refund of an underpaid invoice after its deadline.
const usdc = dep.tokens.usdc;
const t = await chain.createInvoice(tailor, usdc, 1_000_000n, 10);
step(`create_invoice #${t.value} (USDC)`, t.hash);
step('ft_transfer_call (USDC)', (await chain.pay(dep.customer, t.value!, usdc, 1_000_000n)).hash);
console.log(`  invoice #${t.value}: ${(await chain.getInvoice(t.value!))?.status}`);

const r = await chain.createInvoice(tailor, usdc, 2_000_000n, 1);
step(`create_invoice #${r.value} (refund)`, r.hash);
step('underpay 0.5 USDC', (await chain.pay(dep.customer, r.value!, usdc, 500_000n)).hash);
console.log('  waiting ~70s for the 1-minute deadline to pass...');
await new Promise((res) => setTimeout(res, 70_000));
step('refund', (await chain.refund(tailor, r.value!)).hash);
console.log(`  invoice #${r.value}: ${(await chain.getInvoice(r.value!))?.status}`);

writeFileSync(path.join(KEYS_DIR, 'smoke.json'), JSON.stringify({ at: new Date().toISOString(), contract: dep.contract, tx: out }, null, 2));
console.log('\nSaved to .keys/smoke.json');
