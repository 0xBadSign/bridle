//! Golden vectors from live Base Sepolia transactions that the probe vault built, the NEAR MPC
//! network signed, and the MPC later attested (near-research/14 and 16).
//! If any of these fail, the vault would sign or expect something different from what the chain does.

use bridle_core::evm::{self, Call, Chain, MpcSignature, TxParams};
use bridle_core::foreign::{self, Hints};
use bridle_core::types::{parse_hex, EvmAddr, Hash32, Hasher, H256};
use serde_json::Value;
use sha2::Digest;

struct TestHasher;
impl Hasher for TestHasher {
    fn keccak256(&self, d: &[u8]) -> H256 {
        sha3::Keccak256::digest(d).into()
    }
    fn sha256(&self, d: &[u8]) -> H256 {
        sha2::Sha256::digest(d).into()
    }
}

fn chain() -> Chain {
    Chain {
        chain_id: 84532,
        vault: EvmAddr(parse_hex("8dcbcefb6f02dff2714ae6c7a9cdb6ec5a74b4a3").unwrap()),
        usdc: EvmAddr(parse_hex("ba50cd2a20f6da35d788639e581bca8d0b5d4d5f").unwrap()),
        pool: EvmAddr(parse_hex("8bab6d1b75f19e9ed9fce8b9bd338844ff79ae27").unwrap()),
        atoken: EvmAddr(parse_hex("10f1a9d11cdf50041f3f8cb7191cbe2f31750acc").unwrap()),
    }
}

fn fixture(name: &str) -> Value {
    let p = format!("{}/tests/fixtures/{name}.json", env!("CARGO_MANIFEST_DIR"));
    let v: Value = serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap();
    v["result"].clone()
}

fn num(v: &Value) -> u128 {
    u128::from_str_radix(v.as_str().unwrap().trim_start_matches("0x"), 16).unwrap()
}

fn h32(v: &Value) -> H256 {
    parse_hex(v.as_str().unwrap()).unwrap()
}

/// Rebuild a live transaction with our builder, attach its on-chain signature, and compare hashes.
fn check_tx(id: &str, call: Call) {
    let tx = fixture(&format!("tx_{id}"));
    let p = TxParams {
        nonce: num(&tx["nonce"]) as u64,
        gas_limit: num(&tx["gas"]) as u64,
        max_fee_per_gas: num(&tx["maxFeePerGas"]),
        max_priority_fee_per_gas: num(&tx["maxPriorityFeePerGas"]),
    };
    let c = chain();
    let built = evm::build(&c, &call, &p);
    assert_eq!(
        hex::encode(&built.input),
        tx["input"].as_str().unwrap().trim_start_matches("0x"),
        "calldata {id}"
    );
    let sig = MpcSignature {
        big_r: format!(
            "02{:0>64}",
            tx["r"].as_str().unwrap().trim_start_matches("0x")
        ),
        s: format!(
            "{:0>64}",
            tx["s"].as_str().unwrap().trim_start_matches("0x")
        ),
        recovery_id: num(&tx["yParity"]) as u8,
    };
    let (_, hash) = evm::assemble(&TestHasher, &built, &sig).unwrap();
    assert_eq!(hash, h32(&tx["hash"]), "tx hash {id}");
}

#[test]
fn builder_reproduces_live_transactions() {
    check_tx("4a86454c", Call::Approve { amount: 50_000_000 });
    check_tx("99aba362", Call::Supply { amount: 50_000_000 });
    check_tx("50269dd9", Call::Withdraw { amount: 10_000_000 });
    let treasury = EvmAddr(parse_hex("9b1369b107a32ef45f90d06e9cc35f43715ba4e5").unwrap());
    check_tx(
        "019127cb",
        Call::Transfer {
            to: treasury,
            amount: 10_000_000,
        },
    );
}

