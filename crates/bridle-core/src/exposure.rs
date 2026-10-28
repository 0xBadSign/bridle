//! `exposure()`: what can move per epoch under a policy.
//!
//! This is a conditional number, not a loss bound. It assumes the NEAR MPC network, Base and
//! Aave behave (see the README's trust list). It is computed by the same code that enforces
//! the policy, so the view and the enforcement cannot disagree.

use borsh::{BorshDeserialize, BorshSerialize};
use serde::{Deserialize, Serialize};

use crate::evm::{gas_limit, Call};
use crate::policy::Policy;

#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize)]
pub struct Exposure {
    /// Most principal that can sit in Aave (protocol risk is on this amount).
    #[serde(with = "crate::types::u128_str")]
    pub max_in_protocol: u128,
    /// Most the agent can move between the vault address and Aave per epoch. It never leaves `D`.
    #[serde(with = "crate::types::u128_str")]
    pub agent_moves_per_epoch: u128,
    /// Most that can leave the vault address per epoch without a parked, vetoable vote.
    #[serde(with = "crate::types::u128_str")]
    pub fast_outflow_per_epoch: u128,
    /// Most Base gas (wei) the agent can burn per epoch, including one cancel per transaction.
    /// The OP Stack L1 data fee is not covered by `maxFeePerGas` and is excluded.
    #[serde(with = "crate::types::u128_str")]
    pub agent_gas_wei_per_epoch: u128,
}

pub fn exposure(p: &Policy) -> Exposure {
    let quota = p.agent_quota_per_epoch as u128;
    // The costliest agent operation is a supply: approve + supply, each possibly cancelled once.
    let per_op_gas = (gas_limit(&Call::Approve { amount: 0 })
        + gas_limit(&Call::Supply { amount: 0 })
        + 2 * gas_limit(&Call::Cancel)) as u128;
    Exposure {
        max_in_protocol: p.supply_cap,
        agent_moves_per_epoch: quota.saturating_mul(p.agent_max_per_action),
        fast_outflow_per_epoch: p.fast_outflow_per_epoch,
        agent_gas_wei_per_epoch: quota
            .saturating_mul(per_op_gas)
            .saturating_mul(p.max_fee_per_gas),
    }
}
