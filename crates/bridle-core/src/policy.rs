//! The mandate and the rule that decides which policy changes are FAST and which wait.
//!
//! Every field declares its direction in [`FIELDS`]. A change is FAST only if no field moves in
//! the loosening direction and no SLOW-only field changes at all (invariant 7). Anything else is
//! parked in the vetoable lane. Exit floors live in [`Floors`] and can never be tightened past.

use borsh::{BorshDeserialize, BorshSerialize};
use serde::{Deserialize, Serialize};

use crate::types::EvmAddr;

#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize)]
pub struct Policy {
    /// Maximum principal (USDC base units) in Aave at any time, counting in-flight supplies.
    #[serde(with = "crate::types::u128_str")]
    pub supply_cap: u128,
    /// Maximum amount of a single agent action.
    #[serde(with = "crate::types::u128_str")]
    pub agent_max_per_action: u128,
    /// Agent actions per epoch.
    pub agent_quota_per_epoch: u32,
    /// Minimum time between two agent actions.
    pub agent_min_interval_ms: u64,
    /// DAO-ordered outflow from the vault's Base address allowed per epoch without parking.
    #[serde(with = "crate::types::u128_str")]
    pub fast_outflow_per_epoch: u128,
    /// Fee caps for normal actions. Normal actions use at most 80% so a cancel has headroom.
    #[serde(with = "crate::types::u128_str")]
    pub max_fee_per_gas: u128,
    #[serde(with = "crate::types::u128_str")]
    pub max_priority_fee_per_gas: u128,
    /// Parking windows.
    pub short_window_ms: u64,
    pub long_window_ms: u64,
    /// Time after signing within which a transaction must be proved landed before the vault freezes.
    pub settle_deadline_ms: u64,
    /// Length of an accounting epoch.
    pub epoch_ms: u64,
    /// Longest single guardian pause, and vetoes per guardian per epoch.
    pub max_pause_ms: u64,
    pub max_vetoes_per_epoch: u32,
    /// Where `SendToTreasury` sends funds.
    pub treasury: EvmAddr,
}

/// Exit floors fixed at init. Fee caps can never be tightened below them, so exit stays possible.
#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize)]
pub struct Floors {
    #[serde(with = "crate::types::u128_str")]
    pub min_max_fee_per_gas: u128,
    #[serde(with = "crate::types::u128_str")]
    pub min_max_priority_fee_per_gas: u128,
    pub min_short_window_ms: u64,
    pub min_long_window_ms: u64,
    pub min_settle_deadline_ms: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Direction {
    /// Smaller value restricts more.
    LowerIsTighter,
    /// Larger value restricts more.
    HigherIsTighter,
    /// Any change needs the lane (assumptions, addresses, guardian powers).
    SlowOnly,
}

#[derive(
    Clone,
    Copy,
    Debug,
    PartialEq,
    Eq,
    PartialOrd,
    Ord,
    BorshSerialize,
    BorshDeserialize,
    Serialize,
    Deserialize,
)]
#[serde(rename_all = "snake_case")]
pub enum Lane {
    Fast,
    Short,
    Long,
}

/// One row per policy field. Adding a field to [`Policy`] without a row here fails
/// `every_field_has_a_direction` in the tests.
pub const FIELDS: &[(&str, Direction, Lane)] = &[
    ("supply_cap", Direction::LowerIsTighter, Lane::Long),
    (
        "agent_max_per_action",
        Direction::LowerIsTighter,
        Lane::Short,
    ),
    (
        "agent_quota_per_epoch",
        Direction::LowerIsTighter,
        Lane::Short,
    ),
    (
        "agent_min_interval_ms",
        Direction::HigherIsTighter,
        Lane::Short,
    ),
    (
        "fast_outflow_per_epoch",
        Direction::LowerIsTighter,
        Lane::Long,
    ),
    ("max_fee_per_gas", Direction::LowerIsTighter, Lane::Short),
    (
        "max_priority_fee_per_gas",
        Direction::LowerIsTighter,
        Lane::Short,
    ),
    ("short_window_ms", Direction::HigherIsTighter, Lane::Long),
    ("long_window_ms", Direction::HigherIsTighter, Lane::Long),
    ("settle_deadline_ms", Direction::SlowOnly, Lane::Long),
    ("epoch_ms", Direction::SlowOnly, Lane::Long),
    ("max_pause_ms", Direction::SlowOnly, Lane::Long),
    ("max_vetoes_per_epoch", Direction::SlowOnly, Lane::Long),
    ("treasury", Direction::SlowOnly, Lane::Long),
];

