// The three seeded demo scenarios (each worth about 5 USD).
import type { AssetKey, MerchantName } from '../server/config.ts';

export interface Scenario {
  n: number;
  merchant: MerchantName;
  price: string; // in the merchant's currency
  memo: string;
  asset: AssetKey;
  underpayFirst: boolean;
  story: string;
}

export const SCENARIOS: Scenario[] = [
  { n: 1, merchant: 'bengaluru-cafe', price: '420', memo: 'Masala dosa and filter coffee x2', asset: 'near', underpayFirst: false,
    story: 'INR merchant, customer pays in NEAR: normal flow' },
  { n: 2, merchant: 'berlin-bikes', price: '4.50', memo: 'Inner tube repair', asset: 'eth', underpayFirst: false,
    story: 'EUR merchant, customer pays in ETH (wETH): payrail wins but never pays (FAIL_PROVIDER=payrail), agent reassigns to quickfx' },
  { n: 3, merchant: 'nairobi-tailor', price: '650', memo: 'Shirt alteration', asset: 'usdc', underpayFirst: true,
    story: 'KES merchant, customer pays in USDC but sends 80% first: Underpaid, top-up, then normal flow' },
];
