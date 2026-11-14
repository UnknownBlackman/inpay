// One-off MAINNET run, separate from the app (the app stays testnet-only):
// a customer pays in USDC on Solana, NEAR Intents (1Click) bridges it to USDC on NEAR, and it
// goes through INPay's escrow contract deployed on NEAR mainnet: invoice -> paid -> assigned ->
// settled, with the USDC released to the provider. The provider's fiat payout is still simulated.
//
//   npx tsx scripts/mainnet/crosschain.ts plan            read-only: balances, accounts, a dry quote
//   npx tsx scripts/mainnet/crosschain.ts setup --yes     create accounts, deploy + init inpay, register USDC storage
//   npx tsx scripts/mainnet/crosschain.ts bridge --yes    Solana USDC -> NEAR USDC (customer) via 1Click
//   npx tsx scripts/mainnet/crosschain.ts pay --yes       invoice, pay into escrow, assign, confirm payout
//
// .env: NEAR_MAINNET_ACCOUNT_ID, NEAR_MAINNET_PRIVATE_KEY, SOLANA_MAINNET_ADDRESS, SOLANA_WALLET_PRIVATE_KEY.
// New account keys go to .keys/mainnet/ (gitignored). Public results go to scripts/mainnet/mainnet-run.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Account, JsonRpcProvider, KeyPair, type KeyPairString } from 'near-api-js';
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import bs58 from 'bs58';

const ROOT = path.resolve(import.meta.dirname, '../..');
process.loadEnvFile(path.join(ROOT, '.env'));
const env = (k: string) => process.env[k] || die(`set ${k} in .env`);
function die(m: string): never { console.error(`\n${m}\n`); process.exit(1); }

const cmd = process.argv[2] ?? 'plan';
const YES = process.argv.includes('--yes');
if (cmd !== 'plan' && !YES) die(`"${cmd}" signs mainnet transactions. Re-run with --yes to confirm.`);

const MASTER = env('NEAR_MAINNET_ACCOUNT_ID');
if (!MASTER.endsWith('.near')) die(`NEAR_MAINNET_ACCOUNT_ID must be a .near account (got ${MASTER})`);
const RPC = process.env.NEAR_MAINNET_RPC_URL ?? 'https://rpc.mainnet.fastnear.com';
const SOL_RPC = process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com';
const ONECLICK = 'https://1click.chaindefuser.com/v0';

// Native USDC on NEAR (Circle) and on Solana, as listed by 1Click /v0/tokens
const USDC_NEAR = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const USDC_NEAR_ASSET = `nep141:${USDC_NEAR}`;
const USDC_SOL_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const USDC_SOL_ASSET = 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near';

const BRIDGE_IN = 2_500_000n;  // 2.5 USDC sent on Solana
const INVOICE = 2_000_000n;    // 2.0 USDC invoice (the bridged amount covers it after fees)
const TGAS = 10n ** 12n;
const NEAR = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 18n;
const fmtN = (y: bigint) => (Number(y / 10n ** 20n) / 1e4).toFixed(4);
const usdc = (u: bigint | string) => (Number(u) / 1e6).toFixed(6);

const ACC = { contract: `inpay.${MASTER}`, merchant: `bengaluru-cafe.${MASTER}`, provider: `swiftcash.${MASTER}`, customer: MASTER };
const PLAN = [{ id: ACC.contract, near: 2.2 }, { id: ACC.merchant, near: 0.05 }, { id: ACC.provider, near: 0.02 }];

const provider = new JsonRpcProvider({ url: RPC });
const root = new Account(MASTER, provider, env('NEAR_MAINNET_PRIVATE_KEY') as KeyPairString);
const KEYS = path.join(ROOT, '.keys', 'mainnet');
const keyFile = (a: string) => path.join(KEYS, `${a}.json`);
const acct = (a: string) => a === MASTER ? root : new Account(a, provider, JSON.parse(readFileSync(keyFile(a), 'utf8')).private_key);
const OUT = path.join(import.meta.dirname, 'mainnet-run.json');
const run: any = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { network: 'mainnet', accounts: ACC, steps: {} };
const save = () => writeFileSync(OUT, JSON.stringify(run, null, 2));
const tx = (h: string) => `https://nearblocks.io/txns/${h}`;
const step = (k: string, v: any) => { run.steps[k] = { ...v, at: new Date().toISOString() }; save(); console.log(`  ✓ ${k}`, JSON.stringify(v)); };

