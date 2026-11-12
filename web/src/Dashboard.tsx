import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  api, assetKeyOf, CoinIcon, CUR_SYMBOL, DECIMALS, fmtUnits, Logo, MERCHANT_EMOJI, MERCHANT_IDS, StatusPill, SYMBOL,
  useConfig, useCountUp, usePoll,
} from './api';

/** "₹1,676.64" (the currency symbol, no code), from minor units. */
function money(minor: string | number | bigint | null | undefined, cur: string) {
  if (minor == null) return '–';
  const v = BigInt(minor);
  const neg = v < 0n, a = neg ? -v : v;
  return `${neg ? '-' : ''}${CUR_SYMBOL[cur] ?? ''}${(a / 100n).toLocaleString('en-US')}.${(a % 100n).toString().padStart(2, '0')}`;
}
const coinAmount = (amount: string, k: 'near' | 'eth' | 'usdc', frac = 6) => fmtUnits(amount, DECIMALS[k], frac);
const time = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const when = (ts: number) => {
  const d = new Date(ts), today = new Date();
  return d.toDateString() === today.toDateString() ? `today ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : d.toLocaleDateString([], { weekday: 'short' });
};
function greeting() { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; }

export function Dashboard() {
  const cfg = useConfig();
  const [params, setParams] = useSearchParams();
  const m = MERCHANT_IDS.includes(params.get('m') ?? '') ? params.get('m')! : MERCHANT_IDS[0];
  const [data, err, refresh] = usePoll<any>(`/api/merchants/${m}`, 3000);
  const [events] = usePoll<any[]>(`/api/events?merchant=${m}`, 1500);
  const account = cfg?.merchants?.[m]?.bankAccount;
  const [stmt] = usePoll<any>(account ? `/mockbank/statement/${account}` : null, 4000);
  const cur: string = cfg?.merchants?.[m]?.currency ?? data?.bank?.currency ?? '';
  const name: string = cfg?.merchants?.[m]?.display ?? m;

  const linkByInvoice = useMemo(() => {
    const map = new Map<number, any>();
    for (const l of data?.links ?? []) if (l.invoice) map.set(l.invoice.id, l);
    return map;
  }, [data]);
  const invoices: any[] = data?.invoices ?? [];
  const latest = invoices.find((i) => i.status !== 'Settled' && i.status !== 'Refunded' && i.status !== 'Open') ?? invoices[0];
  const quoted = invoices.find((i) => i.agent?.quotes?.length);
  const lastCredit = stmt?.statement?.[stmt.statement.length - 1];
  const fresh = lastCredit && Date.now() - lastCredit.ts < 60 * 60 * 1000;

  const pick = (x: string) => setParams({ m: x });

  return (
    <div className="wrap">
      <header className="top">
        <Logo animated />
        <nav className="switch" aria-label="Merchant">
          {MERCHANT_IDS.map((x) => (
            <button key={x} className={x === m ? 'on' : ''} onClick={() => pick(x)} aria-pressed={x === m}>
              <b aria-hidden="true">{MERCHANT_EMOJI[x]}</b>{cfg?.merchants?.[x]?.display ?? x} <small>{cfg?.merchants?.[x]?.currency}</small>
            </button>
          ))}
        </nav>
        <div className="right">
          <span className={`net ${cfg?.mode === 'near' ? '' : 'mem'}`}><i />{cfg?.mode === 'near' ? 'NEAR testnet' : 'Offline demo'}</span>
          <a className="btn btn--ghost" href={`/bank/${m}`}>Bank statement</a>
          <a className="btn btn--primary" href="#ask" onClick={(e) => { e.preventDefault(); document.getElementById('price')?.focus(); }}>+ New payment link</a>
        </div>
      </header>
      <nav className="mswitch" aria-label="Merchant">
        {MERCHANT_IDS.map((x) => <button key={x} className={x === m ? 'on' : ''} onClick={() => pick(x)}>{MERCHANT_EMOJI[x]} {cfg?.merchants?.[x]?.display ?? x}</button>)}
      </nav>

      <div className="greet">
        <h1>{greeting()}, {name}. <span>Here's your money.</span></h1>
        {fresh && (
          <span className="note">{money(lastCredit.amount, cur)} just landed
            <svg width="44" height="30" viewBox="0 0 44 30" aria-hidden="true"><path d="M3 22 C 14 4, 30 4, 40 14 M32 6 L40 14 L30 18" fill="none" stroke="#FF5A36" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </span>
        )}
      </div>
      {err && !data && <p className="error">Can't reach the INPay server: {err}</p>}
      {cfg && cfg.mode !== 'near' && (
        <p className="offline-note">Offline demo: payments here settle on an in-memory copy of the escrow contract, not on NEAR testnet. To make them real, run <code>npm run setup</code> with your own testnet account (about 20 testnet NEAR). See “Offline demo or real testnet?” in the README.</p>
      )}

      <div className="grid">
        <Balance data={data} stmt={stmt} cur={cur} m={m} />
        <Ask m={m} cur={cur} onMade={refresh} />
        <Live inv={latest} link={latest && linkByInvoice.get(latest.id)} cfg={cfg} cur={cur} />
        <Quotes inv={quoted} cfg={cfg} cur={cur} />
        <AgentLog events={events} />
        <Payments invoices={invoices} linkByInvoice={linkByInvoice} cfg={cfg} cur={cur} />
      </div>
      <div style={{ height: 40 }} />
    </div>
  );
}

function Balance({ data, stmt, cur, m }: any) {
  const minor = Number(data?.bank?.balance ?? 0);
  const shown = useCountUp(minor);
  const whole = Math.floor(shown / 100), frac = Math.round(shown % 100).toString().padStart(2, '0');
  // money in per day, the last seven days
  const days = useMemo(() => {
    const out: { label: string; sum: number }[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i);
      const next = new Date(d); next.setDate(d.getDate() + 1);
      const sum = (stmt?.statement ?? []).filter((t: any) => t.ts >= d.getTime() && t.ts < next.getTime()).reduce((s: number, t: any) => s + Number(t.amount), 0);
      out.push({ label: i === 0 ? 'Today' : d.toLocaleDateString([], { weekday: 'short' }), sum });
    }
    return out;
  }, [stmt]);
  const max = Math.max(1, ...days.map((d) => d.sum));
  const today = days[6].sum;
  const todayCount = (stmt?.statement ?? []).filter((t: any) => new Date(t.ts).toDateString() === new Date().toDateString()).length;
  return (
    <section className="card bal span5" aria-label="Bank balance">
      <div className="head"><span className="label">In your bank account</span><span className="acct">{data?.bank?.account ?? '…'} · simulated</span></div>
      <div className="num">{CUR_SYMBOL[cur] ?? ''}{whole.toLocaleString('en-US')}<small>.{frac}</small></div>
      <div className="today">{today > 0 ? `+${money(today, cur)} today · from ${todayCount} payment${todayCount === 1 ? '' : 's'}` : 'Nothing in yet today'}</div>
      <div className="bars" aria-hidden="true">{days.map((d, i) => <span key={i} className={i === 6 ? 'on' : ''} style={{ height: `${Math.max(5, (d.sum / max) * 100)}%` }} />)}</div>
      <div className="days" aria-hidden="true">{days.map((d, i) => i === 6 ? <b key={i}>{d.label}</b> : <span key={i}>{d.label}</span>)}</div>
      <a className="stmt" href={`/bank/${m}`}>See the bank statement →</a>
    </section>
  );
}

function Ask({ m, cur, onMade }: { m: string; cur: string; onMade: () => void }) {
  const [price, setPrice] = useState('');
  const [memo, setMemo] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [made, setMade] = useState<string>();
  const [copied, setCopied] = useState(false);
  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(undefined);
    try {
      const l = await api('/api/links', { merchant: m, price, memo });
      setMade(`${location.origin}/pay/${l.id}`); setPrice(''); setMemo(''); onMade();
    } catch (x: any) { setErr(x.message); } finally { setBusy(false); }
  };
  return (
    <section className="card mk span4" id="ask">
      <h2>Ask for a payment</h2>
      <form onSubmit={create}>
        <div className="field"><label htmlFor="price">Price, in your money</label>
          <div className="in"><input id="price" inputMode="decimal" placeholder={cur === 'EUR' ? '4.50' : cur === 'KES' ? '650' : '420.00'} value={price} onChange={(e) => setPrice(e.target.value)} /><span className="cur">{cur}</span></div></div>
        <div className="field"><label htmlFor="memo">What it's for</label>
          <div className="in sm"><input id="memo" placeholder={cur === 'EUR' ? 'Inner tube repair' : cur === 'KES' ? 'Shirt alteration' : 'Masala dosa and filter coffee x2'} value={memo} onChange={(e) => setMemo(e.target.value)} /></div></div>
        <button className="btn btn--primary" disabled={!price || busy}>{busy ? 'Creating…' : 'Create payment link →'}</button>
      </form>
      {err && <p className="error" style={{ marginTop: 12 }}>{err}</p>}
      {made && (
        <div className="newlink">🔗 <a href={made} target="_blank" rel="noreferrer">{made.replace(/^https?:\/\//, '')}</a>
          <button onClick={() => { navigator.clipboard?.writeText(made); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? 'Copied' : 'Copy'}</button></div>
      )}
    </section>
  );
}

function Live({ inv, link, cfg, cur }: any) {
  if (!inv) return (
    <section className="card live span3"><span className="label">Happening now</span><h3>No payments yet</h3>
      <p className="empty" style={{ marginTop: 10 }}>Create a payment link and open it to see a payment move through here.</p></section>
  );
  const k = assetKeyOf(inv.asset, cfg);
  const amt = `${coinAmount(inv.amount, k, 4)} ${SYMBOL[k]}`;
  const fiat = money(inv.fiat_amount ?? link?.fiat_minor, cur);
  const order = ['Paid', 'Assigned', 'Settled'];
  const at = inv.status === 'Settled' ? 4 : inv.status === 'Assigned' ? 3 : inv.status === 'Paid' ? 2 : 1;
  const title = inv.status === 'Settled' ? `${amt} became ${fiat} in your bank`
    : inv.status === 'Refunded' ? `${amt} went back to the customer`
    : order.includes(inv.status) ? `${amt} is on its way to becoming ${fiat}` : `Waiting for ${amt}`;
  const steps = [
    { t: inv.status === 'Underpaid' ? 'Part paid, waiting for the rest' : 'Paid into escrow', s: 'on NEAR' },
    { t: inv.provider ? `${inv.provider.split('.')[0]} picked` : 'Provider picked', s: 'locked before payment' },
    { t: 'Paying your bank', s: 'usually about 5 seconds' },
    { t: 'Escrow released', s: 'only after the bank credit' },
  ];
  return (
    <section className="card live span3" aria-live="polite">
      <span className="label">Happening now · invoice #{inv.id}</span>
      <h3>{title}</h3>
      {inv.status !== 'Refunded' && (
        <div className="steps">
          {steps.map((x, i) => {
            const n = i + 1, cls = n < at || at === 4 ? 'done' : n === at ? 'cur' : '';
            return <div key={i} className={`st ${cls}`}><span className="k">{cls === 'done' ? '✓' : n}</span><span>{x.t}<small>{x.s}</small></span></div>;
          })}
        </div>
      )}
    </section>
  );
}

function Quotes({ inv, cfg, cur }: any) {
  if (!inv) return (
    <section className="card qt span7"><h2>Who offered the best deal</h2>
      <p className="sub">When a customer picks a coin, every payout provider quotes for your full price. The cheapest one shows up here.</p></section>
  );
  const k = assetKeyOf(inv.asset, cfg);
  const quotes: any[] = inv.agent.quotes;
  const failed = new Set<string>(inv.agent.failed ?? []);
  const winner = inv.agent.current?.provider ?? inv.agent.locked?.provider;
  const target = quotes[0]?.kind === 'fiat_target';
  const val = (q: any) => target ? Number(BigInt(q.amount) / 10n ** BigInt(Math.max(0, DECIMALS[k] - 9))) : Number(q.fiat_amount);
  const vals = quotes.map(val);
  const best = target ? Math.min(...vals) : Math.max(...vals), worst = target ? Math.max(...vals) : Math.min(...vals);
  const saved = quotes.length > 1 && best > 0 ? Math.round((Math.abs(worst - best) / (target ? best : worst)) * 1000) / 10 : 0;
  const names = ['swiftcash', 'payrail', 'quickfx'];
  const fiat = money(inv.fiat_amount ?? quotes[0]?.fiat_amount, cur);
  return (
    <section className="card qt span7">
      <div className="head"><div><h2>Who offered the best deal</h2>
        <p className="sub">{target ? `Every provider quoted how much ${SYMBOL[k]} it needed to pay you the full ${fiat}. Fewer coins wins.` : `The coin was already in escrow, so providers quoted what they would pay for it. Most money wins.`}</p></div>
        <StatusPill status={inv.status} /></div>
      <div className="qcards">
        {names.map((p) => {
          const q = quotes.find((x) => x.provider === p);
          const accepts = cfg?.providers?.[p]?.assets?.includes(k);
          if (!q) return (
            <div key={p} className="q na"><div className="nm">{p}</div><div className="v">–</div>
              <div className="m">{accepts === false ? `doesn't take ${SYMBOL[k]}` : 'no quote'}</div></div>
          );
          const v = val(q), pct = target ? best / v : v / best;
          const isWin = p === winner && !failed.has(p);
          return (
            <div key={p} className={`q ${isWin ? 'win' : ''} ${failed.has(p) ? 'failed' : ''}`}>
              <div className="nm">{p}{isWin && <em>picked</em>}{failed.has(p) && <em className="bad">no payout</em>}</div>
              <div className="v">{target ? coinAmount(q.amount, k) : money(q.fiat_amount, cur)}</div>
              <div className="m">{target ? SYMBOL[k] : `for ${coinAmount(q.amount, k, 4)} ${SYMBOL[k]}`} · {q.spread_bps / 100}% fee · ~{q.eta_seconds} s</div>
              <div className="bar"><i style={{ width: `${Math.round(pct * 100)}%` }} /></div>
            </div>
          );
        })}
      </div>
      {saved > 0 && <div className="save"><span className="hand">{target ? `your customer saved ${saved}%` : `you got ${saved}% more`}</span><span>compared with the most expensive offer</span></div>}
    </section>
  );
}

