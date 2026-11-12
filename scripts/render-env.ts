// npm run render:env — writes .keys/render.env (gitignored) with the two secret env vars a host
// such as Render needs to run INPay against your testnet deployment:
//   INPAY_DEPLOYMENT  your .keys/deployment.json (account ids, no keys)
//   INPAY_KEYS        private keys of the accounts the server signs with: the three merchants
//                     and the demo customer. Your master account, the contract and the token
//                     keys are NOT included: the running app never needs them.
// Testnet only. Paste the two values into the host's secret env vars; never commit them.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { KEYS_DIR, loadDeployment, loadKey } from '../server/chain/near.ts';

const dep = loadDeployment();
if (!dep) { console.error('No .keys/deployment.json. Run npm run setup first.'); process.exit(1); }
if (dep.network !== 'testnet') { console.error('Refusing: this is for a testnet deployment only.'); process.exit(1); }

const signers = [...Object.values(dep.merchants), dep.customer];
const keys = Object.fromEntries(signers.map((a) => [a, loadKey(a)]));
const out = path.join(KEYS_DIR, 'render.env');
writeFileSync(out, `INPAY_DEPLOYMENT=${JSON.stringify(dep)}\nINPAY_KEYS=${JSON.stringify(keys)}\n`);
console.log(`Wrote ${out} (gitignored) with INPAY_DEPLOYMENT and INPAY_KEYS for ${signers.length} accounts:`);
for (const a of signers) console.log(`  ${a}`);
console.log('\nOn Render: your service > Environment > add both as secret variables (paste each value as one line).');
console.log('These are testnet keys. Do not commit or share the file.');