const exists = async (a: string) => { try { await provider.viewAccount({ accountId: a }); return true; } catch { return false; } };
const view = (c: string, m: string, args: object) => provider.callFunction({ contractId: c, method: m, args }) as Promise<any>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function quote(dry: boolean) {
  const r = await fetch(`${ONECLICK}/quote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
    dry, swapType: 'EXACT_INPUT', slippageTolerance: 100,
    originAsset: USDC_SOL_ASSET, depositType: 'ORIGIN_CHAIN', amount: BRIDGE_IN.toString(),
    destinationAsset: USDC_NEAR_ASSET, recipient: ACC.customer, recipientType: 'DESTINATION_CHAIN',
    refundTo: env('SOLANA_MAINNET_ADDRESS'), refundType: 'ORIGIN_CHAIN',
    deadline: new Date(Date.now() + 15 * 60e3).toISOString(),
  }) });
  const j: any = await r.json();
  if (!r.ok) die(`1Click quote ${r.status}: ${JSON.stringify(j)}`);
  return j;
}

async function plan() {
  const sol = new Connection(SOL_RPC, 'confirmed');
  const me = new PublicKey(env('SOLANA_MAINNET_ADDRESS'));
  const lamports = await sol.getBalance(me);
  const ata = getAssociatedTokenAddressSync(USDC_SOL_MINT, me);
  const solUsdc = await sol.getTokenAccountBalance(ata).then((b) => b.value.uiAmountString).catch(() => '0');
  const st: any = await provider.viewAccount({ accountId: MASTER });
  console.log(`NEAR ${MASTER}: ${fmtN(BigInt(st.amount))} NEAR, USDC ${usdc(await view(USDC_NEAR, 'ft_balance_of', { account_id: MASTER }))}`);
  console.log(`Solana ${me.toBase58()}: ${lamports / 1e9} SOL, USDC ${solUsdc}`);
  for (const p of PLAN) console.log(`  ${p.id}: ${(await exists(p.id)) ? 'exists' : `to create with ${p.near} NEAR`}`);
  const q = await quote(true);
  console.log(`dry quote: ${usdc(BRIDGE_IN)} USDC (Solana) -> ${usdc(q.quote.amountOut)} USDC on NEAR (min ${usdc(q.quote.minAmountOut)}), ~${q.quote.timeEstimate} s`);
  if (lamports < 3_000_000) console.log('!! the Solana wallet needs ~0.003 SOL for fees before "bridge"');
}

async function setup() {
  mkdirSync(KEYS, { recursive: true });
  for (const p of PLAN) {
    if (await exists(p.id)) continue;
    const kp = KeyPair.fromRandom('ed25519');
    writeFileSync(keyFile(p.id), JSON.stringify({ account_id: p.id, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }, null, 2));
    const r = await root.createSubAccount({ accountOrPrefix: p.id.split('.')[0], publicKey: kp.getPublicKey().toString(), nearToTransfer: NEAR(p.near) });
    step(`create ${p.id}`, { tx: tx(r.transaction.hash), near: p.near });
  }
  const st: any = await provider.viewAccount({ accountId: ACC.contract });
  if (st.code_hash === '11111111111111111111111111111111') {
    const c = acct(ACC.contract);
    const d = await c.deployContract(readFileSync(path.join(ROOT, 'contract/res/inpay.wasm')));
    step('deploy inpay', { tx: tx(d.transaction.hash) });
    const i = await c.callFunctionRaw({ contractId: ACC.contract, methodName: 'new', args: { tokens: [USDC_NEAR] }, gas: 30n * TGAS });
    step('init inpay (allowlist: native USDC)', { tx: tx(i.transaction.hash) });
  }
  for (const holder of [ACC.customer, ACC.contract, ACC.provider]) {
    if (await view(USDC_NEAR, 'storage_balance_of', { account_id: holder })) continue;
    const r = await root.callFunctionRaw({ contractId: USDC_NEAR, methodName: 'storage_deposit', args: { account_id: holder, registration_only: true }, deposit: NEAR(0.00125), gas: 30n * TGAS });
    step(`register ${holder} on USDC`, { tx: tx(r.transaction.hash) });
  }
}

async function bridge() {
  const sol = new Connection(SOL_RPC, 'confirmed');
  const payer = Keypair.fromSecretKey(bs58.decode(env('SOLANA_WALLET_PRIVATE_KEY')));
  if (payer.publicKey.toBase58() !== env('SOLANA_MAINNET_ADDRESS')) die('SOLANA_WALLET_PRIVATE_KEY does not match SOLANA_MAINNET_ADDRESS');
  if ((await sol.getBalance(payer.publicKey)) < 3_000_000) die('The Solana wallet needs ~0.003 SOL for fees first.');
  const before = BigInt(await view(USDC_NEAR, 'ft_balance_of', { account_id: ACC.customer }));

  const q = await quote(false);
  const dep = new PublicKey(q.quote.depositAddress);
  console.log(`quote: deposit ${usdc(BRIDGE_IN)} USDC to ${dep.toBase58()}, expect ${usdc(q.quote.amountOut)} USDC at ${ACC.customer}`);
  const from = getAssociatedTokenAddressSync(USDC_SOL_MINT, payer.publicKey);
  const to = getAssociatedTokenAddressSync(USDC_SOL_MINT, dep, true);
  const t = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, to, dep, USDC_SOL_MINT),
    createTransferCheckedInstruction(from, USDC_SOL_MINT, to, payer.publicKey, BRIDGE_IN, 6),
  );
  const sig = await sol.sendTransaction(t, [payer]);
  await sol.confirmTransaction(sig, 'confirmed');
  console.log(`solana deposit ${sig}`);
  await fetch(`${ONECLICK}/deposit/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ depositAddress: dep.toBase58(), txHash: sig }) });

  let s: any;
  const t0 = Date.now();
  for (let i = 0; i < 120; i++) {
    s = await (await fetch(`${ONECLICK}/status?depositAddress=${dep.toBase58()}`)).json();
    process.stdout.write(`\r  1Click status: ${s.status}   ${((Date.now() - t0) / 1000).toFixed(0)} s   `);
    if (['SUCCESS', 'REFUNDED', 'FAILED'].includes(s.status)) break;
    await sleep(5000);
  }
  console.log();
  const after = BigInt(await view(USDC_NEAR, 'ft_balance_of', { account_id: ACC.customer }));
  step('bridge Solana USDC -> NEAR USDC (NEAR Intents 1Click)', {
    status: s.status, seconds: Math.round((Date.now() - t0) / 1000), sent_usdc: usdc(BRIDGE_IN), received_usdc: usdc(after - before),
    solana_tx: `https://solscan.io/tx/${sig}`, deposit_address: dep.toBase58(),
    intents_explorer: `https://explorer.near-intents.org/transactions/${dep.toBase58()}`,
    near_txs: s.swapDetails?.nearTxHashes?.map(tx), destination_txs: s.swapDetails?.destinationChainTxHashes?.map((h: any) => h.explorerUrl ?? h.hash ?? h),
  });
  if (s.status !== 'SUCCESS') die(`bridge ended with ${s.status}`);
}

