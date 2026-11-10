// npm run scenarios — with `npm run demo` running, plays the three seeded checkouts through the
// same HTTP API the web page uses, waits for each to settle, and prints the agent's event log.
// The same thing a human does by clicking Pay on /pay/demo-cafe, /pay/demo-bikes, /pay/demo-tailor.
import { SCENARIOS } from './scenarios.ts';

const BASE = process.env.BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 8790}`;
const ids = ['demo-cafe', 'demo-bikes', 'demo-tailor'];
const only = process.argv[2] ? Number(process.argv[2]) : undefined;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function api(path: string, body?: unknown) {
  const r = await fetch(BASE + path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j: any = await r.json();
  if (!r.ok) throw new Error(`${path}: ${j.error}`);
  return j;
}
async function until(link: string, statuses: string[], ms = 180_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const d = await api(`/api/links/${link}`);
    if (d.invoice && statuses.includes(d.invoice.status)) return d;
    await sleep(1500);
  }
  throw new Error(`${link} did not reach ${statuses}`);
}

let seen = 0;
async function printEvents(merchant: string) {
  const evs: any[] = await api(`/api/events?merchant=${merchant}&since=${seen}`);
  for (const e of evs) {
    console.log(`  ${new Date(e.ts).toLocaleTimeString()} ${e.kind.padEnd(15)} ${e.text}${e.tx_url ? `\n${' '.repeat(26)}${e.tx_url}` : ''}`);
    seen = Math.max(seen, e.seq);
  }
}

for (const [i, s] of SCENARIOS.entries()) {
  if (only && s.n !== only) continue;
  console.log(`\nScenario ${s.n}: ${s.story}`);
  const link = ids[i];
  const pre = await api(`/api/links/${link}`);
  if (pre.invoice?.status === 'Settled') { console.log('  already settled (run npm run demo for fresh state)'); continue; }
  await api(`/api/links/${link}/checkout`, { asset: s.asset });
  if (s.underpayFirst) {
    await api(`/api/links/${link}/pay`, { fraction: 0.8 });
    const d = await until(link, ['Underpaid']);
    await sleep(4000);
    console.log(`  customer sees: ${(await api(`/api/links/${link}`)).message ?? d.message}`);
  }
  await api(`/api/links/${link}/pay`, {});
  const d = await until(link, ['Settled', 'Refunded']);
  await sleep(4000); // let the agent log its final line
  await printEvents(s.merchant);
  const m = await api(`/api/merchants/${s.merchant}`);
  console.log(`  => invoice #${d.invoice.id} ${d.invoice.status} via ${d.invoice.provider}; bank balance ${m.bank.balance_display}`);
}
