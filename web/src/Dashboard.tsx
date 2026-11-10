import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, assetKeyOf, fmtAssetAmount, fmtMinor, SYMBOL, TxLink, useConfig, usePoll } from './api';

const MERCHANTS = ['bengaluru-cafe', 'berlin-bikes', 'nairobi-tailor'];
const STATUS_HELP: Record<string, string> = {
  Open: 'waiting for the customer',
  Underpaid: 'partly paid, waiting for top-up',
  Paid: 'crypto in escrow, collecting quotes',
  Assigned: 'provider paying out to your bank',
  Settled: 'cash in your bank, crypto released to provider',
  Refunded: 'returned to the customer',
};

export function Dashboard() {
  const cfg = useConfig();
  const [params, setParams] = useSearchParams();
  const m = params.get('m') ?? MERCHANTS[0];
  const [data] = usePoll<any>(`/api/merchants/${m}`, 3000);
  const [events] = usePoll<any[]>(`/api/events?merchant=${m}`, 1000);
  const [price, setPrice] = useState('');
  const [memo, setMemo] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();

  const create = async () => {
    setBusy(true); setErr(undefined);
    try { await api('/api/links', { merchant: m, price, memo }); setPrice(''); setMemo(''); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  const currency = cfg?.merchants?.[m]?.currency ?? '';
  const latest = data?.invoices?.find((i: any) => i.agent?.quotes?.length);

  return (
    <div className="dash">
      <nav className="merchants">
        {MERCHANTS.map((x) => (
          <button key={x} className={x === m ? 'on' : ''} onClick={() => setParams({ m: x })}>
            {cfg?.merchants?.[x]?.display ?? x} <small>{cfg?.merchants?.[x]?.currency}</small>
          </button>
        ))}
      </nav>

      <section className="grid">
        <div className="card balance">
          <div className="label">Bank balance <Link to={`/bank/${m}`}>(simulated bank statement →)</Link></div>
          <div className="big">{data ? fmtMinor(data.bank.balance, data.bank.currency) : '…'}</div>
          <div className="muted">Account {data?.bank.account} · merchant never holds crypto · agent account{' '}
            {cfg?.explorer ? <a href={`${cfg.explorer}/address/${data?.account_id}`} target="_blank" rel="noreferrer">{data?.account_id}</a> : data?.account_id}
          </div>
        </div>

        <div className="card">
          <div className="label">Create payment link</div>
          <div className="row">
            <input value={price} onChange={(e) => setPrice(e.target.value)} placeholder={currency === 'INR' ? '420' : currency === 'EUR' ? '4.50' : '650'} inputMode="decimal" />
            <span className="cur">{currency}</span>
          </div>
          <input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="What is it for? (optional)" />
          <button className="primary" disabled={!price || busy} onClick={create}>{busy ? 'Creating…' : 'Create payment link'}</button>
          {err && <div className="error">{err}</div>}
          <div className="muted">Priced in {currency}. The customer chooses NEAR, ETH or USDC at checkout. Keep it around 5 USD on testnet.</div>
        </div>
      </section>

      {latest && <Quotes inv={latest} cfg={cfg} />}

      <section className="grid">
        <div className="card">
          <div className="label">Payment links</div>
          {!data?.links?.length && <div className="muted">No links yet.</div>}
          <ul className="links">
            {data?.links?.map((l: any) => {
              const inv = l.invoice && data.invoices.find((i: any) => i.id === l.invoice.id);
              return (
                <li key={l.id}>
                  <Link to={`/pay/${l.id}`} target="_blank">/pay/{l.id}</Link>
                  <b>{fmtMinor(l.fiat_minor, l.currency)}</b>
                  <span className="muted">{l.memo}</span>
                  {inv ? <span className={`status ${inv.status}`}>{inv.status}</span> : <span className="status">unpaid</span>}
                </li>
              );
            })}
          </ul>
        </div>

        <div className="card">
          <div className="label">On-chain invoices (escrow contract)</div>
          {!data?.invoices?.length && <div className="muted">None yet.</div>}
          <table className="invoices">
            <tbody>
              {data?.invoices?.map((i: any) => (
                <tr key={i.id}>
                  <td>#{i.id}</td>
                  <td>{fmtAssetAmount(i.amount, i.asset, cfg)}</td>
                  <td><span className={`status ${i.status}`} title={STATUS_HELP[i.status]}>{i.status}</span></td>
                  <td>{i.fiat_amount ? fmtMinor(i.fiat_amount, i.fiat_currency) : ''}</td>
                  <td className="muted">{i.provider?.split('.')[0] ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card log">
        <div className="label">Agent event log (live)</div>
        {!events?.length && <div className="muted">Nothing yet. Create a payment link and open it.</div>}
        <ol>
          {events?.slice().reverse().map((e) => (
            <li key={e.seq} className={`ev ${e.kind}`}>
              <time>{new Date(e.ts).toLocaleTimeString()}</time>
              <span className="kind">{e.kind}</span>
              <span className="text">{e.friendly ?? e.text}</span>
              <TxLink url={e.tx_url} />
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

function Quotes({ inv, cfg }: { inv: any; cfg: any }) {
  const asset = assetKeyOf(inv.asset, cfg);
  const names = ['swiftcash', 'payrail', 'quickfx'];
  const quotes = inv.agent.quotes as any[];
  const failed = new Set<string>(inv.agent.failed ?? []);
  const winner = inv.agent.current?.provider;
  return (
    <section className="card">
      <div className="label">
        Quotes for invoice #{inv.id} · {quotes[0]?.kind === 'fiat_target'
          ? 'locked at checkout, before payment: least crypto for the full price wins'
          : `${fmtAssetAmount(inv.amount, inv.asset, cfg)} → ${inv.fiat_currency ?? ''}: most fiat wins`}
      </div>
      <div className="quotes">
        {names.map((p) => {
          const q = quotes.find((x) => x.provider === p);
          const pc = cfg?.providers?.[p];
          const cls = !q ? 'na' : failed.has(p) ? 'failed' : p === winner ? 'winner' : '';
          return (
            <div key={p} className={`quote ${cls}`}>
              <div className="pname">{p}{p === winner && !failed.has(p) && <span className="tag">winner</span>}{failed.has(p) && <span className="tag bad">failed</span>}</div>
              {q ? (
                <>
                  {q.kind === 'fiat_target' ? (
                    <>
                      <div className="fiat">{fmtAssetAmount(q.amount, q.asset === 'near' ? 'near' : cfg?.tokens?.[q.asset], cfg)}</div>
                      <div className="muted">to pay {fmtMinor(q.fiat_amount, q.currency)}</div>
                    </>
                  ) : (
                    <div className="fiat">{fmtMinor(q.fiat_amount, q.currency)}</div>
                  )}
                  <div className="muted">spread {(pc?.spreadBps ?? 0) / 100}% · eta {q.eta_seconds}s</div>
                </>
              ) : (
                <div className="muted">does not accept {SYMBOL[asset]}<br />(accepts {pc?.assets?.map((a: string) => SYMBOL[a]).join(', ')})</div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
