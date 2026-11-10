// The agent and API talk to the escrow contract only through this interface.
// NearChain = real NEAR testnet (near-api-js). MemoryChain = same rules in memory (sim, unit tests).
export type Status = 'Open' | 'Underpaid' | 'Paid' | 'Assigned' | 'Settled' | 'Refunded';

/** JSON shape returned by the contract's get_invoice / get_invoices. */
export interface Invoice {
  id: number;
  merchant: string;
  asset: string; // "near" or token account id
  amount: string;
  paid: string;
  customer: string | null;
  status: Status;
  provider: string | null;
  fiat_amount: string | null;
  fiat_currency: string | null;
  quote_id: string | null;
  payout_ref: string | null;
  deadline: number; // ms
  created_at: number; // ms
}

export interface TxResult<T = unknown> {
  hash: string;
  value?: T;
}

export interface Chain {
  readonly kind: 'near' | 'memory';
  readonly contractId: string;
  /** asset key ("near" | "eth" | "usdc") -> on-chain asset string used in invoices */
  assetId(asset: 'near' | 'eth' | 'usdc'): string;
  getInvoice(id: number): Promise<Invoice | null>;
  getInvoices(merchant: string): Promise<Invoice[]>;
  createInvoice(merchant: string, asset: string, amount: bigint, deadlineMinutes: number): Promise<TxResult<number>>;
  /** Pays `amount` of the invoice's asset from `payer` (pay_near or ft_transfer_call). */
  pay(payer: string, id: number, asset: string, amount: bigint): Promise<TxResult>;
  assignProvider(merchant: string, id: number, provider: string, fiatAmount: bigint, currency: string, quoteId: string, reassign: boolean): Promise<TxResult>;
  confirmPayout(merchant: string, id: number, payoutRef: string): Promise<TxResult>;
  refund(caller: string, id: number): Promise<TxResult>;
  /** Balance of an account in an asset, smallest units. */
  balanceOf(account: string, asset: string): Promise<bigint>;
  /** Explorer URL for a tx hash, or undefined in memory mode. */
  txUrl(hash: string): string | undefined;
}
