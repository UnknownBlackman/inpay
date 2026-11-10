//! INPay escrow contract.
//!
//! A merchant creates an invoice for an exact amount of one asset ("near" or an
//! allowlisted NEP-141 token). The customer pays into this contract. The merchant's
//! agent assigns an offramp provider, and only after the local-currency payout has
//! reached the merchant's bank does the merchant call `confirm_payout`, which
//! releases the escrowed crypto to the provider. Unpaid invoices can be refunded
//! by anyone after the deadline.

use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json};
use near_sdk::store::LookupMap;
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PromiseOrValue,
};

pub const NEAR_ASSET: &str = "near";
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_CALLBACK: Gas = Gas::from_tgas(10);
const MAX_DEADLINE_MINUTES: u32 = 7 * 24 * 60;

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Status {
    Open,
    Underpaid,
    Paid,
    Assigned,
    Settled,
    Refunded,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Invoice {
    pub id: u64,
    pub merchant: AccountId,
    /// "near" or the account id of an allowlisted NEP-141 token.
    pub asset: String,
    /// Amount due, in the asset's smallest unit.
    pub amount: U128,
    /// Amount received so far (never above `amount`; excess is returned).
    pub paid: U128,
    pub customer: Option<AccountId>,
    pub status: Status,
    pub provider: Option<AccountId>,
    /// Local-currency payout promised by the provider, in minor units (e.g. paise, cents).
    pub fiat_amount: Option<U128>,
    pub fiat_currency: Option<String>,
    pub quote_id: Option<String>,
    pub payout_ref: Option<String>,
    /// Unix time in milliseconds after which an unpaid invoice can be refunded.
    pub deadline: u64,
    pub created_at: u64,
}

#[near(serializers = [json])]
struct PayMsg {
    invoice_id: u64,
}

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Invoices,
    ByMerchant,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    tokens: Vec<AccountId>,
    invoices: LookupMap<u64, Invoice>,
    by_merchant: LookupMap<AccountId, Vec<u64>>,
    next_id: u64,
}

fn now_ms() -> u64 {
    env::block_timestamp_ms()
}

fn emit(event: &str, data: serde_json::Value) {
    let ev = json!({ "standard": "inpay", "version": "1.0.0", "event": event, "data": [data] });
    env::log_str(&format!("EVENT_JSON:{}", ev));
}

#[near]
impl Contract {
    #[init]
    pub fn new(tokens: Vec<AccountId>) -> Self {
        Self {
            tokens,
            invoices: LookupMap::new(StorageKey::Invoices),
            by_merchant: LookupMap::new(StorageKey::ByMerchant),
            next_id: 0,
        }
    }

    // ---------------------------------------------------------------- merchant

    /// Caller becomes the merchant. Returns the new invoice id.
    pub fn create_invoice(&mut self, asset: String, amount: U128, deadline_minutes: u32) -> u64 {
        require!(
            asset == NEAR_ASSET || self.is_allowed_token(&asset),
            "asset must be \"near\" or an allowlisted token"
        );
        require!(amount.0 > 0, "amount must be positive");
        require!(
            deadline_minutes > 0 && deadline_minutes <= MAX_DEADLINE_MINUTES,
            "deadline_minutes out of range"
        );
        let merchant = env::predecessor_account_id();
        let id = self.next_id;
        self.next_id += 1;
        let now = now_ms();
        let inv = Invoice {
            id,
            merchant: merchant.clone(),
            asset,
            amount,
            paid: U128(0),
            customer: None,
            status: Status::Open,
            provider: None,
            fiat_amount: None,
            fiat_currency: None,
            quote_id: None,
            payout_ref: None,
            deadline: now + deadline_minutes as u64 * 60_000,
            created_at: now,
        };
        self.invoices.insert(id, inv);
        self.by_merchant.entry(merchant).or_default().push(id);
        id
    }

    pub fn assign_provider(
        &mut self,
        id: u64,
        provider: AccountId,
        fiat_amount: U128,
        fiat_currency: String,
        quote_id: String,
    ) {
        let mut inv = self.merchant_invoice(id);
        require!(inv.status == Status::Paid, "invoice must be Paid to assign");
        self.set_provider(&mut inv, provider, fiat_amount, fiat_currency, quote_id, false);
    }

    pub fn reassign_provider(
        &mut self,
        id: u64,
        provider: AccountId,
        fiat_amount: U128,
        fiat_currency: String,
        quote_id: String,
    ) {
        let mut inv = self.merchant_invoice(id);
        require!(inv.status == Status::Assigned, "invoice must be Assigned to reassign");
        self.set_provider(&mut inv, provider, fiat_amount, fiat_currency, quote_id, true);
    }

