// Dev server entry (npm run dev / npm run demo). Port 8790 (PORT); the Vite web app proxies to it.
// With .keys/deployment.json (from npm run setup) it runs against NEAR testnet; otherwise
// it falls back to the in-memory chain so the UI still works with no keys.
import 'dotenv/config';
import { existsSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import { createApp, simAccounts, type Accounts } from './app.ts';
import { NearChain, loadDeployment } from './chain/near.ts';
import { MemoryChain } from './chain/memory.ts';
import { parseUnits } from './pricing.ts';
import type { Chain } from './chain/types.ts';
import { getRates } from './rates.ts';
import { MERCHANTS, type MerchantName } from './config.ts';

const ROOT = path.join(import.meta.dirname, '..');
const dep = process.env.CHAIN === 'memory' ? null : loadDeployment();
let chain: Chain;
let accounts: Accounts;
if (dep) {
  chain = new NearChain(dep);
  accounts = { merchants: dep.merchants as Accounts['merchants'], customer: dep.customer, providers: dep.providers as Accounts['providers'] };
} else {
  const mem = new MemoryChain();
  accounts = simAccounts();
  mem.mint(accounts.customer, 'near', parseUnits('10', 24));
  mem.mint(accounts.customer, mem.assetId('eth'), parseUnits('1', 18));
  mem.mint(accounts.customer, mem.assetId('usdc'), parseUnits('100', 6));
  chain = mem;
}

const sys = createApp({ chain, accounts, stateDir: dep ? path.join(ROOT, '.state') : null });

// Serve the built web app if present (npm run build:web); in dev, Vite serves it on :5190.
const dist = path.join(ROOT, 'web', 'dist');
if (existsSync(dist)) {
  sys.app.use(express.static(dist));
  // the landing is dist/index.html (served at / by express.static); app routes get the React app
  sys.app.get(/^\/(dashboard|pay\/|bank\/)/, (_req, res) => res.sendFile(path.join(dist, 'app.html')));
}

const warm = await getRates(); // first call waits for live rates (falls back if unreachable)
console.log(`rates: ${warm.source} (NEAR ${warm.usd.near} USD, ETH ${warm.usd.eth} USD, ${warm.fx.INR} INR per USD)`);
const port = Number(process.env.PORT ?? 8790);
const srv = await sys.listen(port);
console.log(`INPay services on ${srv.url}  (chain: ${dep ? `NEAR testnet, contract ${dep.contract}` : 'in-memory (no .keys/deployment.json)'})`);
console.log(`  FAIL_PROVIDER=${process.env.FAIL_PROVIDER ?? '-'}  payout timeout ${process.env.DEMO_TIMEOUT_SECONDS ?? 60}s`);
console.log(`  web: http://127.0.0.1:${process.env.WEB_PORT ?? 5190}`);

// The simulated bank lives in .state/bank.json, the invoices on-chain. If the bank file was lost,
// rebuild its payouts from the Settled invoices (each carries its bank reference, amount and
// currency) so the balance and statement agree with what the dashboard shows. Retries while the
// RPC is unreachable.
if (dep) {
  const providerName = (acct: string) => Object.entries(dep.providers).find(([, a]) => a === acct)?.[0] ?? acct;
  const reconcile = async (attempt = 1): Promise<void> => {
    try {
      const credits = [];
      for (const [m, acct] of Object.entries(dep.merchants)) {
        const info = MERCHANTS[m as MerchantName];
        if (!info) continue;
        for (const inv of await chain.getInvoices(acct)) {
          if (inv.status !== 'Settled' || !inv.payout_ref || !inv.fiat_amount || inv.fiat_currency !== info.currency) continue;
          credits.push({ account: info.bankAccount, currency: info.currency, amount: inv.fiat_amount, txn_id: inv.payout_ref,
            ref: inv.quote_id ?? inv.payout_ref, from: providerName(inv.provider ?? ''), ts: inv.created_at });
        }
      }
      const n = sys.bank.reconcile(credits);
      if (n) console.log(`[bank] restored ${n} payout${n === 1 ? '' : 's'} from settled on-chain invoices`);
    } catch (e) {
      if (attempt < 6) setTimeout(() => reconcile(attempt + 1), 20_000);
      else console.warn(`[bank] could not read invoices to reconcile the bank: ${(e as Error).message}`);
    }
  };
  reconcile();
}
