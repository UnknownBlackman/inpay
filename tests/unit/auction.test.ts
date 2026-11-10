import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advantagePct, pickQuote, rankQuotes, type Quote } from '../../server/auction.ts';

// crypto_in: fixed crypto amount, compare fiat
const q = (provider: string, fiat: string, eta: number, valid = Infinity): Quote => ({
  quote_id: `${provider}-1`, kind: 'crypto_in', provider, asset: 'near', amount: '1', currency: 'INR', rate: 0,
  fiat_amount: fiat, spread_bps: 0, eta_seconds: eta, valid_until: valid,
});
// fiat_target: fixed fiat payout, compare crypto needed
const t = (provider: string, amount: string, eta: number, valid = Infinity): Quote => ({
  quote_id: `${provider}-t`, kind: 'fiat_target', provider, asset: 'near', amount, currency: 'INR', rate: 0,
  fiat_amount: '42000', spread_bps: 0, eta_seconds: eta, valid_until: valid,
});

test('crypto_in: highest fiat_amount wins', () => {
  assert.deepEqual(rankQuotes([q('a', '100', 1), q('b', '300', 9), q('c', '200', 1)]).map((x) => x.provider), ['b', 'c', 'a']);
});

test('fiat_target: least crypto for the same payout wins', () => {
  assert.deepEqual(rankQuotes([t('a', '1025', 1), t('b', '1008', 9), t('c', '1015', 1)]).map((x) => x.provider), ['b', 'c', 'a']);
});

test('tie-break: lower eta, then provider name', () => {
  assert.deepEqual(rankQuotes([q('zeta', '100', 2), q('beta', '100', 5), q('alpha', '100', 2)]).map((x) => x.provider), ['alpha', 'zeta', 'beta']);
  assert.deepEqual(rankQuotes([t('zeta', '100', 2), t('beta', '100', 5), t('alpha', '100', 2)]).map((x) => x.provider), ['alpha', 'zeta', 'beta']);
});

test('compares amounts as integers, not strings', () => {
  assert.equal(rankQuotes([q('a', '99', 1), q('b', '100', 1)])[0].provider, 'b');
  assert.equal(rankQuotes([t('a', '100', 1), t('b', '99', 1)])[0].provider, 'b');
});

test('pickQuote skips failed providers and expired quotes', () => {
  const quotes = [q('payrail', '443', 3, 1000), q('quickfx', '438', 2, 5000), q('swiftcash', '450', 5, 10)];
  assert.equal(pickQuote(quotes, [], 0)?.provider, 'swiftcash');
  assert.equal(pickQuote(quotes, [], 100)?.provider, 'payrail'); // swiftcash expired
  assert.equal(pickQuote(quotes, ['payrail'], 100)?.provider, 'quickfx');
  assert.equal(pickQuote(quotes, ['payrail', 'quickfx'], 100), undefined);
});

test('advantage over the worst quote', () => {
  assert.equal(advantagePct([q('a', '41664', 5), q('b', '40950', 2), q('c', '41370', 3)]), 1.7); // merchant gets more
  assert.equal(advantagePct([t('a', '1008', 5), t('b', '1025', 2)]), 1.6); // customer sends less
  assert.equal(advantagePct([q('a', '1', 1)]), 0);
});
