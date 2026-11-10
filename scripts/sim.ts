// npm run sim: fully offline. Fixed rates (rates.fallback.json), in-memory chain, no keys,
// no LLM. Runs the real agent, providers and mock bank over HTTP on 127.0.0.1 with a ~20x
// faster clock, plays the three demo scenarios and prints the event log.
process.env.OFFLINE = '1';
process.env.TIME_SCALE ??= '0.05';
process.env.DEMO_TIMEOUT_SECONDS ??= '15';
process.env.FAIL_PROVIDER ??= 'payrail';
delete process.env.LLM_BASE_URL;

const { MemoryChain } = await import('../server/chain/memory.ts');
const { createApp, simAccounts } = await import('../server/app.ts');
const { SCENARIOS } = await import('./scenarios.ts');
const { MERCHANTS } = await import('../server/config.ts');
const { fmtFiat, parseUnits } = await import('../server/pricing.ts');

const chain = new MemoryChain();
const accounts = simAccounts();
chain.mint(accounts.customer, 'near', parseUnits('10', 24));
chain.mint(accounts.customer, chain.assetId('eth'), parseUnits('1', 18));
chain.mint(accounts.customer, chain.assetId('usdc'), parseUnits('100', 6));

const sys = createApp({ chain, accounts, stateDir: null });
let t0 = Date.now();
sys.log.onEvent((e) => {
  const secs = ((Date.now() - t0) / 1000 / Number(process.env.TIME_SCALE)).toFixed(1).padStart(6);
  console.log(`  [${secs}s] ${e.merchant.padEnd(14)} ${e.kind.padEnd(15)} ${e.text}`);
});
const srv = await sys.listen(0);

const api = async (path: string, body?: unknown) => {
  const r = await fetch(srv.url + path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j: any = await r.json();
  if (!r.ok) throw new Error(`${path}: ${j.error}`);
  return j;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(id: number, statuses: string[], timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const inv = await chain.getInvoice(id);
    if (inv && statuses.includes(inv.status)) return inv;
    await sleep(50);
  }
  throw new Error(`invoice ${id} did not reach ${statuses.join('/')}`);
}

console.log(`INPay offline simulation (fixed rates, in-memory chain, clock x${1 / Number(process.env.TIME_SCALE)}, FAIL_PROVIDER=${process.env.FAIL_PROVIDER})\n`);
let ok = true;
t0 = Date.now();
for (const s of SCENARIOS) {
  console.log(`Scenario ${s.n}: ${s.story}`);
  try {
    const link = await api('/api/links', { merchant: s.merchant, price: s.price, memo: s.memo });
    const checkout = await api(`/api/links/${link.id}/checkout`, { asset: s.asset });
    const id = checkout.invoice.id;
    if (s.underpayFirst) {
      await api(`/api/links/${link.id}/pay`, { fraction: 0.8 });
      await waitFor(id, ['Underpaid']);
      await sleep(200);
    }
    await api(`/api/links/${link.id}/pay`, {});
    const inv = await waitFor(id, ['Settled'], 60_000);
    const bank = sys.bank.get(MERCHANTS[s.merchant].bankAccount);
    console.log(`  => invoice #${id} ${inv.status}; provider ${inv.provider}; bank balance ${fmtFiat(BigInt(bank.balance), bank.currency as any)}\n`);
  } catch (e) {
    ok = false;
    console.log(`  !! scenario ${s.n} failed: ${(e as Error).message}\n`);
  }
}
srv.close();
console.log(ok ? 'All three scenarios settled.' : 'Some scenarios FAILED.');
process.exit(ok ? 0 : 1);
export {};
