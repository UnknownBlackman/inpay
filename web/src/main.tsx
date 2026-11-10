import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Dashboard } from './Dashboard';
import { Checkout } from './Checkout';
import { Bank } from './Bank';
import './styles.css';

// The landing page is static (web/index.html at /). This app serves the three working pages.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/pay/:id" element={<Checkout />} />
        <Route path="/bank/:merchant" element={<Bank />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
