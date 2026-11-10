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
  sys.app.get(/^\/(pay|bank)\/.*|^\/$/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

const warm = await getRates(); // first call waits for live rates (falls back if unreachable)
console.log(`rates: ${warm.source} (NEAR ${warm.usd.near} USD, ETH ${warm.usd.eth} USD, ${warm.fx.INR} INR per USD)`);
const port = Number(process.env.PORT ?? 8790);
const srv = await sys.listen(port);
console.log(`INPay services on ${srv.url}  (chain: ${dep ? `NEAR testnet, contract ${dep.contract}` : 'in-memory (no .keys/deployment.json)'})`);
console.log(`  FAIL_PROVIDER=${process.env.FAIL_PROVIDER ?? '-'}  payout timeout ${process.env.DEMO_TIMEOUT_SECONDS ?? 60}s`);
console.log(`  web: http://127.0.0.1:${process.env.WEB_PORT ?? 5190}`);