const ICON: Record<string, [string, string]> = {
  settled: ['g', '✓'], bank_credit: ['g', '₹'], assigned: ['b', '→'], reassigned: ['c', '↻'], quotes: ['y', '≈'],
  paid: ['', '•'], payment: ['', '•'], invoice: ['', '+'], link: ['', '+'], underpaid: ['c', '!'], timeout: ['c', '!'],
  refunded: ['c', '↩'], error: ['c', '!'], payout_response: ['', '…'], bank_mismatch: ['c', '!'], no_quotes: ['c', '!'],
};

function AgentLog({ events }: { events?: any[] }) {
  const list = (events ?? []).slice().reverse().slice(0, 30);
  return (
    <section className="card log span5" aria-label="What your agent did">
      <div className="head"><h2>What your agent did</h2><span className="livebadge"><i />Live</span></div>
      {!list.length && <p className="empty" style={{ marginTop: 14 }}>Nothing yet. Every quote, payout and release will show up here, with its transaction.</p>}
      <div className="tl" aria-live="polite">
        {list.map((e) => {
          const [c, g] = ICON[e.kind] ?? ['', '•'];
          return (
            <div key={e.seq} className="ev"><span className={`d ${c}`} aria-hidden="true">{g}</span>
              <div><p>{e.friendly ?? e.text}</p>
                <div className="meta"><span>{time(e.ts)}</span>{e.tx_url && <a href={e.tx_url} target="_blank" rel="noreferrer">on-chain ↗</a>}</div></div></div>
          );
        })}
      </div>
    </section>
  );
}

