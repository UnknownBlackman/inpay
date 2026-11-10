# INPay

**Receiving payment should be easy.**

INPay lets a small business anywhere (a cafe in Bengaluru, a bike shop in Berlin, a tailor in Nairobi) receive payment in their own local currency (INR, EUR, KES). Customers get the payment invoice at the best market quote, handled autonomously by an agent. The customer pays with the crypto they already hold: NEAR, ETH or a stablecoin on any chain, solvers deliver their payment to the INPay escrow contract on Near; and the agent handles the offramping.
The merchant never has to hold crypto, and the customer never needs to worry about holding local currency.

## Quickstart

Running INPay needs Node 20+ and npm.

| Run | See |
| --- | --- |
| `npm install` | dependencies install (the sandbox binary is optional and skipped on Windows) |
| `npm run sim` | Fully offline: no network, no keys, no LLM. Fixed rates from `rates.fallback.json`, an in-memory copy of the contract rules, and the real agent, providers and mock bank on 127.0.0.1 with a 20x faster clock. Plays the 3 demo scenarios and prints the agent's event log, ending with `All three scenarios settled.` |
| `npm run test:unit` | 19 unit tests: the conversion function (including gross-up), the quote auction (both quote kinds), and the agent (quote locked before payment, failover, underpaid, refund, mismatched bank credit) |
| `npm test` | unit tests + contract sandbox tests (near-workspaces). The sandbox runs on Linux/macOS; on Windows it runs in Docker. CI: `.github/workflows/test.yml` |
| `cp .env.example .env`, set `NEAR_ACCOUNT_ID` / `NEAR_PRIVATE_KEY` (testnet), `npm run setup` | Creates sub-accounts, deploys wETH, USDC (near-examples/FT) and `inpay`, registers storage, funds the customer with 10 NEAR, 1 wETH, 100 USDC. Needs ~20.2 testnet NEAR and says clearly if the account is short. |
| `npm run smoke` | On testnet: NEAR invoice, pay, assign, `confirm_payout`; a USDC payment; an underpaid invoice refunded after its deadline. Prints explorer links. |
| `npm run demo` | Fresh off-chain state, the 3 scenario links seeded, everything started with `FAIL_PROVIDER=payrail` and a 15 s payout timeout. Open http://127.0.0.1:5190 |
| `npm run scenarios` (with the demo running) | Clicks through the 3 checkouts via the same API the web page uses and prints the log with explorer links |
| `npm run dev` | All services (port 8790, `PORT`) + web (port 5190, `WEB_PORT`). Without `.keys/deployment.json` it falls back to the in-memory chain. |

### Demo in the browser (`npm run demo`)

1. Open http://127.0.0.1:5190/pay/demo-cafe. Each coin shows the exact amount to pay, which provider backs it, and the fee included. 
Choose **NEAR**, click **Pay**. On http://127.0.0.1:5190/?m=bengaluru-cafe the event log shows 3 checkout quotes ("swiftcash locked before payment, customer pays 1.7% less than with the worst quote"), the invoice, the payment, assignment on-chain, the bank credit of the full 420.00 INR, and `confirm_payout`.
2. Open http://127.0.0.1:5190/pay/demo-bikes, choose **ETH**, click **Pay**. swiftcash is skipped (no ETH). payrail's quote is locked but payrail never pays. After 15s the agent marks payrail failed, re-quotes the escrowed ETH, reassigns on-chain to quickfx, quickfx pays (4.45 EUR: its wider spread, stated in the log), and the agent confirms.
3. Open http://127.0.0.1:5190/pay/demo-tailor, choose **USDC**, click **Pay only 80% (demo)**. The status is Underpaid and the page tells the customer the exact missing amount. Click **Pay remaining**: normal flow in KES.
4. Open http://127.0.0.1:5190/bank/nairobi-tailor (the simulated bank statement).

## Real vs simulated

