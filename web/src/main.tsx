import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';
import { Dashboard } from './Dashboard';
import { Checkout } from './Checkout';
import { Bank } from './Bank';
import { useConfig } from './api';
import './styles.css';

function Shell({ children }: { children: React.ReactNode }) {
  const cfg = useConfig();
  return (
    <>
      <header className="top">
        <Link to="/" className="brand">IN<span>Pay</span></Link>
        <span className="tagline">They pay in crypto. You get paid in cash.</span>
        <span className="spacer" />
        {cfg && (
          <span className={`badge ${cfg.mode}`}>
            {cfg.mode === 'near' ? (
              <>NEAR testnet · <a href={`${cfg.explorer}/address/${cfg.contract}`} target="_blank" rel="noreferrer">{cfg.contract}</a></>
            ) : 'in-memory chain (no testnet keys)'}
          </span>
        )}
      </header>
      <main>{children}</main>
      <footer>
        Real on NEAR testnet: escrow contract, payments (NEAR, wETH, USDC test tokens), provider assignment, release, refunds.
        Real data: CoinGecko prices and open.er-api.com FX{cfg ? ` (now: ${cfg.rates.source})` : ''}.
        <b> Simulated:</b> the three offramp providers and the merchants' banks. wETH and USDC are testnet stand-in tokens.
        Demo payer uses a server-held testnet key.
      </footer>
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Shell>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/pay/:id" element={<Checkout />} />
          <Route path="/bank/:merchant" element={<Bank />} />
        </Routes>
      </Shell>
    </BrowserRouter>
  </StrictMode>,
);