    /// Release rule: the merchant calls this only after the local-currency payout has
    /// arrived in their bank. Sends exactly `amount` of the invoice's asset to the provider.
    pub fn confirm_payout(&mut self, id: u64, payout_ref: String) -> Promise {
        let mut inv = self.merchant_invoice(id);
        require!(inv.status == Status::Assigned, "invoice must be Assigned to confirm");
        require!(!payout_ref.is_empty(), "payout_ref required");
        let provider = inv.provider.clone().expect("assigned invoice has a provider");
        inv.status = Status::Settled;
        inv.payout_ref = Some(payout_ref.clone());
        let amount = inv.amount;
        let asset = inv.asset.clone();
        self.invoices.insert(id, inv);
        emit(
            "settled",
            json!({ "invoice_id": id, "provider": provider, "asset": asset, "amount": amount, "payout_ref": payout_ref }),
        );
        self.send(&asset, provider, amount)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_send(id, Status::Assigned))
    }

    // ---------------------------------------------------------------- customer

    #[payable]
    pub fn pay_near(&mut self, id: u64) {
        let payer = env::predecessor_account_id();
        let deposit = env::attached_deposit().as_yoctonear();
        let excess = self.apply_payment(id, NEAR_ASSET, &payer, deposit);
        if excess > 0 {
            let _ = Promise::new(payer).transfer(NearToken::from_yoctonear(excess));
        }
    }

    /// NEP-141 receiver. `msg` = {"invoice_id": n}. Panicking rejects the transfer
    /// (the token contract returns everything to the sender). The returned value is
    /// the unused amount, which the token contract refunds to the sender.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        let token = env::predecessor_account_id();
        require!(self.is_allowed_token(token.as_str()), "token not allowlisted");
        let m: PayMsg = serde_json::from_str(&msg).unwrap_or_else(|_| env::panic_str("msg must be {\"invoice_id\": n}"));
        let excess = self.apply_payment(m.invoice_id, token.as_str(), &sender_id, amount.0);
        PromiseOrValue::Value(U128(excess))
    }

    /// Anyone may call. Only for Open/Underpaid invoices past their deadline.
    /// Returns everything paid to the customer, in the same asset.
    pub fn refund(&mut self, id: u64) -> PromiseOrValue<()> {
        let mut inv = self.get(id);
        require!(
            matches!(inv.status, Status::Open | Status::Underpaid),
            "only Open or Underpaid invoices can be refunded"
        );
        require!(now_ms() > inv.deadline, "deadline has not passed");
        let prev = inv.status;
        let paid = inv.paid;
        inv.status = Status::Refunded;
        let customer = inv.customer.clone();
        let asset = inv.asset.clone();
        self.invoices.insert(id, inv);
        emit("refunded", json!({ "invoice_id": id, "customer": customer, "asset": asset, "amount": paid }));
        match customer {
            Some(c) if paid.0 > 0 => PromiseOrValue::Promise(
                self.send(&asset, c, paid)
                    .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_send(id, prev)),
            ),
            _ => PromiseOrValue::Value(()),
        }
    }

    /// Restores the previous status if the outgoing transfer failed, so it can be retried.
    #[private]
    pub fn on_send(&mut self, id: u64, revert_to: Status) -> bool {
        if near_sdk::is_promise_success() {
            return true;
        }
        let mut inv = self.get(id);
        inv.status = revert_to;
        if revert_to == Status::Assigned {
            inv.payout_ref = None;
        }
        self.invoices.insert(id, inv);
        emit("send_failed", json!({ "invoice_id": id, "status": revert_to }));
        false
    }

    // ---------------------------------------------------------------- views

    pub fn get_invoice(&self, id: u64) -> Option<Invoice> {
        self.invoices.get(&id).cloned()
    }

    pub fn get_invoices(&self, merchant: AccountId) -> Vec<Invoice> {
        self.by_merchant
            .get(&merchant)
            .map(|ids| ids.iter().filter_map(|id| self.invoices.get(id).cloned()).collect())
            .unwrap_or_default()
    }

    pub fn get_tokens(&self) -> Vec<AccountId> {
        self.tokens.clone()
    }

    // ---------------------------------------------------------------- internal

    fn is_allowed_token(&self, asset: &str) -> bool {
        self.tokens.iter().any(|t| t.as_str() == asset)
    }

    fn get(&self, id: u64) -> Invoice {
        self.invoices.get(&id).cloned().unwrap_or_else(|| env::panic_str("invoice not found"))
    }

    fn merchant_invoice(&self, id: u64) -> Invoice {
        let inv = self.get(id);
        require!(env::predecessor_account_id() == inv.merchant, "only the merchant can do this");
        inv
    }

    /// Shared rules for NEAR and token payments. Returns the excess to give back.
    fn apply_payment(&mut self, id: u64, asset: &str, payer: &AccountId, amount: u128) -> u128 {
        let mut inv = self.get(id);
        require!(inv.asset == asset, "wrong asset for this invoice");
        require!(
            matches!(inv.status, Status::Open | Status::Underpaid),
            "invoice is not awaiting payment"
        );
        require!(now_ms() <= inv.deadline, "invoice deadline has passed");
        require!(amount > 0, "payment must be positive");
        if inv.customer.is_none() {
            inv.customer = Some(payer.clone());
        }
        let total = inv.paid.0 + amount;
        let (paid, excess) = if total >= inv.amount.0 { (inv.amount.0, total - inv.amount.0) } else { (total, 0) };
        inv.paid = U128(paid);
        let data = json!({
            "invoice_id": id, "payer": payer, "asset": asset, "received": U128(amount),
            "paid": U128(paid), "amount": inv.amount, "excess_returned": U128(excess),
        });
        if paid >= inv.amount.0 {
            inv.status = Status::Paid;
            emit("paid", data);
        } else {
            inv.status = Status::Underpaid;
            emit("underpaid", data);
        }
        self.invoices.insert(id, inv);
        excess
    }

    fn set_provider(
        &mut self,
        inv: &mut Invoice,
        provider: AccountId,
        fiat_amount: U128,
        fiat_currency: String,
        quote_id: String,
        reassigned: bool,
    ) {
        require!(fiat_amount.0 > 0, "fiat_amount must be positive");
        let previous = inv.provider.clone();
        inv.status = Status::Assigned;
        inv.provider = Some(provider.clone());
        inv.fiat_amount = Some(fiat_amount);
        inv.fiat_currency = Some(fiat_currency.clone());
        inv.quote_id = Some(quote_id.clone());
        let id = inv.id;
        self.invoices.insert(id, inv.clone());
        emit(
            "assigned",
            json!({ "invoice_id": id, "provider": provider, "fiat_amount": fiat_amount, "fiat_currency": fiat_currency,
                    "quote_id": quote_id, "reassigned": reassigned, "previous_provider": previous }),
        );
    }

    fn send(&self, asset: &str, to: AccountId, amount: U128) -> Promise {
        if asset == NEAR_ASSET {
            Promise::new(to).transfer(NearToken::from_yoctonear(amount.0))
        } else {
            let token: AccountId = asset.parse().unwrap();
            Promise::new(token).function_call(
                "ft_transfer".to_string(),
                serde_json::to_vec(&json!({ "receiver_id": to, "amount": amount, "memo": "inpay" })).unwrap(),
                NearToken::from_yoctonear(1),
                GAS_FT_TRANSFER,
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    const MIN: u64 = 60_000_000_000; // one minute in ns

    fn ctx(pred: usize, deposit: u128, ts: u64) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(accounts(pred))
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .block_timestamp(ts)
            .build());
    }

    fn setup() -> Contract {
        ctx(0, 0, 0);
        Contract::new(vec!["weth.test".parse().unwrap(), "usdc.test".parse().unwrap()])
    }

    #[test]
    fn near_exact_and_partial() {
        let mut c = setup();
        ctx(1, 0, 0);
        let id = c.create_invoice("near".into(), U128(100), 10);
        ctx(2, 40, MIN);
        c.pay_near(id);
        assert_eq!(c.get_invoice(id).unwrap().status, Status::Underpaid);
        ctx(3, 70, MIN);
        c.pay_near(id);
        let inv = c.get_invoice(id).unwrap();
        assert_eq!(inv.status, Status::Paid);
        assert_eq!(inv.paid.0, 100);
        assert_eq!(inv.customer.unwrap(), accounts(2));
    }

    #[test]
    #[should_panic(expected = "wrong asset")]
    fn near_on_token_invoice_rejected() {
        let mut c = setup();
        ctx(1, 0, 0);
        let id = c.create_invoice("usdc.test".into(), U128(100), 10);
        ctx(2, 100, 0);
        c.pay_near(id);
    }

    #[test]
    #[should_panic(expected = "only the merchant")]
    fn only_merchant_assigns() {
        let mut c = setup();
        ctx(1, 0, 0);
        let id = c.create_invoice("near".into(), U128(100), 10);
        ctx(2, 100, 0);
        c.pay_near(id);
        ctx(3, 0, 0);
        c.assign_provider(id, accounts(4), U128(5), "INR".into(), "q1".into());
    }

    #[test]
    fn lifecycle_and_refund_rules() {
        let mut c = setup();
        ctx(1, 0, 0);
        let id = c.create_invoice("near".into(), U128(100), 1);
        ctx(2, 100, 0);
        c.pay_near(id);
        ctx(1, 0, 0);
        c.assign_provider(id, accounts(4), U128(5), "INR".into(), "q1".into());
        c.reassign_provider(id, accounts(5), U128(4), "INR".into(), "q2".into());
        let _ = c.confirm_payout(id, "ref-1".into());
        let inv = c.get_invoice(id).unwrap();
        assert_eq!(inv.status, Status::Settled);
        assert_eq!(inv.provider.unwrap(), accounts(5));
        assert_eq!(c.get_invoices(accounts(1)).len(), 1);
    }

    #[test]
    #[should_panic(expected = "deadline has not passed")]
    fn refund_before_deadline_fails() {
        let mut c = setup();
        ctx(1, 0, 0);
        let id = c.create_invoice("near".into(), U128(100), 1);
        ctx(2, 50, 0);
        c.pay_near(id);
        c.refund(id);
    }

    #[test]
    fn refund_after_deadline() {
        let mut c = setup();
        ctx(1, 0, 0);
        let id = c.create_invoice("near".into(), U128(100), 1);
        ctx(2, 50, 0);
        c.pay_near(id);
        ctx(3, 0, 2 * MIN);
        let _ = c.refund(id);
        assert_eq!(c.get_invoice(id).unwrap().status, Status::Refunded);
    }
}