| Part | Status |
| --- | --- |
| Escrow contract `inpay` (Rust, near-sdk 5) | **Real**, NEAR testnet |
| Payments in native NEAR | **Real**, testnet NEAR |
| Payments in wETH and USDC | **Real** NEP-141 transfers on testnet. The tokens are **testnet stand-ins** (unmodified near-examples/FT deployed as `wETH`, 18 decimals, and `USDC`, 6 decimals), not bridged ETH or Circle USDC. |
| Provider assignment, reassignment, release to provider, refunds | **Real**, on-chain |
| Crypto prices | **Real**: CoinGecko simple price (near, ethereum, usd-coin), refreshed every 60 s in the background. If unreachable: the last good live values (saved in `.state/`), else `rates.fallback.json`. |
| FX rates | **Real**: open.er-api.com. Same refresh and fallback. |
| Offramp providers swiftcash, payrail, quickfx | **Simulated** (HTTP services in this repo, each with its own real testnet account that receives the crypto) |
| Merchant banks | **Simulated** (JSON file, webhook on credit) |
| Customer wallet in the demo | Server-held testnet key behind a **Pay** button. **A testnet demo convenience only.** Wallet-selector connection is not included. |
| Merchant agent decisions | Real code, deterministic. The optional LLM (`LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, any OpenAI-compatible API such as NEAR AI Cloud) only rewords log lines. Without it everything works. |

## Architecture

```
customer ──pay_near / ft_transfer_call──▶  inpay escrow (NEAR)  ──confirm_payout──▶ provider account
                                               ▲   ▲                                  (crypto released)
                       create_invoice, assign  │   │ get_invoices (every 3 s)
                                               │   │
 web (Vite+React) ── /api ──▶ one Node process: merchant agents ◀── bank webhook ── bank
                                               │                                       ▲
                                     GET /quote, POST /payout ─▶ providers ── credit ───┘
```

**Release rule:** crypto leaves escrow for the provider only through `confirm_payout`. Only the merchant can call it, and the merchant's agent calls it only after the bank webhook reports a credit whose reference and amount match the assigned quote.

### Contract methods (`contract/src/lib.rs`)

| Method | Rule |
| --- | --- |
| `new(tokens)` | allowlist of NEP-141 tokens (`[weth, usdc]`) |
| `create_invoice(asset, amount: U128, deadline_minutes: u32) -> u64` | caller is the merchant; asset is `"near"` or an allowlisted token |
| `pay_near(id)` payable | asset must be `near`; before the deadline. The first payer becomes the customer. `paid >= amount` gives Paid and the excess is sent back; otherwise Underpaid. |
| `ft_on_transfer(sender_id, amount, msg)` | `msg = {"invoice_id": n}`. The predecessor must be allowlisted **and** equal the invoice asset, otherwise it panics and the token contract refunds everything. Same rules; the excess is returned as the unused amount. |
| `assign_provider(id, provider, fiat_amount, fiat_currency, quote_id)` | merchant only; Paid → Assigned |
| `reassign_provider(...)` | merchant only; only while Assigned |
| `confirm_payout(id, payout_ref)` | merchant only; Assigned → Settled; sends exactly `amount` of the asset to the provider (transfer or `ft_transfer`). A callback restores Assigned if the transfer fails. |
| `refund(id)` | anyone; Open/Underpaid and past the deadline; returns `paid` to the customer in the same asset |
| `get_invoice(id)`, `get_invoices(merchant)`, `get_tokens()` | views |

Events (NEP-297, `standard: "inpay"`): `paid`, `underpaid`, `assigned` (also on reassignment, with `reassigned: true`), `settled`, `refunded`, `send_failed`.

Sandbox tests (`tests/contract.sandbox.test.ts`):
1. NEAR exact payment → Paid; overpayment → Paid with the excess returned.
2. Token underpayment → Underpaid; top-up → Paid.
3. Non-allowlisted token and wrong token rejected, with funds returned.
4. Only the merchant can assign, reassign or confirm.
5. `confirm_payout` sends the right asset to the provider (NEAR and wETH).
6. Refund only after the deadline and only when not Paid.

Rust unit tests in `contract/src/lib.rs` cover the same rules with a mocked chain.

### Pricing and auction

**Quote first, then invoice.** The customer always knows the exact amount before paying:
1. The customer picks a coin on the checkout page.
2. Every provider that accepts that coin answers: "to pay the merchant exactly 420.00 INR, I need X NEAR". That is `X = price ÷ (usd_price × fx × (1 − spread))`, rounded up.
3. The quote needing the least crypto wins. It is locked to the invoice, valid as long as the invoice (10 min).
4. The on-chain invoice is created for exactly X. The page shows X, the provider, and the conversion fee included.
5. On payment, the agent assigns the locked quote on-chain right away; there is no second auction. The merchant receives the full price, and the fee is visible to the customer, like a card's FX fee.
6. An overpayment is returned in the same transaction. An underpayment gets an exact "missing amount" message, and a refund at the deadline.

The one exception is failover. If the locked provider never pays, the escrowed crypto is re-quoted to the other providers for that fixed amount. The next one may pay slightly less because of its wider spread, and the merchant is told the difference.

- `server/pricing.ts` has one `convert(amount, from, to, rates, {spreadBps | grossUpBps, round})`. Prices and FX are decimals; every amount it returns is an integer BigInt in smallest units (yocto, wei, micro-USDC, paise, cents, KES cents). The amount the customer pays rounds up; payouts round down.
- A provider quote satisfies `fiat_amount = amount × usd_price(asset) × fx(currency) × (1 − spread)`. A checkout quote fixes `fiat_amount` and solves for `amount`; a failover quote fixes `amount`.
- `server/auction.ts`: at checkout the least crypto wins; at failover the most fiat wins. Ties go to the lower ETA, then the provider name. Failed providers and expired quotes are skipped.

| Provider | Spread | ETA | Accepts |
| --- | --- | --- | --- |
| swiftcash | 0.8% | 5 s | NEAR, USDC |
| payrail | 1.5% | 3 s | NEAR, ETH, USDC |
| quickfx | 2.5% | 2 s | NEAR, ETH |

### Merchant agent (`server/agent.ts`)

At checkout (before payment): ask all providers in parallel for the crypto needed to pay the full price (3 s timeout; 422 = asset not supported), and lock the best quote to the new invoice.

Every 3 s, for each merchant:
- **Paid:** `assign_provider` with the locked quote, then `POST /payout`. If no valid locked quote exists (for example, after a restart), auction the escrowed amount instead.
- **Bank webhook:** reference and amount must equal the assigned quote; then `confirm_payout(id, payout_ref)`.
- **No credit within 60 s** (`DEMO_TIMEOUT_SECONDS`): mark the provider failed for this invoice, take the next-best valid quote (re-quote if expired), `reassign_provider`, and pay out again.
- **Underpaid:** tell the customer the exact missing amount; at the deadline, `refund`.

Every decision goes to the event log shown in the dashboard.

## Testnet deployment

| What | Account / transaction |
| --- | --- |
| Escrow contract | [`inpay.0xforge.testnet`](https://testnet.nearblocks.io/address/inpay.0xforge.testnet), deploy [`HLSFAj35…`](https://testnet.nearblocks.io/txns/HLSFAj35QePVXxPQNcHWpjaKMw3fwzHNtKWoYm8icLwB), init [`5aHiwmmR…`](https://testnet.nearblocks.io/txns/5aHiwmmR9fryWTHzxnqUvQEVVZXP6sNvJh3fsN7qU97F) |
| wETH test token | [`weth.0xforge.testnet`](https://testnet.nearblocks.io/address/weth.0xforge.testnet), deploy [`3yhWZUAG…`](https://testnet.nearblocks.io/txns/3yhWZUAGReB7U6wcQ3KXmqiqoNcMc9BLMNkDero2ciNn) |
| USDC test token | [`usdc.0xforge.testnet`](https://testnet.nearblocks.io/address/usdc.0xforge.testnet), deploy [`FAaUAh6p…`](https://testnet.nearblocks.io/txns/FAaUAh6pvNLYCW6A96JZkW2h6bRBuzPEBPjAxoPnffc3) |
| Merchants | `bengaluru-cafe.0xforge.testnet`, `berlin-bikes.0xforge.testnet`, `nairobi-tailor.0xforge.testnet` |
| Customer | `customer.0xforge.testnet` |
| Providers | `swiftcash.0xforge.testnet`, `payrail.0xforge.testnet`, `quickfx.0xforge.testnet` |

Transactions from `npm run smoke` and a `npm run demo` run:

| Step | Transaction |
| --- | --- |
| NEAR payment (`pay_near`) | [`7WZJvkVJ…`](https://testnet.nearblocks.io/txns/7WZJvkVJrUUK73kvBXnXA1DyzBTm95sbCSzZuVi7v2L9) |
| Assignment (`assign_provider`) | [`Eb9QW7Ku…`](https://testnet.nearblocks.io/txns/Eb9QW7Ku3emuut5GLe3ABvKQVZd1t67oiU65HK1VEa8K) |
| Release (`confirm_payout`, NEAR to swiftcash) | [`BMZiSdSB…`](https://testnet.nearblocks.io/txns/BMZiSdSBRhqrXLqfzmFH53HpNBa3oTMMTeAcRAqDt1Ww) |
| Token payment (`ft_transfer_call`, USDC) | [`CNHk7e4v…`](https://testnet.nearblocks.io/txns/CNHk7e4vBQL3Ei973EgqwJFYwNNhKwBkPEHh9i8xtGcG) |
| Refund (underpaid USDC invoice, after deadline) | [`3ud7LgGK…`](https://testnet.nearblocks.io/txns/3ud7LgGKSk9JSer2uaKy3RvQz3k3dRGUXZ4oaoN3ALFg) |
| Scenario 1: 420 INR; swiftcash quote locked at checkout (1.248618 NEAR); merchant receives 420.00 INR | invoice [`H3XRHcex…`](https://testnet.nearblocks.io/txns/H3XRHcex4Di77SWKp5uoctwvEe4TAfeZEVp72ydcrD96), payment [`E9bSHqrP…`](https://testnet.nearblocks.io/txns/E9bSHqrPftuqf5Q94krhb4kRzyfA5sN4Y2vAUmQZmDHX), assign [`9C7u3vLs…`](https://testnet.nearblocks.io/txns/9C7u3vLs1ACJPqp5SyWvDfFxsZeWcSecqZji2ESr6nMa), release [`A5e9CNeA…`](https://testnet.nearblocks.io/txns/A5e9CNeA9oktJHWVFC3nsCVW3DBSc4uLHk3XqNemgCHw) |
| Scenario 2: 4.50 EUR in wETH; payrail locked, never pays, **reassigned** to quickfx (4.45 EUR) | payment [`6BscuGpJ…`](https://testnet.nearblocks.io/txns/6BscuGpJYkujB83XHe1WpZyMQouCL7XXNqiEGStYW98k), assign [`Bmnyc7Bz…`](https://testnet.nearblocks.io/txns/Bmnyc7Bzi9WqGN4FTEPEMMUGqtqTBNSr3CP7YLqqJMx4), reassign [`9gYv9b8J…`](https://testnet.nearblocks.io/txns/9gYv9b8JMC9rR8VwGcFF84Ns33jhCBmgcPu8wWpTv8kr), release [`AnpVX8tF…`](https://testnet.nearblocks.io/txns/AnpVX8tFNeo1dyq7KXnCKHDH5QzD1qhZjkPmeRzZdocP) |
| Scenario 3: 650 KES in USDC, 80% then top-up; merchant receives 650.00 KES | underpay [`FHEFkkuV…`](https://testnet.nearblocks.io/txns/FHEFkkuVEGvZqRYzGXTfHEfy7yMwn88EFYL1rBJcCYP8), top-up [`Aa5w3NNa…`](https://testnet.nearblocks.io/txns/Aa5w3NNarRrafophcxVaA5SS2jpaq3UkdN5Xz8J9PjKZ), assign [`cXvme34U…`](https://testnet.nearblocks.io/txns/cXvme34UuBLG6sNRDsePTAGMvsueaC7peqpkLBbqAUy), release [`CFrDsUtK…`](https://testnet.nearblocks.io/txns/CFrDsUtKem5HsiyfqYgn3aUsPy38UjDfyj4mjfdV1XGa) |

## On mainnet

On mainnet, the checkout would accept almost any token on almost any chain (BTC, ETH, SOL, stablecoins and more) through NEAR Intents. The customer deposits on their own chain, solvers deliver the agreed asset into the INPay escrow contract, and the invoice rules stay as they are. The three simulated providers would be replaced by licensed offramp providers' quote and payout APIs, and the mock bank webhook by the merchant bank's payment notifications. The escrow and release rule do not change: the provider receives the crypto only after the merchant's bank confirms the local-currency payout.

## Repository layout

```
contract/            Rust escrow contract; contract/res/*.wasm are the built inpay and FT contracts
server/              config, pricing, auction, rates, mock bank, providers, merchant agent, API (one process)
server/chain/        Chain interface: near.ts (testnet, near-api-js) and memory.ts (offline, same rules)
web/                 Vite + React: merchant dashboard, checkout /pay/:id, simulated bank /bank/:merchant
scripts/             setup, smoke, sim, demo, scenarios, build-contract, test-contract
tests/               contract.sandbox.test.ts (near-workspaces) and unit/ tests
```

Build notes: the wasm is built with Rust 1.86 (`rust-toolchain.toml`), because newer rustc emits wasm features the NEAR VM may reject. `npm run build:contract` rebuilds `inpay.wasm`; add `-- --ft` to rebuild the FT token from near-examples/FT. The public `rpc.testnet.near.org` is deprecated, so the default RPC is `https://test.rpc.fastnear.com` (`NEAR_RPC_URL` overrides it); the server caches views and retries on HTTP 429.

Keys: `npm run setup` writes keys to `.keys/` and the master key lives in `.env`; both are gitignored. Server-held keys are a testnet demo convenience.


## License

MIT, see [LICENSE]
