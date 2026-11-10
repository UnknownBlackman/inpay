import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, fmtAssetAmount, SYMBOL, TxLink, useConfig, usePoll } from './api';

const STEPS = ['Open', 'Paid', 'Assigned', 'Settled'];
const EXPLAIN: Record<string, string> = {
  Open: 'Invoice created on-chain. Waiting for your payment.',
  Underpaid: 'Partly paid. Send the rest before the deadline or it is refunded.',
  Paid: 'Payment received and held in escrow. The merchant’s agent is collecting offramp quotes.',
  Assigned: 'An offramp provider is paying the merchant in local currency.',
  Settled: 'Done. The merchant has been paid in cash; the crypto was released to the provider.',
  Refunded: 'The invoice expired and your payment was refunded.',
};

export function Checkout() {
  const { id } = useParams();
  const cfg = useConfig();
  const [data, loadErr, refresh] = usePoll<any>(`/api/links/${id}`, 2500);
  const [picked, setPicked] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [err, setErr] = useState<string>();
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  if (loadErr && !data) return <div className="card error">{loadErr}</div>;
  if (!data) return <div className="card">Loading…</div>;

  const inv = data.invoice;
  const asset = data.link.invoice?.asset as string | undefined;
  const choice = picked ?? asset ?? 'near';
  const canPay = !inv || inv.status === 'Open' || inv.status === 'Underpaid';
  const locked = inv && inv.status !== 'Open';

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label); setErr(undefined);
    try { await fn(); refresh(); } catch (e: any) { setErr(e.message); } finally { setBusy(undefined); }
  };
  const pay = (fraction?: number) => run(fraction ? 'Paying 80%…' : 'Paying…', async () => {
    if (!inv || data.link.invoice.asset !== choice) await api(`/api/links/${id}/checkout`, { asset: choice });
    await api(`/api/links/${id}/pay`, fraction ? { fraction } : {});
  });

  const secsLeft = inv ? Math.max(0, Math.round((inv.deadline - now) / 1000)) : 0;
  const due = inv ? BigInt(inv.amount) - BigInt(inv.paid) : 0n;

  return (
    <div className="checkout">
      <div className="card">
        <div className="muted">Pay {data.merchant.display}</div>
        <div className="big">{data.price_display}</div>
        {data.link.memo && <div>{data.link.memo}</div>}
      </div>

      <div className="card">
        <div className="label">Pay with</div>
        <div className="assets">
          {data.options.map((o: any) => {
            const mine = inv && asset === o.asset;
            return (
              <button key={o.asset} disabled={!!locked || !o.amount} className={`asset ${choice === o.asset ? 'on' : ''}`} onClick={() => setPicked(o.asset)}>
                <b>{SYMBOL[o.asset]}</b>
                <span className="amt">{mine ? fmtAssetAmount(inv.amount, inv.asset, cfg) : o.display}</span>
                {(mine || o.provider) && (
                  <small>
                    via {mine ? data.link.invoice.quote.provider : o.provider} · incl. {mine ? data.link.invoice.quote.spread_bps / 100 : o.fee_pct}% conversion fee
                  </small>
                )}
                <small>{o.label}</small>
              </button>
            );
          })}
        </div>
        <div className="muted">
          {inv && asset === choice
            ? <>Locked: {data.link.invoice.quote.provider} pays {data.merchant.display} the full {data.price_display}; you pay exactly this amount (invoice #{inv.id}).{' '}
                {inv.status === 'Open' || inv.status === 'Underpaid' ? `Valid for ${Math.floor(secsLeft / 60)}:${String(secsLeft % 60).padStart(2, '0')}.` : ''}</>
            : <>Each amount is the best offramp quote that pays the merchant the full {data.price_display} ({data.rates_source} rates).
                Choosing an asset locks that quote and creates an on-chain invoice for exactly that amount, valid 10 minutes.</>}
        </div>

        {canPay && (
          <div className="row pay">
            <button className="primary" disabled={!!busy} onClick={() => pay()}>
              {busy ?? (inv?.status === 'Underpaid' && asset === choice ? `Pay remaining ${fmtAssetAmount(due.toString(), inv.asset, cfg)}` : `Pay with ${SYMBOL[choice]}`)}
            </button>
            {(!inv || inv.status === 'Open') && (
              <button className="ghost" disabled={!!busy} onClick={() => pay(0.8)} title="Demo: send only 80% to show the Underpaid flow">Pay only 80% (demo)</button>
            )}
          </div>
        )}
        {err && <div className="error">{err}</div>}
        <div className="muted small">
          Payer: demo customer <code>{data.customer}</code> (server-held testnet key; demo convenience only).
          Balance: {Object.entries(data.customer_balances ?? {}).map(([k, v]) => v).join(' · ')}
        </div>
      </div>

      {inv && (
        <div className="card">
          <div className="label">Status</div>
          <div className="steps">
            {STEPS.map((s) => (
              <span key={s} className={`step ${STEPS.indexOf(inv.status) >= STEPS.indexOf(s) ? 'done' : ''} ${inv.status === s ? 'cur' : ''}`}>{s}</span>
            ))}
          </div>
          <p><span className={`status ${inv.status}`}>{inv.status}</span> {EXPLAIN[inv.status]}</p>
          {data.message && inv.status !== 'Settled' && <p className="notice">{data.message}</p>}
          <div className="muted">
            Paid {fmtAssetAmount(inv.paid, inv.asset, cfg)} of {fmtAssetAmount(inv.amount, inv.asset, cfg)}
            {inv.provider && <> · provider {inv.provider.split('.')[0]}</>}
          </div>
          <div className="txs">
            <TxLink url={data.link.invoice?.tx_url} label="invoice created" />
            {data.link.payments.map((p: any, i: number) => <TxLink key={p.tx} url={p.tx_url} label={`payment ${i + 1}`} />)}
          </div>
        </div>
      )}
    </div>
  );
}
