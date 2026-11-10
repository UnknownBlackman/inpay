import { Link, useParams } from 'react-router-dom';
import { fmtMinor, useConfig, usePoll } from './api';

export function Bank() {
  const { merchant } = useParams();
  const cfg = useConfig();
  const account = cfg?.merchants?.[merchant!]?.bankAccount;
  const [data, err] = usePoll<any>(account ? `/mockbank/statement/${account}` : null, 2000);
  return (
    <div className="bank">
      <div className="sim-banner">Simulated bank. Not a real bank account; balances are local-currency test numbers.</div>
      <div className="card">
        <div className="muted">{cfg?.merchants?.[merchant!]?.display} · account {account}</div>
        <div className="big">{data ? fmtMinor(data.balance, data.currency) : '…'}</div>
        <Link to={`/?m=${merchant}`}>← merchant dashboard</Link>
      </div>
      <div className="card">
        <div className="label">Statement</div>
        {err && <div className="error">{err}</div>}
        {!data?.statement?.length && <div className="muted">No transactions yet.</div>}
        <table className="statement">
          <thead><tr><th>Time</th><th>Bank ref</th><th>From</th><th>Payment ref</th><th className="num">Amount</th><th className="num">Balance</th></tr></thead>
          <tbody>
            {data?.statement?.slice().reverse().map((t: any) => (
              <tr key={t.txn_id}>
                <td>{new Date(t.ts).toLocaleString()}</td>
                <td><code>{t.txn_id}</code></td>
                <td>{t.from}</td>
                <td><code>{t.ref}</code></td>
                <td className="num">+{fmtMinor(t.amount, t.currency)}</td>
                <td className="num">{fmtMinor(t.balance_after, t.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
