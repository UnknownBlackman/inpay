// One process: mock bank + three providers + merchant agents + checkout API (+ web in dev).
import express from 'express';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import {
  ASSETS, ASSET_KEYS, CURRENCIES, EXPLORER, MERCHANTS, MERCHANT_NAMES, PROVIDERS, PROVIDER_NAMES, timings,
  type AssetKey, type MerchantName, type ProviderName,
} from './config.ts';
import { convert, fmtAsset, fmtFiat, parseUnits } from './pricing.ts';
import { getRates } from './rates.ts';
import { MockBank } from './bank.ts';
import { Provider } from './providers.ts';
import { MerchantAgent } from './agent.ts';
import type { Quote } from './auction.ts';
import { EventLog } from './events.ts';
import { JsonStore } from './store.ts';
import { llmEnabled } from './llm.ts';
import type { Chain } from './chain/types.ts';

export interface Accounts {
  merchants: Record<MerchantName, string>;
  customer: string;
  providers: Record<ProviderName, string>;
}

export interface Link {
  id: string;
  merchant: MerchantName;
  currency: string;
  fiat_minor: string;
  memo: string;
  created_at: number;
  invoice?: {
    id: number; asset: AssetKey; amount: string; tx: string; tx_url?: string; rates_source: string;
    /** the provider quote locked at checkout, before payment */
    quote: { quote_id: string; provider: string; fiat_amount: string; spread_bps: number; valid_until: number };
  };
  payments: { tx: string; tx_url?: string; amount: string; ts: number }[];
}

