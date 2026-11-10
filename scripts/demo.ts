// npm run demo — fresh demo links and event log (the simulated bank is kept), the three scenario payment
// links seeded, then all services + web started with FAIL_PROVIDER=payrail and a 15s payout
// timeout so scenario 2's reassignment shows quickly.
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { SCENARIOS } from './scenarios.ts';
import { CURRENCIES, MERCHANTS } from '../server/config.ts';
import { parseUnits } from '../server/pricing.ts';
import { loadDeployment } from '../server/chain/near.ts';

const ROOT = path.join(import.meta.dirname, '..');
const STATE = path.join(ROOT, '.state');
// Fresh demo links and event log. The simulated bank (bank.json) is kept: its payouts belong to
// invoices that stay settled on-chain, so wiping it would make balances disagree with the chain.
mkdirSync(STATE, { recursive: true });
for (const f of ['links.json', 'events.json']) rmSync(path.join(STATE, f), { force: true });

const ids = ['demo-cafe', 'demo-bikes', 'demo-tailor'];
const links = Object.fromEntries(SCENARIOS.map((s, i) => {
  const currency = MERCHANTS[s.merchant].currency;
  return [ids[i], {
    id: ids[i], merchant: s.merchant, currency, fiat_minor: parseUnits(s.price, CURRENCIES[currency].minor).toString(),
    memo: s.memo, created_at: Date.now() + i, payments: [],
  }];
}));
writeFileSync(path.join(STATE, 'links.json'), JSON.stringify({ links }, null, 2));

const env = { ...process.env, FAIL_PROVIDER: process.env.FAIL_PROVIDER ?? 'payrail', DEMO_TIMEOUT_SECONDS: process.env.DEMO_TIMEOUT_SECONDS ?? '15' };
const dep = loadDeployment();
console.log(`\nINPay demo — ${dep ? `NEAR testnet (${dep.contract})` : 'in-memory chain (run npm run setup for testnet)'}`);
console.log(`FAIL_PROVIDER=${env.FAIL_PROVIDER}, payout timeout ${env.DEMO_TIMEOUT_SECONDS}s\n`);
console.log('Landing page: http://127.0.0.1:5190/   Merchant dashboard: http://127.0.0.1:5190/dashboard');
SCENARIOS.forEach((s, i) => {
  console.log(`Scenario ${s.n}: ${s.story}`);
  console.log(`   checkout  http://127.0.0.1:5190/pay/${ids[i]}   (choose ${s.asset.toUpperCase()}${s.underpayFirst ? ', click "Demo: pay only 80%", then "Pay the missing"' : ', click Pay'})`);
  console.log(`   dashboard http://127.0.0.1:5190/dashboard?m=${s.merchant}    bank http://127.0.0.1:5190/bank/${s.merchant}`);
});
console.log('');

const child = spawn('npm', ['run', 'dev'], { cwd: ROOT, env, stdio: 'inherit', shell: true });
child.on('exit', (c) => process.exit(c ?? 0));
