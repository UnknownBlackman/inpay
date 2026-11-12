import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, CoinIcon, CUR_SYMBOL, DECIMALS, fmtUnits, Logo, MERCHANT_EMOJI, SYMBOL, useConfig, usePoll } from './api';

const money = (minor: string | number | bigint, cur: string) => {
  const v = BigInt(minor);
  return `${CUR_SYMBOL[cur] ?? ''}${(v / 100n).toLocaleString('en-US')}.${(v % 100n).toString().padStart(2, '0')}`;
};
const coin = (amount: string, k: 'near' | 'eth' | 'usdc', frac = 6) => fmtUnits(amount, DECIMALS[k], frac);
const PAID = ['Paid', 'Assigned', 'Settled'];

export function Checkout() {
  const { id } = useParams();
  const cfg = useConfig();
  const [data, loadErr, refresh] = usePoll<any>(`/api/links/${id}`, 2500);
  const [picked, setPicked] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [err, setErr] = useState<string>();
  // what the Pay button is waiting for right now, shown under it (testnet transactions take seconds)
  const [phase, setPhase] = useState<{ step: number; of: number; text: string; sub: string; started: number }>();
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  if (loadErr && !data) return <Frame><p className="error" style={{ maxWidth: 520, margin: '40px auto' }}>This payment link doesn't exist or the server can't be reached. ({loadErr})</p></Frame>;
  if (!data) return <Frame><p className="muted" style={{ textAlign: 'center', padding: 80 }}>Loading the checkout…</p></Frame>;

  const cur = data.merchant.currency;
  const inv = data.invoice;
  const lockedAsset: string | undefined = data.link.invoice?.asset;
  const choice = picked ?? lockedAsset ?? data.options.find((o: any) => o.amount)?.asset ?? 'near';
  const status: string | undefined = inv?.status;
  const isPaid = status && PAID.includes(status);
  const canPay = !inv || status === 'Open' || status === 'Underpaid';
  const lockedIn = inv && status !== 'Open'; // a payment was made: the coin can't change
  const due = inv ? BigInt(inv.amount) - BigInt(inv.paid) : 0n;
  const secs = inv ? Math.max(0, Math.round((inv.deadline - now) / 1000)) : 0;
  const fiat = money(data.link.fiat_minor, cur);
  const quote = data.link.invoice?.quote;

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label); setErr(undefined);
    try { await fn(); refresh(); } catch (e: any) { setErr(e.message); } finally { setBusy(undefined); setPhase(undefined); }
  };
  const pay = (fraction?: number) => run(fraction ? 'Sending 80%…' : 'Paying…', async () => {
    const needInvoice = !inv || lockedAsset !== choice || status === 'Refunded';
    const of = needInvoice ? 2 : 1;
    const opt = data.options.find((o: any) => o.asset === choice);
    const amt = opt?.amount ? `${coin(opt.amount, choice as any, 4)} ${SYMBOL[choice]}` : SYMBOL[choice];
    if (needInvoice) {
      setPhase({ step: 1, of, text: 'Locking your price on NEAR…', sub: `Creating the invoice for ${amt} in the escrow contract`, started: Date.now() });
      await api(`/api/links/${id}/checkout`, { asset: choice });
    }
    setPhase({ step: of, of, text: fraction ? 'Sending 80% to escrow…' : `Sending ${amt} to escrow…`, sub: 'Waiting for NEAR testnet to confirm the transaction', started: Date.now() });
    await api(`/api/links/${id}/pay`, fraction ? { fraction } : {});
  });

  const k = (lockedIn ? lockedAsset : choice) as 'near' | 'eth' | 'usdc';
  const payLabel = busy ?? (isPaid ? '✓ Paid'
    : status === 'Refunded' ? 'Refunded'
    : status === 'Underpaid' && lockedAsset === choice ? `Pay the missing ${coin(due.toString(), k)} ${SYMBOL[k]}`
    : `Pay ${data.options.find((o: any) => o.asset === choice)?.amount ? coin(lockedAsset === choice && inv ? inv.amount : data.options.find((o: any) => o.asset === choice).amount, choice as any, 4) : ''} ${SYMBOL[choice]}`);

  const at = status === 'Settled' ? 5 : status === 'Assigned' ? 3 : status === 'Paid' ? 2 : 1;
  const steps = [
    { t: status === 'Underpaid' ? 'Part of it is in escrow' : isPaid ? `${coin(inv.amount, k, 4)} ${SYMBOL[k]} held in escrow` : 'You pay into escrow', s: 'a contract on NEAR holds the coin', tx: data.link.payments?.[data.link.payments.length - 1]?.tx_url },
    { t: `${quote?.provider ?? 'The best provider'} takes the job`, s: 'its quote was locked before you paid' },
    { t: `${fiat} paid to ${data.merchant.display}'s bank`, s: 'usually about 5 seconds' },
    { t: 'Escrow released to the provider', s: 'only after the bank credit' },
  ];

  return (
    <Frame merchant={data.merchant.name}>
      <div className="co">
        {/* the phone: the same screen the landing page shows */}
        <div className="phone">
          <div className="screen">
            <span className="notch" aria-hidden="true" />
            <div className="merchant"><b aria-hidden="true">{MERCHANT_EMOJI[data.merchant.name] ?? '🛍️'}</b><span>{data.merchant.display}<small>{data.link.memo || 'Payment'}</small></span></div>
            <div className="price">{fiat}</div>
            <div className="sub">{isPaid ? 'Thank you, that\'s paid.' : 'Pick how you want to pay'}</div>
            {data.options.map((o: any) => {
              const mine = inv && lockedAsset === o.asset;
              const amount = mine ? inv.amount : o.amount;
              const prov = mine ? quote?.provider : o.provider, fee = mine ? quote?.spread_bps / 100 : o.fee_pct;
              return (
                <button key={o.asset} type="button" className={`coinrow ${choice === o.asset ? 'on' : ''}`}
                  disabled={!!lockedIn || !o.amount || !!busy} aria-pressed={choice === o.asset} onClick={() => setPicked(o.asset)}>
                  <CoinIcon k={o.asset} />
                  <span><b>{SYMBOL[o.asset]}</b><small>{amount ? `via ${prov} · incl. ${fee}% fee` : 'no provider right now'}</small></span>
                  <span className="amt">{amount ? coin(amount, o.asset) : '–'}</span>
                </button>
              );
            })}
            {inv && canPay && lockedAsset === choice && (
              <div className="lockline"><span className="clock">{Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')}</span>Price locked for this invoice (#{inv.id})</div>
            )}
            {!inv && <div className="lockline">Choosing a coin locks the price for 10 minutes.</div>}
            {data.message && status === 'Underpaid' && <p className="short">{data.message}</p>}
            {data.message && status === 'Refunded' && <p className="short">{data.message}</p>}
            {err && <p className="error" style={{ marginTop: 12 }}>{err}</p>}
            <div className="grow" />
            <button className={`paybtn ${isPaid ? 'done' : ''}`} disabled={!canPay || !!busy} onClick={() => pay()}>{payLabel}</button>
            {phase && (
              <div className="progress" role="status" aria-live="polite">
                <span className="spin" aria-hidden="true" />
                <div><b>{phase.text}</b><small>{phase.sub}</small>
                  <small className="t">Step {phase.step} of {phase.of} · {Math.max(0, Math.round((now - phase.started) / 1000))} s · testnet transactions usually take 3 to 10 seconds</small></div>
              </div>
            )}
            {isPaid && <a className="tomerchant" href={`/dashboard?m=${data.merchant.name}`}>See it on {data.merchant.display}'s dashboard →</a>}
            {canPay && !phase && (!inv || status === 'Open') && (
              <div style={{ textAlign: 'center' }}><button className="demo80" disabled={!!busy} onClick={() => pay(0.8)} title="Demo: send only 80% to see the underpaid flow">Demo: pay only 80%</button></div>
            )}
            <p className="payer">Pays from the demo wallet {data.customer} (a server-held testnet key).<br />
              {Object.entries(data.customer_balances ?? {}).map(([, v]) => v).join(' · ')}</p>
          </div>
        </div>

        {/* beside it: where the money goes, live */}
        <div className="side">
          <h1>Pay {data.merchant.display}</h1>
          <p className="lead">Pay with the crypto you already have. The shop gets paid in its own money, and nobody has to hold a coin they didn't want.</p>
          <div className="gets"><div><span className="label">{data.merchant.display} receives</span><div className="v">{fiat}</div></div><span className="note">in full ✓</span></div>
          <div className="next" aria-live="polite">
            <span className="label">{status ? `What's happening · invoice #${inv.id}` : 'What happens when you pay'}</span>
            <div className="steps">
              {steps.map((x, i) => {
                const n = i + 1, cls = status === 'Settled' || n < at ? 'done' : n === at && status && status !== 'Open' && status !== 'Refunded' ? 'cur' : '';
                return (
                  <div key={i} className={`st ${cls}`}><span className="k">{cls === 'done' ? '✓' : n}</span>
                    <span>{x.t}<small>{x.s}{x.tx && cls === 'done' && <> · <a href={x.tx} target="_blank" rel="noreferrer">on NEAR ↗</a></>}</small></span></div>
                );
              })}
            </div>
          </div>
          {cfg && cfg.mode !== 'near' && <p className="offline-note">Offline demo: this payment settles on an in-memory copy of the escrow contract, not on NEAR testnet. Run <code>npm run setup</code> with your own testnet account to make it real (see the README).</p>}
        </div>
      </div>
    </Frame>
  );
}

function Frame({ children, merchant }: { children: React.ReactNode; merchant?: string }) {
  const cfg = useConfig();
  return (
    <div className="wrap">
      <header className="co-top"><Logo />
        <div className="right">
          <span className={`net ${cfg && cfg.mode !== 'near' ? 'mem' : ''}`}><i />Secure checkout · {cfg && cfg.mode !== 'near' ? 'offline demo' : 'NEAR testnet'}</span>
          <a className="btn btn--ghost" href={merchant ? `/dashboard?m=${merchant}` : '/dashboard'}>Merchant dashboard →</a>
        </div>
      </header>
      {children}
    </div>
  );
}