/// Our expected log for a call equals the log the chain emitted.
fn check_log(id: &str, log_index: u64, call: Call) {
    let rc = fixture(&format!("rc_{id}"));
    let log = rc["logs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|l| num(&l["logIndex"]) as u64 == log_index)
        .unwrap();
    let want = foreign::expected_log(&chain(), &call).unwrap();
    assert_eq!(
        want.address,
        parse_hex::<20>(log["address"].as_str().unwrap()).unwrap(),
        "address {id}"
    );
    let topics: Vec<H256> = log["topics"].as_array().unwrap().iter().map(h32).collect();
    assert_eq!(want.topics, topics, "topics {id}");
    assert_eq!(
        hex::encode(&want.data),
        log["data"].as_str().unwrap().trim_start_matches("0x"),
        "data {id}"
    );
}

#[test]
fn expected_logs_match_live_logs() {
    check_log("4a86454c", 1, Call::Approve { amount: 50_000_000 });
    check_log("99aba362", 24, Call::Supply { amount: 50_000_000 });
    check_log("50269dd9", 10, Call::Withdraw { amount: 10_000_000 });
    let treasury = EvmAddr(parse_hex("9b1369b107a32ef45f90d06e9cc35f43715ba4e5").unwrap());
    check_log(
        "019127cb",
        2,
        Call::Transfer {
            to: treasury,
            amount: 10_000_000,
        },
    );
}

fn hints(id: &str, log_index: u64) -> (H256, Hints) {
    let rc = fixture(&format!("rc_{id}"));
    let h = Hints {
        block_hash: Hash32(h32(&rc["blockHash"])),
        block_number: num(&rc["blockNumber"]) as u64,
        tx_index: num(&rc["transactionIndex"]) as u64,
        log_index,
    };
    (h32(&rc["transactionHash"]), h)
}

#[test]
fn payload_hash_matches_live_attestations() {
    // Attested by v1.signer-prod.testnet: supply Log 24 (probe 14 and test T3) and BlockHash-only (T2 control).
    let (tx, h) = hints("99aba362", 24);
    let log = foreign::expected_log(&chain(), &Call::Supply { amount: 50_000_000 }).unwrap();
    let got = foreign::expected_payload_hash(&TestHasher, &tx, &h, Some(&log));
    assert_eq!(
        hex::encode(got),
        "85a2f5c95f8fe803e284e3cb2e8deca489f91ff89a09ef2f815f424766ac064b"
    );
    let got = foreign::expected_payload_hash(&TestHasher, &tx, &h, None);
    assert_eq!(
        hex::encode(got),
        "92f20e94b5e764341e949eba07231ab232804493a582f7b195e54dbb467a527a"
    );
}

#[test]
fn a_wrong_hint_changes_the_expected_hash() {
    let (tx, mut h) = hints("99aba362", 24);
    let log = foreign::expected_log(&chain(), &Call::Supply { amount: 50_000_000 }).unwrap();
    let good = foreign::expected_payload_hash(&TestHasher, &tx, &h, Some(&log));
    h.log_index = 23;
    assert_ne!(
        good,
        foreign::expected_payload_hash(&TestHasher, &tx, &h, Some(&log))
    );
    let wrong_amount =
        foreign::expected_log(&chain(), &Call::Supply { amount: 50_000_001 }).unwrap();
    let (tx, h) = hints("99aba362", 24);
    assert_ne!(
        good,
        foreign::expected_payload_hash(&TestHasher, &tx, &h, Some(&wrong_amount))
    );
}

#[test]
fn event_topics_are_the_keccak_of_their_signatures() {
    let k = |s: &str| TestHasher.keccak256(s.as_bytes());
    assert_eq!(evm::TOPIC_TRANSFER, k("Transfer(address,address,uint256)"));
    assert_eq!(evm::TOPIC_APPROVAL, k("Approval(address,address,uint256)"));
    assert_eq!(
        evm::TOPIC_SUPPLY,
        k("Supply(address,address,address,uint256,uint16)")
    );
    assert_eq!(
        evm::TOPIC_WITHDRAW,
        k("Withdraw(address,address,address,uint256)")
    );
    assert_eq!(&k("approve(address,uint256)")[..4], &evm::SEL_APPROVE);
    assert_eq!(
        &k("supply(address,uint256,address,uint16)")[..4],
        &evm::SEL_SUPPLY
    );
    assert_eq!(
        &k("withdraw(address,uint256,address)")[..4],
        &evm::SEL_WITHDRAW
    );
    assert_eq!(&k("transfer(address,uint256)")[..4], &evm::SEL_TRANSFER);
}

#[test]
fn verify_args_are_the_shape_the_signer_accepted() {
    let tx = [0x11u8; 32];
    let e = [0x22u8; 32];
    let j = foreign::verify_args_json(&tx, Some(24), &e, 3);
    let v: Value = serde_json::from_str(&j).unwrap();
    assert_eq!(
        v["request"]["request"]["Base"]["extractors"][1]["Log"]["log_index"],
        24
    );
    assert_eq!(v["request"]["domain_id"], 3);
    assert_eq!(v["request"]["expected_payload_hash"], hex::encode(e));
    let s: Value = serde_json::from_str(&foreign::sign_args_json(&e, "bridle", 0)).unwrap();
    assert_eq!(s["request"]["payload_v2"]["Ecdsa"], hex::encode(e));
}

#[test]
fn signatures_with_leading_zero_bytes_are_encoded_canonically() {
    // Red-team finding (red-b): `r` or `s` with a leading zero byte (about 1 signature in 128) was
    // RLP-encoded as a 32-byte string, which Base nodes reject as a non-canonical integer.
    let tx = evm::build(
        &chain(),
        &Call::Supply { amount: 1_000_000 },
        &TxParams {
            nonce: 7,
            gas_limit: 300_000,
            max_fee_per_gas: 100_000_000,
            max_priority_fee_per_gas: 1_000_000,
        },
    );
    let r = format!("00{}", "ab".repeat(31));
    let s = format!("0000{}", "cd".repeat(30));
    let sig = MpcSignature {
        big_r: format!("02{r}"),
        s: s.clone(),
        recovery_id: 1,
    };
    let (raw, hash) = evm::assemble(&TestHasher, &tx, &sig).unwrap();
    // The last three RLP items are v = 1, r as a 31-byte integer, s as a 30-byte integer.
    let tail: Vec<u8> = [
        vec![0x01, 0x80 + 31],
        vec![0xab; 31],
        vec![0x80 + 30],
        vec![0xcd; 30],
    ]
    .concat();
    assert!(
        raw.ends_with(&tail),
        "r and s must be minimal big-endian integers"
    );
    assert_eq!(hash, TestHasher.keccak256(&raw));
    // Signatures without leading zeros are unchanged (the live golden transactions cover them).
    let full = MpcSignature {
        big_r: format!("02{}", "ab".repeat(32)),
        s: "cd".repeat(32),
        recovery_id: 0,
    };
    let (raw2, _) = evm::assemble(&TestHasher, &tx, &full).unwrap();
    assert!(raw2.ends_with(
        &[
            [0x80, 0x80 + 32].as_slice(),
            &[0xab; 32],
            &[0x80 + 32],
            &[0xcd; 32]
        ]
        .concat()
    ));
}