const FILTERS: [string, (s: string) => boolean][] = [
  ['All', () => true], ['In your bank', (s) => s === 'Settled'], ['In progress', (s) => ['Open', 'Underpaid', 'Paid', 'Assigned'].includes(s)], ['Refunded', (s) => s === 'Refunded'],
];

function Payments({ invoices, linkByInvoice, cfg, cur }: any) {
  const [f, setF] = useState(0);
  const [q, setQ] = useState('');
  const rows = invoices.filter((i: any) => FILTERS[f][1](i.status))
    .filter((i: any) => !q || `${linkByInvoice.get(i.id)?.memo ?? ''} #${i.id}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <section className="card pay span12">
      <div className="head"><h2>Payments</h2>
        <div className="tabs" role="tablist">{FILTERS.map(([n], i) => <button key={n} role="tab" aria-selected={f === i} className={f === i ? 'on' : ''} onClick={() => setF(i)}>{n}</button>)}</div>
        <input className="search" placeholder="Search payments…" aria-label="Search payments" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <table>
        <thead><tr><th>Payment</th><th>You get</th><th>They paid</th><th>Provider</th><th>Status</th><th>On-chain</th></tr></thead>
        <tbody>
          {rows.map((i: any, n: number) => {
            const k = assetKeyOf(i.asset, cfg), l = linkByInvoice.get(i.id);
            const tx = l?.payments?.[l.payments.length - 1]?.tx_url ?? l?.invoice?.tx_url;
            return (
              <tr key={i.id} className={n === 0 && f === 0 && !q ? 'hl' : ''}>
                <td><div className="who"><CoinIcon k={k} /><span><b>{l?.memo || `Payment #${i.id}`}</b><small>#{i.id} · {when(i.created_at)}</small></span></div></td>
                <td className="big">{money(i.fiat_amount ?? l?.fiat_minor, cur)}</td>
                <td className="num">{i.paid !== '0' ? `${coinAmount(i.paid, k)} ${SYMBOL[k]}` : '–'}</td>
                <td>{i.provider ? i.provider.split('.')[0] : i.status === 'Paid' ? 'picking…' : '–'}</td>
                <td><StatusPill status={i.status} /></td>
                <td>{tx ? <a className="tx" href={tx} target="_blank" rel="noreferrer">{tx.split('/').pop()!.slice(0, 8)} ↗</a> : <span className="muted">–</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!rows.length && <p className="pay foot">No payments here yet.</p>}
    </section>
  );
}
