//! Pure logic of the Bridle vault.
//!
//! Nothing here touches NEAR or the network. The vault contract persists [`machine::Vault`],
//! feeds it calls and callback results, and executes the [`machine::Effect`]s it returns.
//! That split lets every security invariant be property-tested without a chain.

#![forbid(unsafe_code)]

pub mod evm;
pub mod exposure;
pub mod foreign;
pub mod machine;
pub mod policy;
pub mod types;

pub use types::{Address, Hasher, H256};
