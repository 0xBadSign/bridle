// Verify an MPC landing proof yourself, without trusting the vault.
//
//   node scripts/verify-attestation.mjs <near-tx-hash> [<near-tx-hash> ...]
//   node scripts/verify-attestation.mjs --latest [vault.bridle-hq.testnet] [--count 3]
//
// For each NEAR transaction in which a vault asked `v1.signer` to attest a Base transaction (a
// `settle` or `credit_deposit`), this re-reads the Base transaction from a Base RPC, rebuilds the
// payload the MPC signs, checks it equals the hash the vault expected and the hash the MPC signed,
// and recovers the attestation signature to the MPC network's ForeignTx-domain public key.
// Read-only: public RPCs, no keys. Exit code 1 if any check fails.
import crypto from "crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { baseRpc, foreignKeyHex } from "./lib.mjs";
import { findAttestation, verifyAttestation } from "../web/lib/attest.js";

const TX_API = process.env.FASTNEAR_TX_API || "https://tx.test.fastnear.com";

async function post(path, body) {
  for (let i = 0; ; i++) {
    const r = await fetch(`${TX_API}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (r.status === 429 && i < 5) {
      await new Promise((res) => setTimeout(res, 1500 * (i + 1)));
      continue;
    }
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    return r.json();
  }
}

let mpcKey;
const io = {
  nearTx: async (h) => (await post("/v0/transactions", { tx_hashes: [h] })).transactions?.[0] ?? null,
  baseReceipt: async (h) => (await baseRpc("eth_getTransactionReceipt", [h])).result,
  sha256: async (b) => new Uint8Array(crypto.createHash("sha256").update(b).digest()),
  recover: (sig, msg) => secp256k1.Point.fromBytes(secp256k1.recoverPublicKey(sig, msg, { prehash: false })).toBytes(false),
  mpcKeyHex: async () => (mpcKey ??= await foreignKeyHex(3)),
};

/** The most recent transactions of a vault that carry an MPC verdict. */
async function latest(vault, count) {
  const list = (await post("/v0/account", { account_id: vault, max_block_height: null })).account_txs || [];
  const found = [];
  for (const t of list) {
    const tx = await io.nearTx(t.transaction_hash);
    const { request, answer } = findAttestation(tx || {});
    if (request && answer) found.push(t.transaction_hash);
    if (found.length >= count) break;
  }
  return found;
}

const a = process.argv.slice(2);
let hashes = a.filter((x) => !x.startsWith("--") && !/\.testnet$|\.near$/.test(x));
if (a.includes("--latest")) {
  const vault = a.find((x) => /\.testnet$|\.near$/.test(x)) || "vault.bridle-hq.testnet";
  const count = Number(a.includes("--count") ? a[a.indexOf("--count") + 1] : 1);
  hashes = await latest(vault, count);
  if (!hashes.length) {
    console.log(`no attested transaction found among the latest transactions of ${vault}`);
    process.exit(1);
  }
}
if (!hashes.length) {
  console.log("usage: node scripts/verify-attestation.mjs <near-tx-hash> ... | --latest [vault] [--count n]");
  process.exit(2);
}

let allOk = true;
for (const h of hashes) {
  console.log(`\nNEAR tx ${h}`);
  const res = await verifyAttestation(h, io);
  for (const s of res.steps) console.log(`  ${s.ok ? "PASS" : "FAIL"}  ${s.name}${s.detail ? `  (${s.detail})` : ""}`);
  console.log(res.ok ? "  => the MPC network attested this Base transaction, and anyone can check it" : "  => NOT verified");
  allOk &&= res.ok;
}
process.exit(allOk ? 0 : 1);
