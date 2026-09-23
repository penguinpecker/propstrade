//! gmsol-sdk 0.10.0 compiled to WASM, plus Props.trade's order simulation entry points.
//!
//! gmsol-sdk's own JS classes are exported unchanged. The functions below run the same
//! gmsol-model code the store program runs, on raw account images, and return every number as a
//! decimal string in GMTrade units (USD values 1e20, token amounts in base units, prices as unit
//! prices = USD * 10^(20 - token decimals)), so callers never decode borsh or lose precision.

use std::{collections::BTreeMap, str::FromStr, sync::Arc};

use gmsol_sdk::{
    market::MarketCalculations,
    model::{
        action::decrease_position::DecreasePositionFlags,
        num::Unsigned,
        price::{Price, Prices},
        BorrowingFeeMarket, BorrowingFeeMarketExt, MarketAction, MarketModel, PerpMarketExt,
        PerpMarketMutExt, PoolExt, Position as _, PositionExt, PositionImpactMarketMutExt,
        PositionModel, PositionMutExt, PositionState, PositionStateMut, VirtualInventoryModel,
    },
    position::PositionCalculations,
    programs::{
        anchor_lang::{prelude::Pubkey, Discriminator, ZeroCopy},
        bytemuck,
        gmsol_store::accounts::{Market, Position, VirtualInventory},
    },
    utils::{base64::encode_base64, zero_copy::try_deserialize_zero_copy_from_base64},
};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

#[derive(Deserialize)]
struct PriceInput {
    min: String,
    max: String,
}