async function pay() {
  const merchant = acct(ACC.merchant), contract = ACC.contract;
  const bal = BigInt(await view(USDC_NEAR, 'ft_balance_of', { account_id: ACC.customer }));
  if (bal < INVOICE) die(`customer has ${usdc(bal)} USDC on NEAR; run "bridge" first`);

  // the merchant prices ₹ in its own currency; 2 USDC at live INR rates, less SwiftCash's 0.8%
  const fx: any = await (await fetch('https://open.er-api.com/v6/latest/USD')).json();
  const inrPerUsd = fx?.rates?.INR ?? 84;
  const fiatMinor = BigInt(Math.floor(Number(INVOICE) / 1e6 * inrPerUsd * (1 - 0.008) * 100));

  const c = await merchant.callFunctionRaw({ contractId: contract, methodName: 'create_invoice', args: { asset: USDC_NEAR, amount: INVOICE.toString(), deadline_minutes: 30 }, gas: 30n * TGAS });
  const id = JSON.parse(Buffer.from((c.status as any).SuccessValue, 'base64').toString());
  step('create_invoice (merchant)', { invoice_id: id, amount_usdc: usdc(INVOICE), tx: tx(c.transaction.hash) });

  const p = await root.callFunctionRaw({ contractId: USDC_NEAR, methodName: 'ft_transfer_call', args: { receiver_id: contract, amount: INVOICE.toString(), msg: JSON.stringify({ invoice_id: id }) }, deposit: 1n, gas: 100n * TGAS });
  step('pay into escrow (customer, ft_transfer_call)', { tx: tx(p.transaction.hash), status: (await view(contract, 'get_invoice', { id })).status });

  const a = await merchant.callFunctionRaw({ contractId: contract, methodName: 'assign_provider', args: { id, provider: ACC.provider, fiat_amount: fiatMinor.toString(), fiat_currency: 'INR', quote_id: `swiftcash-mainnet-${id}` }, gas: 30n * TGAS });
  step('assign_provider (merchant)', { provider: ACC.provider, fiat: `₹${(Number(fiatMinor) / 100).toFixed(2)}`, inr_per_usd: inrPerUsd, tx: tx(a.transaction.hash) });

  await confirm(id);
}

async function confirm(id = Number(run.steps['create_invoice (merchant)']?.invoice_id)) {
  const merchant = acct(ACC.merchant), contract = ACC.contract;
  // confirm_payout attaches 100 Tgas: the signer must hold ~0.1 NEAR up front (unused gas is refunded)
  const avail = BigInt(((await provider.viewAccount({ accountId: ACC.merchant })) as any).amount);
  if (avail < NEAR(0.12)) {
    const r = await root.transfer({ receiverId: ACC.merchant, amount: NEAR(0.1) });
    step('top up merchant gas (0.1 NEAR)', { tx: tx(r.transaction.hash) });
  }
  // the fiat payout itself is simulated (no licensed offramp partner); the release rule is real
  const ref = `simulated-bank-${Date.now().toString(36)}`;
  const s = await merchant.callFunctionRaw({ contractId: contract, methodName: 'confirm_payout', args: { id, payout_ref: ref }, gas: 100n * TGAS });
  const inv = await view(contract, 'get_invoice', { id });
  step('confirm_payout (merchant) -> USDC released to provider', { payout_ref: ref, tx: tx(s.transaction.hash), status: inv.status,
    provider_usdc: usdc(await view(USDC_NEAR, 'ft_balance_of', { account_id: ACC.provider })) });
}

const fn = ({ plan, setup, bridge, pay, confirm: () => confirm() } as Record<string, () => Promise<void>>)[cmd];
if (!fn) die(`unknown command ${cmd}`);
await fn();