export function createApp(opts: { chain: Chain; accounts: Accounts; stateDir: string | null }) {
  const { chain, accounts } = opts;
  let baseUrl = '';
  const getBase = () => baseUrl;
  const log = new EventLog(opts.stateDir);
  const bank = new MockBank(opts.stateDir, () => `${baseUrl}/agent/bank-webhook`);
  const links = new JsonStore<{ links: Record<string, Link> }>(opts.stateDir, 'links', () => ({ links: {} }));
  const messages = new Map<number, string>();
  const providers = Object.fromEntries(PROVIDER_NAMES.map((p) => [p, new Provider(p, accounts.providers[p], chain, bank)])) as Record<ProviderName, Provider>;
  const agents = Object.fromEntries(MERCHANT_NAMES.map((m) => [m, new MerchantAgent({
    chain, merchant: m, accountId: accounts.merchants[m], currency: MERCHANTS[m].currency, bankAccount: MERCHANTS[m].bankAccount,
    providerAccounts: accounts.providers, baseUrl: getBase, log, messages,
  })])) as Record<MerchantName, MerchantAgent>;

  const app = express();
  app.use(express.json());
  // for the host's health check: answers at once, touches no chain or rate API
  app.get('/healthz', (_req, res) => { res.json({ ok: true, mode: chain.kind }); });
  const wrap = (fn: (req: express.Request, res: express.Response) => Promise<unknown>) =>
    (req: express.Request, res: express.Response) => fn(req, res).catch((e) => res.status(e.status ?? 500).json({ error: e.message }));
  const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

  app.use('/mockbank', bank.router()); // simulated bank API: POST /mockbank/credit, GET /mockbank/statement/:account
  for (const p of PROVIDER_NAMES) app.use(`/providers/${p}`, providers[p].router());

  app.post('/agent/bank-webhook', wrap(async (req, res) => {
    const results = await Promise.all(MERCHANT_NAMES.map((m) => agents[m].onBankCredit(req.body)));
    res.json({ handled: results.some(Boolean) });
  }));

  // ------------------------------------------------------------ dashboard API
  app.get('/api/config', wrap(async (_req, res) => {
    const rates = await getRates();
    res.json({
      mode: chain.kind, contract: chain.contractId, explorer: chain.kind === 'near' ? EXPLORER : null,
      accounts, merchants: MERCHANTS, providers: PROVIDERS, assets: ASSETS, tokens: { eth: chain.assetId('eth'), usdc: chain.assetId('usdc') },
      rates, llm: llmEnabled, fail_provider: process.env.FAIL_PROVIDER ?? null,
      payout_timeout_s: Math.round(timings().payoutTimeoutMs / 1000 / timings().scale),
    });
  }));

  app.get('/api/events', (req, res) => {
    res.json(log.list(req.query.merchant as string | undefined, Number(req.query.since ?? 0)));
  });

  app.get('/api/merchants/:m', wrap(async (req, res) => {
    const m = req.params.m as MerchantName;
    if (!MERCHANTS[m]) throw fail(404, 'unknown merchant');
    const acct = bank.get(MERCHANTS[m].bankAccount);
    const invoices = await chain.getInvoices(accounts.merchants[m]);
    const myLinks = Object.values(links.data.links).filter((l) => l.merchant === m).sort((a, b) => b.created_at - a.created_at);
    res.json({
      merchant: m, ...MERCHANTS[m], account_id: accounts.merchants[m],
      bank: { account: acct.account, currency: acct.currency, balance: acct.balance, balance_display: fmtFiat(BigInt(acct.balance), acct.currency as any) },
      links: myLinks,
      invoices: invoices.map((inv) => ({ ...inv, agent: agents[m].quotesFor(inv.id) ?? null })).reverse(),
    });
  }));

  app.post('/api/links', wrap(async (req, res) => {
    const m = req.body.merchant as MerchantName;
    if (!MERCHANTS[m]) throw fail(400, 'unknown merchant');
    const currency = MERCHANTS[m].currency;
    const fiat = parseUnits(String(req.body.price), CURRENCIES[currency].minor);
    if (fiat <= 0n) throw fail(400, 'price must be positive');
    const id = randomBytes(4).toString('hex');
    const link: Link = { id, merchant: m, currency, fiat_minor: fiat.toString(), memo: String(req.body.memo ?? ''), created_at: Date.now(), payments: [] };
    links.data.links[id] = link;
    links.save();
    log.add({ merchant: m, kind: 'link', text: `payment link ${id} created for ${fmtFiat(fiat, currency)}${link.memo ? ` (${link.memo})` : ''}` });
    res.json(link);
  }));

  /** "Try a checkout" on the landing page: a fresh demo link for a merchant, then its checkout. */
  const DEMO_ORDERS: Record<MerchantName, { price: string; memo: string }> = {
    'bengaluru-cafe': { price: '420', memo: 'Masala dosa and filter coffee x2' },
    'berlin-bikes': { price: '4.50', memo: 'Inner tube repair' },
    'nairobi-tailor': { price: '650', memo: 'Shirt alteration' },
  };
  app.get('/try', (req, res) => {
    const m = (MERCHANTS[req.query.m as MerchantName] ? req.query.m : 'bengaluru-cafe') as MerchantName;
    const currency = MERCHANTS[m].currency;
    const id = randomBytes(4).toString('hex');
    const fiat = parseUnits(DEMO_ORDERS[m].price, CURRENCIES[currency].minor);
    links.data.links[id] = { id, merchant: m, currency, fiat_minor: fiat.toString(), memo: DEMO_ORDERS[m].memo, created_at: Date.now(), payments: [] };
    links.save();
    log.add({ merchant: m, kind: 'link', text: `payment link ${id} created for ${fmtFiat(fiat, currency)} (${DEMO_ORDERS[m].memo})` });
    res.redirect(302, `/pay/${id}`);
  });

  // ------------------------------------------------------------ checkout API
  const customerBalances = async () => Object.fromEntries(await Promise.all(ASSET_KEYS.map(async (a) => {
    try { return [a, fmtAsset(await chain.balanceOf(accounts.customer, chain.assetId(a)), a, 4)]; } catch { return [a, '?']; }
  })));

  const getLink = (id: string) => { const l = links.data.links[id]; if (!l) throw fail(404, 'unknown payment link'); return l; };

  // Checkout quotes per (link, asset), reused for 20 s: the amount the customer sees on the asset
  // card is exactly the amount the invoice is created for if they choose it.
  const previews = new Map<string, { at: number; quotes: Quote[]; best?: Quote }>();
  async function checkoutQuotes(link: Link, asset: AssetKey) {
    const key = `${link.id}|${asset}`;
    const hit = previews.get(key);
    if (hit?.best && Date.now() - hit.at < 20_000 && hit.best.valid_until > Date.now() + 60_000) return hit;
    let r = { at: Date.now(), ...(await agents[link.merchant].checkoutQuotes(asset, BigInt(link.fiat_minor))) };
    if (!r.best) r = { at: Date.now(), ...(await agents[link.merchant].checkoutQuotes(asset, BigInt(link.fiat_minor))) }; // one retry
    if (r.best) previews.set(key, r); // never cache an empty round
    else previews.delete(key);
    return r;
  }

  app.get('/api/links/:id', wrap(async (req, res) => {
    const link = getLink(String(req.params.id));
    const rates = await getRates();
    const currency = MERCHANTS[link.merchant].currency;
    const options = await Promise.all(ASSET_KEYS.map(async (a) => {
      const { best, quotes } = await checkoutQuotes(link, a);
      const market = convert(BigInt(link.fiat_minor), { currency }, { asset: a }, rates, { round: 'up' });
      return {
        asset: a, label: ASSETS[a].label, usd_price: rates.usd[a], quotes: quotes.length,
        amount: best?.amount ?? null, display: best ? fmtAsset(BigInt(best.amount), a) : 'no provider available',
        provider: best?.provider ?? null, fee_pct: best ? best.spread_bps / 100 : null,
        market_display: fmtAsset(market, a),
      };
    }));
    const invoice = link.invoice ? await chain.getInvoice(link.invoice.id) : null;
    res.json({
      link, merchant: { name: link.merchant, ...MERCHANTS[link.merchant] }, price_display: fmtFiat(BigInt(link.fiat_minor), currency),
      options, rates_source: rates.source, invoice, message: link.invoice ? messages.get(link.invoice.id) ?? null : null,
      customer: accounts.customer,
      customer_balances: await customerBalances(),
    });
  }));

  /**
   * Customer picked an asset. Quote first: every provider says how much of that asset it needs to
   * pay the merchant the full price; the cheapest quote is locked, and the on-chain invoice (10 min)
   * is created for exactly that amount. The customer sees the final amount before paying.
   */
  app.post('/api/links/:id/checkout', wrap(async (req, res) => {
    const link = getLink(String(req.params.id));
    const asset = req.body.asset as AssetKey;
    if (!ASSETS[asset]) throw fail(400, 'asset must be near, eth or usdc');
    if (link.invoice) {
      const inv = await chain.getInvoice(link.invoice.id);
      if (inv && inv.status !== 'Refunded' && !(inv.status === 'Open' && Date.now() > inv.deadline)) {
        if (link.invoice.asset !== asset && inv.status === 'Open') { /* switch asset: create a new invoice below */ }
        else return void res.json(link);
      }
    }
    const rates = await getRates();
    const currency = MERCHANTS[link.merchant].currency;
    const { quotes, best } = await checkoutQuotes(link, asset);
    if (!best) throw fail(422, `no offramp provider can pay out ${currency} for ${ASSETS[asset].symbol} right now`);
    const amount = BigInt(best.amount);
    const tx = await chain.createInvoice(accounts.merchants[link.merchant], chain.assetId(asset), amount, timings().invoiceMinutes);
    previews.delete(`${link.id}|${asset}`); // a quote backs one invoice only
    link.invoice = {
      id: tx.value!, asset, amount: amount.toString(), tx: tx.hash, tx_url: chain.txUrl(tx.hash), rates_source: rates.source,
      quote: { quote_id: best.quote_id, provider: best.provider, fiat_amount: best.fiat_amount, spread_bps: best.spread_bps, valid_until: best.valid_until },
    };
    links.save();
    agents[link.merchant].lockQuote(tx.value!, quotes, best);
    log.add({ merchant: link.merchant, invoice_id: tx.value!, kind: 'invoice', tx: tx.hash, tx_url: chain.txUrl(tx.hash),
      text: `customer chose ${ASSETS[asset].symbol}: invoice #${tx.value} created on-chain for ${fmtAsset(amount, asset)}, ` +
        `backed by ${best.provider}'s quote paying the full ${fmtFiat(BigInt(best.fiat_amount), currency)} ` +
        `(${best.spread_bps / 100}% conversion fee included, ${rates.source} rates, valid ${timings().invoiceMinutes} min)` });
    res.json(link);
  }));

  /** Demo payer: the server-held customer key pays. fraction=0.8 pays 80% of the amount due. */
  app.post('/api/links/:id/pay', wrap(async (req, res) => {
    const link = getLink(String(req.params.id));
    if (!link.invoice) throw fail(400, 'choose an asset first');
    const inv = await chain.getInvoice(link.invoice.id);
    if (!inv || (inv.status !== 'Open' && inv.status !== 'Underpaid')) throw fail(400, `invoice is ${inv?.status}`);
    const due = BigInt(inv.amount) - BigInt(inv.paid);
    const amount = req.body.fraction === 0.8 ? (BigInt(inv.amount) * 8n) / 10n : due;
    const tx = await chain.pay(accounts.customer, inv.id, inv.asset, amount);
    link.payments.push({ tx: tx.hash, tx_url: chain.txUrl(tx.hash), amount: amount.toString(), ts: Date.now() });
    links.save();
    log.add({ merchant: link.merchant, invoice_id: inv.id, kind: 'payment', tx: tx.hash, tx_url: chain.txUrl(tx.hash),
      text: `customer ${accounts.customer} sent ${fmtAsset(amount, link.invoice.asset)} to escrow for invoice #${inv.id}` });
    // The agent reacts right away, in the background: the customer's answer doesn't wait for it.
    agents[link.merchant].tick().catch((e) => console.error(`[agent ${link.merchant}]`, e.message));
    res.json({ tx: tx.hash, tx_url: chain.txUrl(tx.hash), invoice: await chain.getInvoice(inv.id) });
  }));

  return {
    app, log, bank, agents, providers, links,
    async listen(port: number, host = '127.0.0.1') {
      const server = app.listen(port, host);
      await new Promise<void>((resolve, reject) => {
        server.once('listening', () => resolve());
        server.once('error', (e: NodeJS.ErrnoException) => reject(e.code === 'EADDRINUSE'
          ? new Error(`port ${port} is already in use by another program. Stop it, or start INPay with PORT=<free port>.`)
          : e));
      });
      // internal calls (agent -> providers, bank -> agent) always go over loopback, even when the
      // server listens on every interface (0.0.0.0 on a host such as Render)
      const self = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
      baseUrl = `http://${self}:${(server.address() as AddressInfo).port}`;
      for (const a of Object.values(agents)) a.start();
      return {
        url: baseUrl,
        close: () => { for (const a of Object.values(agents)) a.stop(); server.close(); server.closeAllConnections?.(); },
      };
    },
  };
}

export function simAccounts(): Accounts {
  return {
    merchants: Object.fromEntries(MERCHANT_NAMES.map((m) => [m, `${m}.sim`])) as Record<MerchantName, string>,
    customer: 'customer.sim',
    providers: Object.fromEntries(PROVIDER_NAMES.map((p) => [p, `${p}.sim`])) as Record<ProviderName, string>,
  };
}