#[derive(Deserialize)]
struct PricesInput {
    index: PriceInput,
    long: PriceInput,
    short: PriceInput,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MarketInput {
    /// Base64 `Market` account data, discriminator included.
    market: String,
    /// Base64 `VirtualInventory` account data by address, required when the market uses one.
    #[serde(default)]
    virtual_inventories: BTreeMap<String, String>,
    prices: PricesInput,
    /// Order fee discount factor (1e20 = 100%) from the owner's referral / GT rank.
    #[serde(default)]
    order_fee_discount_factor: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IncreaseArgs {
    market: MarketInput,
    /// Base64 `Position` account data of an existing position; omitted to open a new one.
    position: Option<String>,
    is_long: bool,
    collateral_token: String,
    collateral_amount: String,
    size_delta_usd: String,
    acceptable_price: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DecreaseArgs {
    market: MarketInput,
    position: String,
    size_delta_usd: String,
    #[serde(default)]
    collateral_withdrawal_amount: Option<String>,
    acceptable_price: Option<String>,
    /// Run as a keeper liquidation (liquidation fee charged, insolvent close allowed).
    #[serde(default)]
    liquidation: bool,
}

#[derive(Deserialize)]
struct StatusArgs {
    market: MarketInput,
    position: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Fees {
    order_fee_value: String,
    borrowing_fee_amount: String,
    funding_fee_amount: String,
    liquidation_fee_value: Option<String>,
    total_cost_amount: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PositionOut {
    /// Base64 `Position` account data after the action, discriminator included.
    account: String,
    size_in_usd: String,
    size_in_tokens: String,
    collateral_amount: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct IncreaseResult {
    execution_price: String,
    price_impact_value: String,
    size_delta_in_tokens: String,
    collateral_delta_amount: String,
    fees: Fees,
    position: PositionOut,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DecreaseResult {
    execution_price: String,
    price_impact_value: String,
    price_impact_diff: String,
    size_delta_usd: String,
    size_delta_in_tokens: String,
    pnl: String,
    uncapped_pnl: String,
    fees: Fees,
    output_amount: String,
    secondary_output_amount: String,
    claimable_for_user: String,
    insolvent_close_step: Option<String>,
    /// `None` when the position is fully closed.
    position: Option<PositionOut>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusResult {
    entry_price: String,
    collateral_value: String,
    pending_pnl: String,
    pending_borrowing_fee_value: String,
    pending_funding_fee_value: String,
    close_order_fee_value: String,
    net_value: String,
    leverage: Option<String>,
    liquidation_price: Option<String>,
    /// GMTrade's own liquidation check (`check_liquidatable(.., for_liquidation = true)`).
    liquidatable: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MarketStatusResult {
    funding_rate_per_second_for_long: String,
    funding_rate_per_second_for_short: String,
    borrowing_rate_per_second_for_long: String,
    borrowing_rate_per_second_for_short: String,
    open_interest_for_long: String,
    open_interest_for_short: String,
    /// Additional open interest each side accepts (reserve and max-OI limits).
    liquidity_for_long: String,
    liquidity_for_short: String,
    /// LP pool value backing each side, without trader PnL (min price).
    pool_value_for_long: String,
    pool_value_for_short: String,
    min_collateral_factor_for_long: String,
    min_collateral_factor_for_short: String,
}

fn err(e: impl std::fmt::Display) -> JsError {
    JsError::new(&e.to_string())
}

fn num<T: FromStr>(s: &str, what: &str) -> Result<T, JsError> {
    s.parse().map_err(|_| err(format!("invalid {what}: {s:?}")))
}

fn decode<T: ZeroCopy>(b64: &str) -> Result<T, JsError> {
    Ok(try_deserialize_zero_copy_from_base64::<T>(b64)
        .map_err(err)?
        .into_inner())
}

fn price(p: &PriceInput, what: &str) -> Result<Price<u128>, JsError> {
    Ok(Price {
        min: num(&p.min, what)?,
        max: num(&p.max, what)?,
    })
}

enum Seed {
    Existing(Position),
    Empty {
        is_long: bool,
        collateral_token: Pubkey,
    },
}

struct Env {
    market: MarketModel,
    vis: BTreeMap<Pubkey, VirtualInventoryModel>,
    prices: Prices<u128>,
}

impl Env {
    fn new(input: &MarketInput) -> Result<Self, JsError> {
        let market: Market = decode(&input.market)?;
        let mut vis = BTreeMap::new();
        for (address, data) in &input.virtual_inventories {
            let vi: VirtualInventory = decode(data)?;
            vis.insert(
                num(address, "virtual inventory address")?,
                VirtualInventoryModel::from_parts(Arc::new(vi)),
            );
        }
        for key in [
            market.virtual_inventory_for_positions,
            market.virtual_inventory_for_swaps,
        ] {
            if key != Pubkey::default() && !vis.contains_key(&key) {
                return Err(err(format!("missing virtual inventory account {key}")));
            }
        }
        let prices = Prices {
            index_token_price: price(&input.prices.index, "index price")?,
            long_token_price: price(&input.prices.long, "long token price")?,
            short_token_price: price(&input.prices.short, "short token price")?,
        };
        let mut market = update_fees_state(market, &prices)?;
        if let Some(factor) = &input.order_fee_discount_factor {
            market.set_order_fee_discount_factor(num(factor, "order fee discount factor")?);
        }
        Ok(Self {
            market,
            vis,
            prices,
        })
    }

    /// Runs `f` on a position model with the market's virtual inventories attached.
    fn run<T>(
        &mut self,
        seed: Seed,
        f: impl FnOnce(&mut PositionModel, &Prices<u128>) -> Result<T, JsError>,
    ) -> Result<(T, PositionModel), JsError> {
        let prices = self.prices;
        self.market.with_vi_models(&mut self.vis, |market| {
            let mut model = match seed {
                Seed::Existing(p) => {
                    let mut model = PositionModel::new(market.clone(), Arc::new(p)).map_err(err)?;
                    floor_fee_snapshots(&mut model).map_err(err)?;
                    model
                }
                Seed::Empty {
                    is_long,
                    collateral_token,
                } => market
                    .clone()
                    .into_empty_position(is_long, collateral_token)
                    .map_err(err)?,
            };
            let out = f(&mut model, &prices)?;
            Ok((out, model))
        })
    }
}

/// The store program's pre-execute step (`RevertibleMarket::update_fees_state`), which runs before
/// every order and liquidation: distribute the position impact pool, then accrue borrowing and
/// funding up to now. Without it, fills and pending fees would miss everything since the market
/// last changed onchain. gmsol-programs' `MarketModel` has no `BorrowingFeeMarketMut`, so the
/// borrowing step is applied to the account the way `UpdateBorrowingState` does.
fn update_fees_state(market: Market, prices: &Prices<u128>) -> Result<MarketModel, JsError> {
    // The supply only feeds LP-token pricing, which nothing here uses.
    let mut model = MarketModel::from_parts(Arc::new(market), 0);
    model
        .distribute_position_impact()
        .and_then(|a| a.execute())
        .map_err(err)?;

    let seconds = model.passed_in_seconds_for_borrowing().map_err(err)?;
    let mut market = Market::clone(&model);
    for is_long in [true, false] {
        let (_, delta) = model
            .next_cumulative_borrowing_factor(is_long, prices, seconds)
            .map_err(err)?;
        market
            .state
            .pools
            .borrowing_factor
            .pool
            .apply_delta_amount(is_long, &delta.to_signed().map_err(err)?)
            .map_err(err)?;
    }
    market.state.clocks.borrowing += seconds as i64;

    let mut model = MarketModel::from_parts(Arc::new(market), 0);
    model
        .update_funding(prices)
        .and_then(|a| a.execute())
        .map_err(err)?;
    Ok(model)
}

/// A simulated position's fee snapshots come from an earlier run, which accrued the market up to
/// that moment at that moment's prices. Accruing the same onchain state up to now at other prices
/// can land a hair below them, which gmsol-model rejects. GMTrade's factors never decrease, so a
/// snapshot above the market's current value means nothing has accrued since. Onchain positions
/// are never affected: their snapshots were taken from committed, lower values.
fn floor_fee_snapshots(p: &mut PositionModel) -> gmsol_sdk::model::Result<()> {
    let (is_long, is_collateral_long) = (p.is_long(), p.is_collateral_token_long());
    let latest = p.market().cumulative_borrowing_factor(is_long)?;
    let snapshot = p.borrowing_factor_mut();
    *snapshot = (*snapshot).min(latest);
    let latest = p
        .market()
        .funding_fee_amount_per_size(is_long, is_collateral_long)?;
    let snapshot = p.funding_fee_amount_per_size_mut();
    *snapshot = (*snapshot).min(latest);
    for is_long_collateral in [true, false] {
        let latest = p
            .market()
            .claimable_funding_fee_amount_per_size(is_long, is_long_collateral)?;
        let snapshot = p.claimable_funding_fee_amount_per_size_mut(is_long_collateral);
        *snapshot = (*snapshot).min(latest);
    }
    Ok(())
}

fn fees(f: &gmsol_sdk::model::params::fee::PositionFees<u128>) -> Result<Fees, JsError> {
    Ok(Fees {
        order_fee_value: f.order_fees().fee_value().to_string(),
        borrowing_fee_amount: f.borrowing_fees().fee_amount().to_string(),
        funding_fee_amount: f.funding_fees().amount().to_string(),
        liquidation_fee_value: f.liquidation_fees().map(|l| l.fee_value().to_string()),
        total_cost_amount: f.total_cost_amount().map_err(err)?.to_string(),
    })
}

fn position_out(model: &PositionModel) -> PositionOut {
    let position = model.position();
    let mut account = Position::DISCRIMINATOR.to_vec();
    account.extend_from_slice(bytemuck::bytes_of(position));
    PositionOut {
        account: encode_base64(&account),
        size_in_usd: model.size_in_usd().to_string(),
        size_in_tokens: model.size_in_tokens().to_string(),
        collateral_amount: model.collateral_amount().to_string(),
    }
}

fn to_js<T: Serialize>(value: &T) -> Result<JsValue, JsError> {
    value
        .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .map_err(err)
}

/// Simulates the execution of an increase order (market or triggered limit).
#[wasm_bindgen(js_name = simulateIncrease)]
pub fn simulate_increase(args: JsValue) -> Result<JsValue, JsError> {
    let args: IncreaseArgs = serde_wasm_bindgen::from_value(args).map_err(err)?;
    let mut env = Env::new(&args.market)?;
    let position = args
        .position
        .as_deref()
        .map(decode::<Position>)
        .transpose()?;
    let collateral_token: Pubkey = num(&args.collateral_token, "collateral token")?;
    let collateral_amount: u128 = num(&args.collateral_amount, "collateral amount")?;
    let size_delta_usd: u128 = num(&args.size_delta_usd, "size delta")?;
    let acceptable_price = args
        .acceptable_price
        .as_deref()
        .map(|p| num::<u128>(p, "acceptable price"))
        .transpose()?;
    let seed = match position {
        Some(p) => Seed::Existing(p),
        None => Seed::Empty {
            is_long: args.is_long,
            collateral_token,
        },
    };
    let (report, model) = env.run(seed, |p, prices| {
        p.increase(*prices, collateral_amount, size_delta_usd, acceptable_price)
            .and_then(|action| action.execute())
            .map_err(err)
    })?;
    let execution = report.execution();
    to_js(&IncreaseResult {
        execution_price: execution.execution_price().to_string(),
        price_impact_value: execution.price_impact_value().to_string(),
        size_delta_in_tokens: execution.size_delta_in_tokens().to_string(),
        collateral_delta_amount: report.collateral_delta_amount().to_string(),
        fees: fees(report.fees())?,
        position: position_out(&model),
    })
}

/// Simulates the execution of a decrease order, or a keeper liquidation with `liquidation: true`.
#[wasm_bindgen(js_name = simulateDecrease)]
pub fn simulate_decrease(args: JsValue) -> Result<JsValue, JsError> {
    let args: DecreaseArgs = serde_wasm_bindgen::from_value(args).map_err(err)?;
    let mut env = Env::new(&args.market)?;
    let position: Position = decode(&args.position)?;
    let size_delta_usd: u128 = num(&args.size_delta_usd, "size delta")?;
    let withdrawal: u128 = match &args.collateral_withdrawal_amount {
        Some(a) => num(a, "collateral withdrawal amount")?,
        None => 0,
    };
    let acceptable_price = args
        .acceptable_price
        .as_deref()
        .map(|p| num::<u128>(p, "acceptable price"))
        .transpose()?;
    let flags = DecreasePositionFlags {
        is_insolvent_close_allowed: args.liquidation,
        is_liquidation_order: args.liquidation,
        is_cap_size_delta_usd_allowed: false,
    };
    let (report, model) = env.run(Seed::Existing(position), |p, prices| {
        p.decrease(*prices, size_delta_usd, acceptable_price, withdrawal, flags)
            .and_then(|action| action.execute())
            .map_err(err)
    })?;
    to_js(&DecreaseResult {
        execution_price: report.execution_price().to_string(),
        price_impact_value: report.price_impact_value().to_string(),
        price_impact_diff: report.price_impact_diff().to_string(),
        size_delta_usd: report.size_delta_usd().to_string(),
        size_delta_in_tokens: report.size_delta_in_tokens().to_string(),
        pnl: report.pnl().pnl().to_string(),
        uncapped_pnl: report.pnl().uncapped_pnl().to_string(),
        fees: fees(report.fees())?,
        output_amount: report.output_amount().to_string(),
        secondary_output_amount: report.secondary_output_amount().to_string(),
        claimable_for_user: report
            .claimable_collateral_for_user()
            .output_token_amount()
            .to_string(),
        insolvent_close_step: report.insolvent_close_step().map(|s| format!("{s:?}")),
        position: (!report.should_remove()).then(|| position_out(&model)),
    })
}

/// Position status (PnL, pending fees, net value, leverage, liquidation price) at the given
/// prices, using gmsol-sdk's calculation with the liquidation-price fix from GMTrade's HEAD.
#[wasm_bindgen(js_name = positionStatus)]
pub fn position_status(args: JsValue) -> Result<JsValue, JsError> {
    let args: StatusArgs = serde_wasm_bindgen::from_value(args).map_err(err)?;
    let mut env = Env::new(&args.market)?;
    let position: Position = decode(&args.position)?;
    let ((status, liquidatable), _) = env.run(Seed::Existing(position), |p, prices| {
        let status = p.status(prices).map_err(err)?;
        let liquidatable = p
            .check_liquidatable(prices, true, true)
            .map_err(err)?
            .is_some();
        Ok((status, liquidatable))
    })?;
    to_js(&StatusResult {
        entry_price: status.entry_price.to_string(),
        collateral_value: status.collateral_value.to_string(),
        pending_pnl: status.pending_pnl.to_string(),
        pending_borrowing_fee_value: status.pending_borrowing_fee_value.to_string(),
        pending_funding_fee_value: status.pending_funding_fee_value.to_string(),
        close_order_fee_value: status.close_order_fee_value.to_string(),
        net_value: status.net_value.to_string(),
        leverage: status.leverage.map(|l| l.to_string()),
        liquidation_price: status.liquidation_price.map(|p| p.to_string()),
        liquidatable,
    })
}

/// Market-level funding and borrowing rates, open interest, spare capacity and LP pool value.
#[wasm_bindgen(js_name = marketStatus)]
pub fn market_status(args: JsValue) -> Result<JsValue, JsError> {
    let input: MarketInput = serde_wasm_bindgen::from_value(args).map_err(err)?;
    let mut env = Env::new(&input)?;
    let prices = env.prices;
    let s = env
        .market
        .with_vis_disabled(|market| market.status(&prices))
        .map_err(err)?;
    to_js(&MarketStatusResult {
        funding_rate_per_second_for_long: s.funding_rate_per_second_for_long.to_string(),
        funding_rate_per_second_for_short: s.funding_rate_per_second_for_short.to_string(),
        borrowing_rate_per_second_for_long: s.borrowing_rate_per_second_for_long.to_string(),
        borrowing_rate_per_second_for_short: s.borrowing_rate_per_second_for_short.to_string(),
        open_interest_for_long: s.open_interest_for_long.to_string(),
        open_interest_for_short: s.open_interest_for_short.to_string(),
        liquidity_for_long: s.liquidity_for_long.to_string(),
        liquidity_for_short: s.liquidity_for_short.to_string(),
        pool_value_for_long: s.pool_value_without_pnl_for_long.min.to_string(),
        pool_value_for_short: s.pool_value_without_pnl_for_short.min.to_string(),
        min_collateral_factor_for_long: s.min_collateral_factor_for_long.to_string(),
        min_collateral_factor_for_short: s.min_collateral_factor_for_short.to_string(),
    })
}
