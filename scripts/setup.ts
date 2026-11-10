// npm run setup — TESTNET ONLY.
// Creates sub-accounts of NEAR_ACCOUNT_ID, deploys wETH + USDC (near-examples/FT) and inpay,
// registers token storage, funds the customer with 10 NEAR, 1 wETH and 100 USDC.
// Keys go to .keys/ (gitignored). Server-held keys are a testnet demo convenience.
//
// Master key: NEAR_PRIVATE_KEY in .env, or ~/.near-credentials/testnet/<account>.json.
// Re-running is safe: finished steps are skipped.
import 'dotenv/config';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Account, JsonRpcProvider, KeyPair, type KeyPairString } from 'near-api-js';
import { KEYS_DIR, RPC_URL, type Deployment } from '../server/chain/near.ts';
import { MERCHANT_NAMES, PROVIDER_NAMES } from '../server/config.ts';

const NEAR = (n: number | string) => BigInt(Math.round(Number(n) * 1e6)) * 10n ** 18n;
const fmt = (y: bigint) => (Number(y / 10n ** 21n) / 1000).toFixed(3);
const TGAS = 10n ** 12n;
const ROOT = path.join(import.meta.dirname, '..');

const master = process.env.NEAR_ACCOUNT_ID;
if (!master) die('Set NEAR_ACCOUNT_ID (a testnet account, e.g. you.testnet) in .env');
if (!master.endsWith('.testnet')) die(`NEAR_ACCOUNT_ID must be a .testnet account (got ${master}). INPay never touches mainnet.`);

function die(msg: string): never { console.error(`\nsetup: ${msg}\n`); process.exit(1); }

function masterKey(): KeyPairString {
  if (process.env.NEAR_PRIVATE_KEY) return process.env.NEAR_PRIVATE_KEY as KeyPairString;
  const dir = path.join(os.homedir(), '.near-credentials', 'testnet');
  const flat = path.join(dir, `${master}.json`);
  if (existsSync(flat)) return JSON.parse(readFileSync(flat, 'utf8')).private_key;
  const nested = path.join(dir, master!);
  if (existsSync(nested)) {
    const f = readdirSync(nested).find((x) => x.endsWith('.json'));
    if (f) return JSON.parse(readFileSync(path.join(nested, f), 'utf8')).private_key;
  }
  die(`No key for ${master}. Put NEAR_PRIVATE_KEY=ed25519:... in .env, or save it to ${flat}.`);
}

// What each account gets. Contract accounts need ~2.5 NEAR for their ~250 KB of code.
const PLAN: { name: string; near: number }[] = [
  { name: 'inpay', near: 3 },
  { name: 'weth', near: 2.7 },
  { name: 'usdc', near: 2.7 },
  { name: 'customer', near: 10.2 },
  ...MERCHANT_NAMES.map((m) => ({ name: m, near: 0.3 })),
  ...PROVIDER_NAMES.map((p) => ({ name: p, near: 0.05 })),
];
const NEEDED = PLAN.reduce((s, a) => s + a.near, 0) + 0.5; // + storage deposits and gas

const provider = new JsonRpcProvider({ url: RPC_URL });
const root = new Account(master!, provider, masterKey());
const id = (n: string) => `${n}.${master}`;
mkdirSync(KEYS_DIR, { recursive: true });
const keyFile = (acc: string) => path.join(KEYS_DIR, `${acc}.json`);
const depFile = path.join(KEYS_DIR, 'deployment.json');
const dep: Deployment = existsSync(depFile) ? JSON.parse(readFileSync(depFile, 'utf8')) : {
  network: 'testnet', master: master!, contract: id('inpay'), tokens: { eth: id('weth'), usdc: id('usdc') },
  merchants: Object.fromEntries(MERCHANT_NAMES.map((m) => [m, id(m)])), customer: id('customer'),
  providers: Object.fromEntries(PROVIDER_NAMES.map((p) => [p, id(p)])), deploy_tx: {},
};
dep.deploy_tx ??= {};
const save = () => writeFileSync(depFile, JSON.stringify(dep, null, 2));

async function exists(acc: string) {
  try { await provider.viewAccount({ accountId: acc }); return true; } catch { return false; }
}
function acct(acc: string) { return new Account(acc, provider, JSON.parse(readFileSync(keyFile(acc), 'utf8')).private_key); }
async function hasCode(acc: string) {
  const s: any = await provider.viewAccount({ accountId: acc });
  return s.code_hash !== '11111111111111111111111111111111';
}