/// Numeric field values in the order of [`FIELDS`] (all rows except the last, `treasury`).
fn values(p: &Policy) -> [u128; 13] {
    [
        p.supply_cap,
        p.agent_max_per_action,
        p.agent_quota_per_epoch as u128,
        p.agent_min_interval_ms as u128,
        p.fast_outflow_per_epoch,
        p.max_fee_per_gas,
        p.max_priority_fee_per_gas,
        p.short_window_ms as u128,
        p.long_window_ms as u128,
        p.settle_deadline_ms as u128,
        p.epoch_ms as u128,
        p.max_pause_ms as u128,
        p.max_vetoes_per_epoch as u128,
    ]
}

/// Which lane a change from `old` to `new` needs. `Fast` means it only restricts.
pub fn classify(old: &Policy, new: &Policy) -> Lane {
    let (a, b) = (values(old), values(new));
    let mut lane = Lane::Fast;
    for (i, (name, dir, slow_lane)) in FIELDS.iter().enumerate() {
        let looser = if *name == "treasury" {
            old.treasury != new.treasury
        } else {
            match dir {
                Direction::LowerIsTighter => b[i] > a[i],
                Direction::HigherIsTighter => b[i] < a[i],
                Direction::SlowOnly => b[i] != a[i],
            }
        };
        if looser && *slow_lane > lane {
            lane = *slow_lane;
        }
    }
    lane
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum PolicyError {
    ZeroEpoch,
    WindowsOutOfOrder,
    BelowFloor(&'static str),
    PerActionAboveCap,
}

/// Sanity rules every policy must meet, whatever the lane.
pub fn validate(p: &Policy, f: &Floors) -> Result<(), PolicyError> {
    if p.epoch_ms == 0 {
        return Err(PolicyError::ZeroEpoch);
    }
    if p.short_window_ms > p.long_window_ms {
        return Err(PolicyError::WindowsOutOfOrder);
    }
    if p.max_fee_per_gas < f.min_max_fee_per_gas {
        return Err(PolicyError::BelowFloor("max_fee_per_gas"));
    }
    if p.max_priority_fee_per_gas < f.min_max_priority_fee_per_gas {
        return Err(PolicyError::BelowFloor("max_priority_fee_per_gas"));
    }
    if p.short_window_ms < f.min_short_window_ms {
        return Err(PolicyError::BelowFloor("short_window_ms"));
    }
    if p.long_window_ms < f.min_long_window_ms {
        return Err(PolicyError::BelowFloor("long_window_ms"));
    }
    if p.settle_deadline_ms < f.min_settle_deadline_ms {
        return Err(PolicyError::BelowFloor("settle_deadline_ms"));
    }
    if p.agent_max_per_action > p.supply_cap {
        return Err(PolicyError::PerActionAboveCap);
    }
    if p.max_priority_fee_per_gas > p.max_fee_per_gas {
        return Err(PolicyError::BelowFloor(
            "max_fee_per_gas below priority fee",
        ));
    }
    Ok(())
}

/// Fee fields for a normal action: 80% of the caps, so a +12% cancel still fits under the cap.
pub fn normal_fees(p: &Policy) -> (u128, u128) {
    (
        p.max_fee_per_gas * 8 / 10,
        p.max_priority_fee_per_gas * 8 / 10,
    )
}

/// Fee fields for a same-nonce replacement: both fields raised by 12% (Base requires >= 10%, test T7).
pub fn bumped_fees(max_fee: u128, prio: u128) -> (u128, u128) {
    (max_fee * 112 / 100 + 1, prio * 112 / 100 + 1)
}
