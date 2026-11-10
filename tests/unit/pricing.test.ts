import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convert, fmtAsset, fmtFiat, parseUnits, type Rates } from '../../server/pricing.ts';

const rates: Rates = { usd: { near: 2.5, eth: 3200, usdc: 1 }, fx: { INR: 84, EUR: 0.92, KES: 129 }, source: 'fallback', at: 0 };

test('fiat -> asset: 420 INR = 5 USD = 2 NEAR exactly', () => {
  assert.equal(convert(42000n, { currency: 'INR' }, { asset: 'near' }, rates), 2n * 10n ** 24n);
});

test('asset -> fiat with spread: 2 NEAR at 0.8% spread', () => {
  // 2 * 2.5 * 84 = 420.00 INR; minus 0.8% = 416.64 INR
  assert.equal(convert(2n * 10n ** 24n, { asset: 'near' }, { currency: 'INR' }, rates, { spreadBps: 80 }), 41664n);
});

test('quote formula: amount x usd_price x fx x (1 - spread), integer minor units', () => {
  const wei = 1_528_000_000_000_000n; // 0.001528 ETH
  // 0.001528 * 3200 * 0.92 * 0.985 = 4.4309... EUR -> 443 cents (floor)
  assert.equal(convert(wei, { asset: 'eth' }, { currency: 'EUR' }, rates, { spreadBps: 150 }), 443n);
});

test('gross-up: crypto needed so that after a 0.8% spread the merchant gets the full price', () => {
  const need = convert(42000n, { currency: 'INR' }, { asset: 'near' }, rates, { grossUpBps: 80, round: 'up' });
  assert.equal(need, 2_016_129_032_258_064_516_129_033n); // 2 NEAR / 0.992, rounded up
  assert.equal(convert(need, { asset: 'near' }, { currency: 'INR' }, rates, { spreadBps: 80 }), 42000n);
  assert.equal(convert(need - 10n ** 18n, { asset: 'near' }, { currency: 'INR' }, rates, { spreadBps: 80 }), 41999n);
});

test('rounding: up for what the customer pays, down for payouts', () => {
  const down = convert(65000n, { currency: 'KES' }, { asset: 'usdc' }, rates);
  const up = convert(65000n, { currency: 'KES' }, { asset: 'usdc' }, rates, { round: 'up' });
  assert.equal(down, 5038759n); // 650/129 = 5.0387596...
  assert.equal(up, 5038760n);
  // paying the rounded-up amount is never worth less than the price
  assert.ok(convert(up, { asset: 'usdc' }, { currency: 'KES' }, rates) >= 65000n);
});

test('asset -> asset and zero', () => {
  assert.equal(convert(10n ** 18n, { asset: 'eth' }, { asset: 'usdc' }, rates), 3200n * 10n ** 6n);
  assert.equal(convert(0n, { asset: 'eth' }, { currency: 'EUR' }, rates), 0n);
});

test('returns bigint, rejects bad rates and negative amounts', () => {
  assert.equal(typeof convert(1n, { asset: 'usdc' }, { currency: 'EUR' }, rates), 'bigint');
  assert.throws(() => convert(-1n, { asset: 'usdc' }, { currency: 'EUR' }, rates));
  assert.throws(() => convert(1n, { asset: 'usdc' }, { currency: 'EUR' }, { ...rates, fx: { ...rates.fx, EUR: 0 } }));
});

test('parse and format', () => {
  assert.equal(parseUnits('4.50', 2), 450n);
  assert.equal(parseUnits('420', 2), 42000n);
  assert.throws(() => parseUnits('1.234', 2));
  assert.throws(() => parseUnits('-1', 2));
  assert.equal(fmtFiat(41370n, 'INR'), '413.70 INR');
  assert.equal(fmtAsset(1_528_000_000_000_000n, 'eth'), '0.001528 ETH');
});
