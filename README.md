```text
               ------------------------------------------------------------------------------------------------------------
                                                ___   _   _   ____      _     __   __
                                               |_ _| | \ | | |  _ \    / \    \ \ / /
                                                | |  |  \| | | |_) |  / _ \    \ V / 
                                                | |  | |\  | |  __/  / ___ \    | |  
                                               |___| |_| \_| |_|    /_/   \_\   |_|  
               ------------------------------------------------------------------------------------------------------------
```

---
<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="web/brand/logo-white.svg">
    <img alt="INPay Logo" src="web/brand/logo.svg" width="130">
  </picture>
  <br>
  <a href="https://inpay-na7v.onrender.com/"><strong>🚀 Live Hosted App: inpay-na7v.onrender.com</strong></a>
</p>

## Receiving payments should be easy. 

Imagine running a coffee shop in Bengaluru, a neighborhood bicycle workshop in Berlin, or a bespoke tailoring studio in Nairobi. When customers walk in or visit your online checkout, you want one simple thing: **to get paid in your local currency (INR, EUR, or KES)** so you can pay your rent, your suppliers, and your team without friction.

You don't want to become an active crypto trader, worry about wild market swings, or decipher complicated tax forms.

At the same time, your customers might be global nomads, freelancers, or everyday crypto users holding **NEAR, ETH, or USDC**. They want to spend the money in their wallets directly without jumping through centralized exchanges.

**INPay connects both worlds seamlessly:**
1. **The customer** pays with the crypto they already hold.
2. **An autonomous agent** instantly requests competitive quotes from licensed offramp providers to lock in the best rate.
3. **The onchain INPay escrow contract on NEAR** holds the crypto securely.
4. **The provider** sends local fiat cash straight to the merchant's bank account.
5. **The merchant** receives their full price in local money, and only then is the crypto released from escrow.

>  The merchant never has to handle crypto, and the customer never needs to own local currency.

---

## Quickstart: Try it out in minutes

All you need is **Node.js 20+** and **npm**.

### 1. Test offline (Zero setup, instant feedback)

Want to see how INPay works without configuring keys, testnet faucets, or API tokens?

```bash
npm install
npm run sim
```

This runs entirely on your local machine:
- No network connection, no private keys, and no LLM API keys needed.
- Uses fixed offline fallback rates (`rates.fallback.json`), an in-memory replica of the NEAR contract rules, and simulated providers and banks running on `127.0.0.1` at **20x real-world speed**.
- Automatically steps through all three real-world checkout scenarios and logs the agent settling every invoice, concluding with:
  `All three scenarios settled.`

### 2. Verify with test suites

```bash
# Run the 19 unit tests (currency math, auction logic, agent timeouts, underpayments, refunds)
npm run test:unit

# Run full tests including contract sandbox tests (near-workspaces)
npm test
```
*Note: Contract sandbox tests run natively on Linux and macOS, or via Docker on Windows. Continuous integration runs via `.github/workflows/test.yml`.*

### 3. Deploy & test on NEAR Testnet

```bash
# 1. Copy environment template and add your testnet credentials
cp .env.example .env
# Set NEAR_ACCOUNT_ID and NEAR_PRIVATE_KEY inside .env (needs ~20.2 testnet NEAR)

# 2. Deploy contracts and fund demo accounts
npm run setup

# 3. Run the live testnet sanity check
npm run smoke
```

`npm run setup` automatically:
- Creates required sub-accounts on testnet.
- Deploys the `inpay` escrow contract, plus test stand-in tokens: `wETH` (18 decimals) and `USDC` (6 decimals).
- Registers token storage and funds a demo customer account with **10 NEAR**, **1 wETH**, and **100 USDC**.
- Warns you clearly if your account is short on testnet gas.

`npm run smoke` runs live on NEAR Testnet:
- Creates and pays a NEAR invoice, assigns the provider, and confirms bank payout.
- Processes a token payment in USDC.
- Creates an underpaid invoice and triggers an automatic on-chain refund after its deadline expires.
- Prints clickable NEAR testnet block explorer links for every step.

### Offline demo or real testnet?

`npm run dev` and `npm run demo` pick their mode by themselves:

