import { useParams } from 'react-router-dom';
import { CUR_SYMBOL, Logo, MERCHANT_EMOJI, useConfig, useCountUp, usePoll } from './api';

const money = (minor: string | number, cur: string) => {
  const v = BigInt(minor);
  return `${CUR_SYMBOL[cur] ?? ''}${(v / 100n).toLocaleString('en-US')}.${(v % 100n).toString().padStart(2, '0')}`;
};

export function Bank() {
  const { merchant } = useParams();
  const cfg = useConfig();
  const info = cfg?.merchants?.[merchant!];
  const [data, err] = usePoll<any>(info ? `/mockbank/statement/${info.bankAccount}` : null, 2500);
  const cur = data?.currency ?? info?.currency ?? '';
  const shown = useCountUp(Number(data?.balance ?? 0));
  const rows = (data?.statement ?? []).slice().reverse();
  return (
    <div className="wrap">
      <header className="top"><Logo /><div className="right"><a className="btn btn--ghost" href={`/dashboard?m=${merchant}`}>← Back to the dashboard</a></div></header>
      <p className="bank-banner">🏦 Simulated bank. This is a pretend account, so INPay's demo can show cash arriving. No real money moves.</p>
      <div className="bank-grid">
        <section className="card bal" aria-label="Balance">
          <div className="head"><span className="label">{MERCHANT_EMOJI[merchant!]} {info?.display} · current account</span><span className="acct">{info?.bankAccount}</span></div>
          <div className="num">{CUR_SYMBOL[cur] ?? ''}{Math.floor(shown / 100).toLocaleString('en-US')}<small>.{Math.round(shown % 100).toString().padStart(2, '0')}</small></div>
          <div className="today">{rows.length} payout{rows.length === 1 ? '' : 's'} received from offramp providers</div>
          <p style={{ marginTop: 'auto', paddingTop: 24, color: '#a8adb7', fontSize: 14 }}>Every credit here came from a provider paying out a crypto payment. Only after it lands does INPay release the coin from escrow.</p>
        </section>
        <section className="receipt" aria-label="Statement">
          <div className="t">Statement</div>
          <div className="c">{info?.display} · {info?.bankAccount} · {cur}</div>
          {err && <p className="error">{err}</p>}
          {!rows.length && <p className="muted" style={{ textAlign: 'center', padding: '20px 0' }}>Nothing yet. Take a payment and the payout lands here.</p>}
          {rows.map((t: any) => (
            <div key={t.txn_id} className="l">
              <span>{t.from} paid out</span><b>+{money(t.amount, t.currency)}</b>
              <small>{new Date(t.ts).toLocaleString()} · {t.txn_id} · ref {t.ref}{t.restored ? ' · restored from the on-chain record' : ''}</small><small>bal. {money(t.balance_after, t.currency)}</small>
            </div>
          ))}
          <div className="tot"><span>Balance</span><span>{data ? money(data.balance, cur) : '…'}</span></div>
        </section>
      </div>
    </div>
  );
}
