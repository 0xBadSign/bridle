// Shared helpers for the deploy script, keeper, agent and demo runners.
// Keys are read from the legacy NEAR CLI keychain (~/.near-credentials/testnet) or from a key file
// path; nothing secret lives in the repository.
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions, encodeTransaction, baseEncode, baseDecode } from "near-api-js";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

export const NEAR_RPC = process.env.NEAR_RPC || "https://test.rpc.fastnear.com";
export const BASE_RPC = process.env.BASE_RPC || "https://sepolia.base.org";
export const SIGNER = process.env.MPC_SIGNER || "v1.signer-prod.testnet";
export const KEYS_DIR = process.env.BRIDLE_KEYS || path.join(os.homedir(), ".near-credentials", "testnet");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

export async function rpc(url, method, params) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      const j = await r.json();
      // Rate limits are transient: back off and retry.
      if ((r.status === 429 || j?.error?.code === -429) && i < 8) {
        await sleep(2000 * (i + 1));
        continue;
      }
      return j;
    } catch (e) {
      if (i >= 4) throw e;
      await sleep(1000 * (i + 1));
    }
  }
}

export const nearRpc = (m, p) => rpc(NEAR_RPC, m, p);
export const baseRpc = (m, p) => rpc(BASE_RPC, m, p);

/** Read a secret key: an account name in the keychain, or a path to a JSON key file. */
export function secretKey(nameOrPath) {
  const p = fs.existsSync(nameOrPath) ? nameOrPath : path.join(KEYS_DIR, `${nameOrPath}.json`);
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  return j.private_key || j.secret_key;
}

export function account(accountId, keyNameOrPath = accountId) {
  const provider = new JsonRpcProvider({ url: NEAR_RPC });
  return new Account(accountId, provider, KeyPairSigner.fromSecretKey(secretKey(keyNameOrPath)));
}

/** Create a fresh ed25519 key pair and save it (outside the repo). Returns the public key. */
export function newKeyFile(file) {
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8")).public_key;
  const k = KeyPair.fromRandom("ed25519");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ public_key: k.getPublicKey().toString(), private_key: k.toString() }), { mode: 0o600 });
  return k.getPublicKey().toString();
}

/**
 * Sign and send a transaction, wait for FINAL, and return { hash, status, value, receipts, logs }.
 * `acts` is an array of near-api-js actions.
 */
export async function send(acct, receiverId, acts, { timeoutMs = 420000 } = {}) {
  const stx = await acct.createSignedTransaction({ receiverId, actions: acts });
  const hash = baseEncode(crypto.createHash("sha256").update(encodeTransaction(stx.transaction)).digest());
  const sent = await nearRpc("send_tx", { signed_tx_base64: Buffer.from(stx.encode()).toString("base64"), wait_until: "INCLUDED" });
  if (sent.error && !/TIMEOUT/i.test(JSON.stringify(sent.error))) throw new Error(`rejected ${hash}: ${JSON.stringify(sent.error).slice(0, 400)}`);
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await nearRpc("EXPERIMENTAL_tx_status", { tx_hash: hash, sender_account_id: acct.accountId, wait_until: "FINAL" });
    if (r.result && r.result.final_execution_status === "FINAL") return outcome(hash, r.result);
    if (r.error && !/UNKNOWN_TRANSACTION|TIMEOUT/i.test(JSON.stringify(r.error))) throw new Error(`tx ${hash}: ${JSON.stringify(r.error).slice(0, 400)}`);
    await sleep(2000);
  }
  throw new Error(`timeout waiting for ${hash}`);
}

function outcome(hash, res) {
  const st = res.status;
  let value;
  if (st.SuccessValue !== undefined) {
    const s = Buffer.from(st.SuccessValue, "base64").toString();
    try { value = s ? JSON.parse(s) : null; } catch { value = s; }
  }
  const logs = res.receipts_outcome.flatMap((r) => r.outcome.logs);
  const failures = res.receipts_outcome.filter((r) => r.outcome.status.Failure).map((r) => ({ executor: r.outcome.executor_id, failure: r.outcome.status.Failure }));
  return { hash, status: st, value, logs, failures, events: logs.filter((l) => l.startsWith("EVENT_JSON:")).map((l) => JSON.parse(l.slice(11))) };
}

export const call = (acct, receiverId, method, args, { gasT = 300, deposit = 0n } = {}) =>
  send(acct, receiverId, [actions.functionCall(method, args, BigInt(gasT) * 10n ** 12n, BigInt(deposit))]);

export async function view(contract, method, args = {}) {
  const r = await nearRpc("query", { request_type: "call_function", finality: "final", account_id: contract, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") });
  if (r.error || r.result?.error) throw new Error(`view ${contract}.${method}: ${JSON.stringify(r.error || r.result.error).slice(0, 300)}`);
  return JSON.parse(Buffer.from(r.result.result).toString());
}

export async function accessKeys(accountId) {
  const r = await nearRpc("query", { request_type: "view_access_key_list", finality: "final", account_id: accountId });
  return r.result.keys;
}

/** The 64-byte secp256k1 key the MPC derives for (predecessor, path, domain 0), as hex. */
export async function derivedKeyHex(predecessor, pathStr = "bridle") {
  const pk = await view(SIGNER, "derived_public_key", { path: pathStr, predecessor, domain_id: 0 });
  return Buffer.from(baseDecode(pk.replace(/^secp256k1:/, ""))).toString("hex");
}

/** The ForeignTx (domain 3) root key as 64-byte hex. */
export async function foreignKeyHex(domainId = 3) {
  const pk = await view(SIGNER, "public_key", { domain_id: domainId });
  return Buffer.from(baseDecode(pk.replace(/^secp256k1:/, ""))).toString("hex");
}

export function evmAddress(pubHex64) {
  const { keccak256 } = keccak();
  return "0x" + keccak256(Buffer.from(pubHex64, "hex")).slice(-40);
}

// Minimal keccak-256 (no extra dependency): port of the reference sponge for 136-byte rate.
function keccak() {
  const RC = [
    0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n, 0x000000000000808bn, 0x0000000080000001n,
    0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
    0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n,
    0x000000000000800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
  ];
  const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
  const M = (1n << 64n) - 1n;
  const rotl = (x, n) => (n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & M);
  function f(s) {
    for (let r = 0; r < 24; r++) {
      const c = [0, 1, 2, 3, 4].map((x) => s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20]);
      for (let x = 0; x < 5; x++) {
        const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
        for (let y = 0; y < 25; y += 5) s[x + y] ^= d;
      }
      const b = new Array(25);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y], ROT[x + 5 * y]);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) s[x + 5 * y] = b[x + 5 * y] ^ (~b[((x + 1) % 5) + 5 * y] & M & b[((x + 2) % 5) + 5 * y]);
      s[0] ^= RC[r];
    }
  }
  function keccak256(data) {
    const rate = 136;
    const p = Buffer.alloc(Math.ceil((data.length + 1) / rate) * rate);
    data.copy(p);
    p[data.length] ^= 0x01;
    p[p.length - 1] ^= 0x80;
    const s = new Array(25).fill(0n);
    for (let o = 0; o < p.length; o += rate) {
      for (let i = 0; i < rate / 8; i++) s[i] ^= p.readBigUInt64LE(o + i * 8);
      f(s);
    }
    const out = Buffer.alloc(32);
    for (let i = 0; i < 4; i++) out.writeBigUInt64LE(s[i], i * 8);
    return out.toString("hex");
  }
  return { keccak256 };
}

export const keccakHex = (buf) => keccak().keccak256(Buffer.from(buf));

export { actions };