| | **Offline demo** (default after cloning) | **Real NEAR testnet** |
| --- | --- | --- |
| How you get it | Just `npm install` and `npm run dev` | Run `npm run setup` once with your own testnet account (step 3 above) |
| What it needs | Nothing | A NEAR testnet account with about **20.2 testnet NEAR** (free from [near-faucet.io](https://near-faucet.io)) and its private key in `.env` |
| Payments | Settle instantly on an in-memory copy of the escrow contract | Real transactions on NEAR testnet, with explorer links, taking 3 to 10 seconds each |
| How to tell | The landing pill, checkout badge and dashboard say **Offline demo** | They say **NEAR testnet** |

Both modes show the same pages, quotes, failover and refunds. The testnet accounts and keys this project was built with are not in the repository (`.keys/` is gitignored), so a fresh clone starts offline. `npm run setup` creates your own copy of everything on testnet: the escrow contract, the wETH and USDC test tokens, three merchants, three providers and a funded demo customer. Prefer not to spend testnet NEAR? The [real testnet transactions](#real-proof-transactions-on-near-testnet) from our own runs are linked below.

### Live on Render & Deploy Blueprint

INPay is deployed and live at **[https://inpay-na7v.onrender.com](https://inpay-na7v.onrender.com)**.

The repository includes a Render Blueprint (`render.yaml`): one Node web service that serves the landing page, the merchant app and the API, and runs the agents, simulated providers and simulated bank.

1. **Live Hosted Link:** Visit **[https://inpay-na7v.onrender.com](https://inpay-na7v.onrender.com)** to test the interactive checkout, merchant dashboard, and simulated bank statements directly in your browser.
2. **Deploy your own:** Render dashboard → **New → Blueprint** → pick this repository. It builds with `npm run build`, starts with `npm start` and checks `/healthz`.
3. Without secrets it runs the **offline demo** and says so on every page.
4. For **real testnet payments**, run `npm run render:env` locally after `npm run setup`. It writes `.keys/render.env` (gitignored) holding two values, `INPAY_DEPLOYMENT` and `INPAY_KEYS`. Add both as secret environment variables on the service and redeploy. `INPAY_KEYS` holds only the keys the app signs with (the three merchants and the demo customer); your master account key is never included. These are testnet-only keys, held server-side as a demo convenience.

Render's free plan sleeps after inactivity, so the first visit can take about a minute to wake. Its disk is reset on each deploy: the demo links are recreated and the simulated bank rebuilds its payouts from the settled invoices on-chain.

---

## Experience the interactive demo

You can try INPay right now on our live hosted instance at **[https://inpay-na7v.onrender.com](https://inpay-na7v.onrender.com)**, or start the demo stack locally:

```bash
npm run demo
```
*This starts all background services with fresh state, activates simulated providers with a 15-second payout timeout, and simulates a payment rail outage on PayRail (`FAIL_PROVIDER=payrail`).*

Try these three real-world stories (hosted on **[inpay-na7v.onrender.com](https://inpay-na7v.onrender.com)** or locally on `http://127.0.0.1:5190`):

1. **The Bengaluru Café — Fast, happy-path payment (INR)**
   - Open [https://inpay-na7v.onrender.com/pay/demo-cafe](https://inpay-na7v.onrender.com/pay/demo-cafe) (or `http://127.0.0.1:5190/pay/demo-cafe`)
   - The invoice shows the bill (**420.00 INR**), the exact crypto required, which provider won the quote auction, and the transparent fee included.
   - Choose **NEAR** and click **Pay**.
   - Check the merchant dashboard at [https://inpay-na7v.onrender.com/dashboard?m=bengaluru-cafe](https://inpay-na7v.onrender.com/dashboard?m=bengaluru-cafe): you will see the quote locked before payment (*"swiftcash locked before payment, customer pays 1.7% less than with the worst quote"*), the payment verified on-chain, the bank credit of the full 420.00 INR, and `confirm_payout` releasing the NEAR to SwiftCash.

2. **The Berlin Bike Shop — Automatic failover when a rail stalls (EUR)**
   - Open [https://inpay-na7v.onrender.com/pay/demo-bikes](https://inpay-na7v.onrender.com/pay/demo-bikes) (or `http://127.0.0.1:5190/pay/demo-bikes`) for a **4.50 EUR** tune-up.
   - Choose **ETH** and click **Pay**.
   - SwiftCash doesn't support ETH, so PayRail wins the quote. However, PayRail's payout stalls and never credits the bank.
   - After 15 seconds, the autonomous agent flags PayRail as failed, re-quotes the escrowed ETH to fallback provider QuickFX, reassigns the invoice on-chain, receives the 4.45 EUR bank credit (reflecting QuickFX's slightly wider spread, clearly reported in the log), and confirms the payout. The merchant gets paid even when a payment rail fails!

3. **The Nairobi Tailor — Handling an underpayment gracefully (KES)**
   - Open [https://inpay-na7v.onrender.com/pay/demo-tailor](https://inpay-na7v.onrender.com/pay/demo-tailor) (or `http://127.0.0.1:5190/pay/demo-tailor`) for a **650.00 KES** garment.
   - Choose **USDC** and click **Demo: pay only 80%**.
   - The invoice immediately updates to **Underpaid**, clearly displaying the exact remaining balance needed.
   - Click **Pay the missing …**: the top-up transaction settles on-chain, and the full 650.00 KES lands in the merchant bank account.
   - Check the simulated bank statement at [https://inpay-na7v.onrender.com/bank/nairobi-tailor](https://inpay-na7v.onrender.com/bank/nairobi-tailor).
   *(Note: If the customer never tops up before the deadline, anyone can trigger `refund` on-chain to return 100% of their deposited funds).*

To run through all three checkouts headlessly, open a second terminal while `npm run demo` is active and run:
```bash
npm run scenarios
```

For everyday development with hot reloading:
```bash
npm run dev
# Starts backend services on port 8790 (PORT) and Vite React web app on port 5190 (WEB_PORT)
```

---

## What is real vs. simulated?

We believe in complete transparency about what runs on live testnet contracts versus what is mocked for demo ergonomics:

| Component | Status | How it works |
| :--- | :--- | :--- |
| **Escrow smart contract (`inpay`)** | **Real** | Written in Rust (`near-sdk` v5), deployed and fully functional on NEAR Testnet. |
| **Native NEAR payments** | **Real** | Actual native testnet NEAR transferred directly into the escrow contract. |
| **Token payments (`wETH`, `USDC`)** | **Real** | Real NEP-141 transfers on testnet. The tokens are deployed testnet stand-ins (`near-examples/FT` as `wETH` with 18 decimals and `USDC` with 6 decimals), not bridged mainnet tokens. |
| **Provider management & Escrow release** | **Real** | Assignment, reassignment, final payout release, and customer refunds are executed on-chain. |
| **Crypto market prices** | **Real** | Live CoinGecko simple price API (`near`, `ethereum`, `usd-coin`) refreshed every 60 seconds with cached fallbacks in `.state/` and `rates.fallback.json`. |
| **Fiat foreign exchange (FX) rates** | **Real** | Live rates from `open.er-api.com` with automated background refresh and fallback cache. |
| **Offramp providers (`swiftcash`, `payrail`, `quickfx`)** | **Simulated** | Local HTTP services in this repo, but each operates with its own genuine NEAR testnet account that receives the released crypto. |
| **Merchant banks** | **Simulated** | Lightweight JSON ledger service with credit notification webhooks. |
| **Demo customer wallet** | **Demo convenience** | Server-held testnet keys behind the **Pay** button for quick browser testing. (Wallet selector is omitted for streamlined demoing). |
| **Merchant agent decisions** | **Real** | Deterministic TypeScript engine (`server/agent.ts`). An optional LLM (`LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`) is used only to reword event log explanations into conversational English; everything works completely without it. |

---

## System Architecture

```text
Customer ──pay_near / ft_transfer_call──▶  INPay Escrow (NEAR)  ──confirm_payout──▶ Provider Account
                                                ▲   ▲                                 (crypto released)
                       create_invoice, assign   │   │ get_invoices (polled every 3s)
                                                │   │
 Web (Vite + React) ── /api ──▶ Merchant Agent Engine (Node) ◀── Bank Webhook ── Merchant Bank
                                                │                                       ▲
                                      GET /quote, POST /payout ─▶ Providers ── Credit ──┘
```

### The Escrow Release Rule
Crypto leaves the escrow contract for the offramp provider **only** through `confirm_payout`:
- Only the merchant account can authorize it.
- The merchant's autonomous agent triggers it **only** after receiving a validated bank webhook confirming a deposit whose reference code and fiat amount match the assigned quote.
- If a provider never deposits the fiat, they never get the crypto.

---

## Contract Methods (`contract/src/lib.rs`)

| Method | Access & Behavior |
| :--- | :--- |
| `new(tokens)` | Initializes the escrow contract with an allowlist of supported NEP-141 tokens (`[weth, usdc]`). |
| `create_invoice(asset, amount: U128, deadline_minutes: u32) -> u64` | Called by the merchant. Specifies the payment asset (`"near"` or allowlisted token), required crypto amount, and expiry time. |
| `pay_near(id)` | Payable method for native NEAR before the deadline. The first payer is recorded as the customer. If `paid >= amount`, status becomes `Paid` and any overpayment is instantly returned; otherwise it is marked `Underpaid`. |
| `ft_on_transfer(sender_id, amount, msg)` | Handles NEP-141 token transfers where `msg = {"invoice_id": n}`. The token contract must be allowlisted and match the invoice asset; excess tokens are returned to the sender. |
| `assign_provider(id, provider, fiat_amount, fiat_currency, quote_id)` | Merchant-only. Moves invoice from `Paid` to `Assigned` with locked provider details. |
| `reassign_provider(...)` | Merchant-only. Allows switching providers while in `Assigned` state if the original provider fails or times out. |
| `confirm_payout(id, payout_ref)` | Merchant-only. Transitions invoice from `Assigned` to `Settled` and releases exact crypto amount to the provider. A callback safely restores `Assigned` state if the token transfer fails. |
| `refund(id)` | Publicly callable by anyone once the deadline expires for `Open` or `Underpaid` invoices. Automatically returns all deposited funds to the customer. |
| `get_invoice(id)`, `get_invoices(merchant)`, `get_tokens()` | Public read-only views for inspection and polling. |

**Standard NEP-297 Events Emitted (`standard: "inpay"`):** `paid`, `underpaid`, `assigned` (also on reassignment with `reassigned: true`), `settled`, `refunded`, and `send_failed`.

**Verified Sandbox Test Scenarios (`tests/contract.sandbox.test.ts`):**
1. Exact NEAR payment marks invoice `Paid`; overpayment returns excess change in the same transaction.
2. Token underpayment flags `Underpaid`; top-up marks invoice `Paid`.
3. Non-allowlisted or mismatched tokens are rejected with funds returned.
4. Only the merchant can assign, reassign, or confirm payout.
5. `confirm_payout` sends the exact asset to the provider (verified for NEAR and wETH).
6. Refunds can only be claimed after the deadline and only when not `Paid`.

---

## Fair Pricing & Competitive Quote Auctions

**Quote first, invoice second — zero surprises for the customer:**

1. The customer selects their preferred crypto asset at checkout.
2. All providers supporting that coin submit bids: *"To credit the merchant with exactly 420.00 INR, I need X NEAR."*
   $$\text{Crypto Needed } (X) = \left\lceil \frac{\text{fiat price}}{\text{usd price} \times \text{fx rate} \times (1 - \text{spread})} \right\rceil$$
3. The provider requiring the **least amount of crypto** wins the auction.
4. That quote is locked to the invoice for 10 minutes. The customer sees the exact amount to pay, who backs it, and the embedded conversion fee upfront.
5. When payment lands, the agent assigns the provider on-chain immediately. The merchant receives their full fiat amount, and any network/exchange fees are transparently visible.
6. Overpayments are returned in the same block. Underpayments display the exact missing balance and can be topped up or refunded at expiration.

### Configured Offramp Providers

| Provider | Spread | Typical ETA | Supported Assets |
| :--- | :---: | :---: | :--- |
| **swiftcash** | 0.8% | 5 s | NEAR, USDC |
| **payrail** | 1.5% | 3 s | NEAR, ETH, USDC |
| **quickfx** | 2.5% | 2 s | NEAR, ETH |

*Failover Auction:* If the winning provider fails to credit the merchant's bank within the timeout period, the agent triggers a failover auction. The escrowed crypto amount is fixed, and remaining providers bid on how much fiat they can deliver. The agent picks the highest payout, reassigns the contract on-chain, and transparently logs the variance.

---

## Autonomous Merchant Agent (`server/agent.ts`)

Every 3 seconds, the merchant agent evaluates all active invoices:
- **`Paid` invoice:** Calls `assign_provider` with the locked quote, then dispatches `POST /payout` to the provider. (If the quote expired or the server restarted, it runs a fresh auction for the escrowed funds).
- **Bank webhook arrives:** Reconciles the deposit reference and amount against the assigned quote. If matched, calls `confirm_payout(id, payout_ref)`.
- **Payout timeout (60s in production, 15s in demo `DEMO_TIMEOUT_SECONDS`):** Marks the provider as failed for this invoice, takes the next-best valid quote (or re-quotes if expired), calls `reassign_provider` on-chain, and routes payout to the new provider.
- **`Underpaid` invoice:** Calculates and displays the exact missing balance; calls `refund` once the invoice deadline passes.

---

## Live NEAR Testnet Deployment

### Contracts & Accounts

| Entity | Address | Details / Transactions |
| :--- | :--- | :--- |
| **Escrow Contract** | [`inpay.0xforge.testnet`](https://testnet.nearblocks.io/address/inpay.0xforge.testnet) | [Deploy Tx (HLSFAj35…)](https://testnet.nearblocks.io/txns/HLSFAj35QePVXxPQNcHWpjaKMw3fwzHNtKWoYm8icLwB) · [Init Tx (5aHiwmmR…)](https://testnet.nearblocks.io/txns/5aHiwmmR9fryWTHzxnqUvQEVVZXP6sNvJh3fsN7qU97F) |
| **wETH Test Token** | [`weth.0xforge.testnet`](https://testnet.nearblocks.io/address/weth.0xforge.testnet) | [Deploy Tx (3yhWZUAG…)](https://testnet.nearblocks.io/txns/3yhWZUAGReB7U6wcQ3KXmqiqoNcMc9BLMNkDero2ciNn) |
| **USDC Test Token** | [`usdc.0xforge.testnet`](https://testnet.nearblocks.io/address/usdc.0xforge.testnet) | [Deploy Tx (FAaUAh6p…)](https://testnet.nearblocks.io/txns/FAaUAh6pvNLYCW6A96JZkW2h6bRBuzPEBPjAxoPnffc3) |
| **Merchants** | `bengaluru-cafe.0xforge.testnet`<br>`berlin-bikes.0xforge.testnet`<br>`nairobi-tailor.0xforge.testnet` | Testnet merchant accounts |
| **Demo Customer** | `customer.0xforge.testnet` | Pre-funded customer wallet |
| **Offramp Providers** | `swiftcash.0xforge.testnet`<br>`payrail.0xforge.testnet`<br>`quickfx.0xforge.testnet` | Provider recipient accounts on testnet |

### Real Proof Transactions on NEAR Testnet

Transactions recorded from `npm run smoke` and live `npm run demo` runs:

| Step / Scenario | Explorer Link |
| :--- | :--- |
| **NEAR Payment (`pay_near`)** | [`7WZJvkVJ…`](https://testnet.nearblocks.io/txns/7WZJvkVJrUUK73kvBXnXA1DyzBTm95sbCSzZuVi7v2L9) |
| **Provider Assignment (`assign_provider`)** | [`Eb9QW7Ku…`](https://testnet.nearblocks.io/txns/Eb9QW7Ku3emuut5GLe3ABvKQVZd1t67oiU65HK1VEa8K) |
| **Crypto Release (`confirm_payout` to swiftcash)** | [`BMZiSdSB…`](https://testnet.nearblocks.io/txns/BMZiSdSBRhqrXLqfzmFH53HpNBa3oTMMTeAcRAqDt1Ww) |
| **Token Payment (`ft_transfer_call`, USDC)** | [`CNHk7e4v…`](https://testnet.nearblocks.io/txns/CNHk7e4vBQL3Ei973EgqwJFYwNNhKwBkPEHh9i8xtGcG) |
| **On-Chain Refund (Underpaid USDC after deadline)** | [`3ud7LgGK…`](https://testnet.nearblocks.io/txns/3ud7LgGKSk9JSer2uaKy3RvQz3k3dRGUXZ4oaoN3ALFg) |
| **Scenario 1: Bengaluru Café (420.00 INR)**<br>SwiftCash locked at checkout (1.248618 NEAR); merchant receives 420.00 INR | Invoice: [`H3XRHcex…`](https://testnet.nearblocks.io/txns/H3XRHcex4Di77SWKp5uoctwvEe4TAfeZEVp72ydcrD96)<br>Payment: [`E9bSHqrP…`](https://testnet.nearblocks.io/txns/E9bSHqrPftuqf5Q94krhb4kRzyfA5sN4Y2vAUmQZmDHX)<br>Assign: [`9C7u3vLs…`](https://testnet.nearblocks.io/txns/9C7u3vLs1ACJPqp5SyWvDfFxsZeWcSecqZji2ESr6nMa)<br>Release: [`A5e9CNeA…`](https://testnet.nearblocks.io/txns/A5e9CNeA9oktJHWVFC3nsCVW3DBSc4uLHk3XqNemgCHw) |
| **Scenario 2: Berlin Bike Shop (4.50 EUR in wETH)**<br>PayRail locked, fails to pay, **reassigned** to QuickFX (4.45 EUR) | Payment: [`6BscuGpJ…`](https://testnet.nearblocks.io/txns/6BscuGpJYkujB83XHe1WpZyMQouCL7XXNqiEGStYW98k)<br>Assign: [`Bmnyc7Bz…`](https://testnet.nearblocks.io/txns/Bmnyc7Bzi9WqGN4FTEPEMMUGqtqTBNSr3CP7YLqqJMx4)<br>Reassign: [`9gYv9b8J…`](https://testnet.nearblocks.io/txns/9gYv9b8JMC9rR8VwGcFF84Ns33jhCBmgcPu8wWpTv8kr)<br>Release: [`AnpVX8tF…`](https://testnet.nearblocks.io/txns/AnpVX8tFNeo1dyq7KXnCKHDH5QzD1qhZjkPmeRzZdocP) |
| **Scenario 3: Nairobi Tailor (650.00 KES in USDC)**<br>80% underpay demo, followed by top-up; merchant receives 650.00 KES | Underpay: [`FHEFkkuV…`](https://testnet.nearblocks.io/txns/FHEFkkuVEGvZqRYzGXTfHEfy7yMwn88EFYL1rBJcCYP8)<br>Top-up: [`Aa5w3NNa…`](https://testnet.nearblocks.io/txns/Aa5w3NNarRrafophcxVaA5SS2jpaq3UkdN5Xz8J9PjKZ)<br>Assign: [`cXvme34U…`](https://testnet.nearblocks.io/txns/cXvme34UuBLG6sNRDsePTAGMvsueaC7peqpkLBbqAUy)<br>Release: [`CFrDsUtK…`](https://testnet.nearblocks.io/txns/CFrDsUtKem5HsiyfqYgn3aUsPy38UjDfyj4mjfdV1XGa) |

---

## Why NEAR & The Mainnet Vision

NEAR serves as the ideal universal clearinghouse for global merchant commerce:

1. **NEAR Intents & Chain Abstraction:** Shoppers aren't locked into a single ecosystem. Whether holding **Bitcoin, Solana, Ethereum, Arbitrum, or stablecoins**, customers simply sign a payment intent. Independent market solvers fulfill the intent cross-chain and deliver the required asset directly into the INPay escrow contract on NEAR.
2. **Sub-Second Finality & Sub-Cent Gas:** Real-world retail and e-commerce checkouts cannot tolerate \$5–\$20 gas spikes or multi-minute block confirmations. NEAR's fast consensus and micro-gas fees make everyday payments practical.
3. **Atomic Rust Escrow:** The `inpay` escrow contract locks native NEAR and NEP-141 tokens atomically under deterministic on-chain rules. Crypto is released only after local bank confirmation.
4. **Agent Sandboxing:** Modular accounts and restricted Function-Call Access Keys enable autonomous merchant agents to run quote auctions, enforce timeouts, and reassign stalled rails without needing unrestricted custody of funds.
5. **Real-World Rails:** On mainnet, licensed offramp partners (e.g. MoonPay, Transak, or local banking partners) replace our mock providers, and real open banking webhooks replace our simulated bank credits. 

We built INPay for businesses to use **tomorrow**

---

## Repository Structure

```text
inpay/
├── contract/             # Rust escrow contract (near-sdk v5); built Wasm in contract/res/
├── server/               # Node process: pricing, auction, rates, mock bank, providers, agent, API
│   └── chain/            # Chain drivers: near.ts (testnet via near-api-js) & memory.ts (offline)
├── web/                  # Vite + React frontend: merchant dashboard, checkout, mock bank views
├── scripts/              # Automated workflows: setup, smoke, sim, demo, scenarios, build-contract
└── tests/                # Contract sandbox tests (near-workspaces) and unit tests
```

### Build & Environment Notes
- **Wasm Build:** The contract Wasm is compiled using Rust 1.86 (pinned in `rust-toolchain.toml`) to ensure full compatibility with the NEAR VM. Rebuild anytime with `npm run build:contract` (add `-- --ft` to rebuild the fungible token).
- **FastNEAR RPC:** The public `rpc.testnet.near.org` endpoint is deprecated. By default, INPay uses `https://test.rpc.fastnear.com` (can be overridden with `NEAR_RPC_URL`). The server includes automatic response caching and retries on HTTP 429 rate limits.
- **Key Safety:** `npm run setup` writes local keys to `.keys/`, and the master key lives in `.env`. Both are strictly ignored by `.gitignore`.

---

## License

Released under the [MIT License](LICENSE). 

Also built by this team - [deloop](https://deloop-three.vercel.app/) [repo link](https://github.com/UnknownBlackman/deloop)