async function main() {
  console.log(`INPay setup on NEAR testnet (RPC ${RPC_URL}), master account ${master}`);
  const missing = [];
  for (const a of PLAN) if (!(await exists(id(a.name)))) missing.push(a);
  const need = missing.reduce((s, a) => s + a.near, 0) + (missing.length ? 0.5 : 0);
  const bal = (await root.getState()).balance.available;
  console.log(`master balance ${fmt(bal)} NEAR; ${missing.length} accounts to create (needs ~${need.toFixed(2)} NEAR, full setup ~${NEEDED.toFixed(1)})`);
  if (bal < NEAR(need)) {
    die(`${master} has ${fmt(bal)} testnet NEAR but needs about ${need.toFixed(2)}. ` +
      `Get free testnet NEAR from https://near-faucet.io or \`near tokens ${master} send-near ...\` from another testnet account, then re-run.`);
  }

  for (const a of missing) {
    const acc = id(a.name);
    const kp = KeyPair.fromRandom('ed25519');
    writeFileSync(keyFile(acc), JSON.stringify({ account_id: acc, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }, null, 2));
    const r = await root.createSubAccount({ accountOrPrefix: a.name, publicKey: kp.getPublicKey().toString(), nearToTransfer: NEAR(a.near) });
    console.log(`  created ${acc} with ${a.near} NEAR  tx ${r.transaction.hash}`);
  }
  for (const a of PLAN) if (!existsSync(keyFile(id(a.name)))) die(`${id(a.name)} exists but its key is not in .keys/. Delete that account or restore the key.`);

  const ftWasm = readFileSync(path.join(ROOT, 'contract/res/fungible_token.wasm'));
  const tokens = [
    { acc: dep.tokens.eth, symbol: 'wETH', name: 'Wrapped Ether (INPay testnet stand-in)', decimals: 18, supply: 10n ** 24n, gift: 10n ** 18n },
    { acc: dep.tokens.usdc, symbol: 'USDC', name: 'USD Coin (INPay testnet stand-in)', decimals: 6, supply: 10n ** 12n, gift: 100n * 10n ** 6n },
  ];
  for (const t of tokens) {
    const a = acct(t.acc);
    if (!(await hasCode(t.acc))) {
      const d = await a.deployContract(ftWasm);
      const i = await a.callFunctionRaw({ contractId: t.acc, methodName: 'new', gas: 100n * TGAS, args: {
        owner_id: t.acc, total_supply: t.supply.toString(),
        metadata: { spec: 'ft-1.0.0', name: t.name, symbol: t.symbol, decimals: t.decimals, icon: null, reference: null, reference_hash: null },
      } });
      dep.deploy_tx![t.symbol] = d.transaction.hash;
      save();
      console.log(`  deployed ${t.symbol} to ${t.acc}  tx ${d.transaction.hash} / init ${i.transaction.hash}`);
    }
    // register storage for everyone who will hold the token
    for (const holder of [dep.contract, dep.customer, ...Object.values(dep.providers)]) {
      const bal: any = await provider.callFunction({ contractId: t.acc, method: 'storage_balance_of', args: { account_id: holder } });
      if (!bal) {
        await root.callFunctionRaw({ contractId: t.acc, methodName: 'storage_deposit', args: { account_id: holder, registration_only: true }, deposit: NEAR(0.0125), gas: 30n * TGAS });
        console.log(`  registered ${holder} on ${t.symbol}`);
      }
    }
    const cb = BigInt(await provider.callFunction({ contractId: t.acc, method: 'ft_balance_of', args: { account_id: dep.customer } }) as string);
    if (cb < t.gift) {
      await a.callFunctionRaw({ contractId: t.acc, methodName: 'ft_transfer', args: { receiver_id: dep.customer, amount: (t.gift - cb).toString() }, deposit: 1n, gas: 30n * TGAS });
      console.log(`  funded customer with ${t.symbol}`);
    }
  }

  if (!(await hasCode(dep.contract))) {
    const a = acct(dep.contract);
    const d = await a.deployContract(readFileSync(path.join(ROOT, 'contract/res/inpay.wasm')));
    const i = await a.callFunctionRaw({ contractId: dep.contract, methodName: 'new', args: { tokens: [dep.tokens.eth, dep.tokens.usdc] }, gas: 30n * TGAS });
    dep.deploy_tx!.inpay = d.transaction.hash;
    dep.deploy_tx!.inpay_init = i.transaction.hash;
    console.log(`  deployed inpay to ${dep.contract}  tx ${d.transaction.hash} / init ${i.transaction.hash}`);
  }
  save();

  const cust = new Account(dep.customer, provider);
  console.log(`\nDone. Customer ${dep.customer}: ${fmt((await cust.getState()).balance.available)} NEAR, ` +
    `${(BigInt(await provider.callFunction({ contractId: dep.tokens.eth, method: 'ft_balance_of', args: { account_id: dep.customer } }) as string) / 10n ** 15n)} milli-wETH, ` +
    `${(BigInt(await provider.callFunction({ contractId: dep.tokens.usdc, method: 'ft_balance_of', args: { account_id: dep.customer } }) as string) / 10n ** 6n)} USDC`);
  console.log(`Contract: https://testnet.nearblocks.io/address/${dep.contract}`);
  console.log(`Keys and deployment info: .keys/ (gitignored). Next: npm run smoke, then npm run demo.`);
}

main().catch((e) => die(e?.message ?? String(e)));
