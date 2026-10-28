// `make verify`: re-checks every live testnet claim of the README against public RPCs.
//
// No keys, no faucet, no Rust. Reads docs/evidence/claims.json, queries NEAR testnet
// (https://test.rpc.fastnear.com) and Base Sepolia (https://sepolia.base.org), and prints one
// PASS / FAIL / SKIP line per claim. Exit code is non-zero if any claim fails.
//
//   node scripts/verify-claims.mjs                 all claims
//   node scripts/verify-claims.mjs --only E01,E09  selected claim ids
//   node scripts/verify-claims.mjs --json          machine-readable result on stdout
//
// A claim is SKIP only when the live state cannot be compared right now (an operation is in
// flight on a vault, so its ledger and Base balances are legitimately apart). SKIP is counted and
// printed; it never hides a mismatch.
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { baseEncode } from "near-api-js";
import { NEAR_RPC, BASE_RPC, SIGNER, nearRpc, baseRpc, view, accessKeys, derivedKeyHex, evmAddress, sleep } from "./lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const only = (args.includes("--only") ? args[args.indexOf("--only") + 1] : "").split(",").filter(Boolean);
const asJson = args.includes("--json");
const CLAIMS = JSON.parse(fs.readFileSync(process.env.CLAIMS_FILE || path.join(ROOT, "docs/evidence/claims.json"), "utf8"));
const ADDR = CLAIMS.addresses;
const EVENTS = CLAIMS.events;
const CHAIN_ID = CLAIMS.base_chain_id;
const PACE_MS = 60; // politeness between RPC calls

// ---- helpers -----------------------------------------------------------------------------------
class Skip extends Error {}
const fail = (msg) => {
  throw new Error(msg);
};
const need = (cond, msg) => cond || fail(msg);
const HIST = CLAIMS.historic_code_hashes || {};
const alias = (v) => (typeof v === "string" && v.startsWith("@") ? ADDR[v.slice(1)] ?? fail(`unknown alias ${v}`) : v);
/** {{historic.NAME}} and {{vault_sha256_hex}} placeholders inside expected strings. */
const subst = (v) => (typeof v === "string" ? v.replace(/\{\{historic\.(\w+)\}\}/g, (_, k) => HIST[k] ?? fail(`unknown historic hash ${k}`)).replace("{{vault_sha256_hex}}", vaultSha().toString("hex")) : v);
const word = (hex) => "0x" + hex.replace(/^0x/, "").padStart(64, "0");
const PREBUILT = CLAIMS.prebuilt_vault;
const vaultSha = () => crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, PREBUILT))).digest();

const cache = new Map();
const memo = (key, fn) => {
  if (!cache.has(key)) cache.set(key, fn());
  return cache.get(key);
};
async function paced(fn) {
  const r = await fn();
  await sleep(PACE_MS);
  return r;
}

const nearTx = (hash, signer) =>
  memo(`near:${hash}`, async () => {
    const r = await paced(() => nearRpc("EXPERIMENTAL_tx_status", { tx_hash: hash, sender_account_id: signer, wait_until: "FINAL" }));
    need(r.result, `tx ${hash} not found: ${String(JSON.stringify(r.error)).slice(0, 160)}`);
    return r.result;
  });
const baseReceipt = (hash) => memo(`rcpt:${hash}`, async () => (await paced(() => baseRpc("eth_getTransactionReceipt", [hash]))).result);
const baseTx = (hash) => memo(`btx:${hash}`, async () => (await paced(() => baseRpc("eth_getTransactionByHash", [hash]))).result);
const vaultView = (account, method, a = {}) => memo(`view:${account}:${method}:${JSON.stringify(a)}`, () => paced(() => view(account, method, a)));
const ethCall = async (to, data) => BigInt((await paced(() => baseRpc("eth_call", [{ to, data }, "latest"]))).result);
const balanceOf = (token, who) => ethCall(token, "0x70a08231" + who.slice(2).toLowerCase().padStart(64, "0"));

/** Dotted path into JSON; "*" fans out over an array, "id=N" selects the element with that id, "$" is the root. */
function pick(obj, p) {
  if (p === "$") return obj;
  let cur = [obj];
  for (const k of p.split(".")) {
    const next = [];
    for (const c of cur) {
      if (c === null || c === undefined) continue;
      if (k.startsWith("id=")) next.push(...(Array.isArray(c) ? c.filter((x) => String(x.id) === k.slice(3)) : []));
      else if (k === "*") next.push(...(Array.isArray(c) ? c : Object.values(c)));
      else next.push(c[k]);
    }
    cur = next;
  }
  return p.includes("*") ? cur : cur[0];
}

function assertValue(label, got, spec) {
  const text = typeof got === "string" ? got : JSON.stringify(got);
  if ("equals" in spec) {
    const want = subst(alias(spec.equals));
    need(String(got) === String(want) || JSON.stringify(got) === JSON.stringify(want), `${label}: expected ${JSON.stringify(want)}, got ${text}`);
  }
  if ("gte" in spec) need(BigInt(got) >= BigInt(spec.gte), `${label}: ${got} < ${spec.gte}`);
  if ("exists" in spec) need((got !== undefined && got !== null) === spec.exists, `${label}: exists=${got !== undefined}`);
  if ("includes" in spec) need(Array.isArray(got) ? got.includes(spec.includes) : text.includes(spec.includes), `${label}: missing ${JSON.stringify(spec.includes)}`);
  if ("not_contains" in spec) need(!text.includes(spec.not_contains), `${label}: unexpectedly contains ${JSON.stringify(spec.not_contains)}`);
}

// ---- checkers (one per claim type) -------------------------------------------------------------
const checks = {
  // A NEAR transaction: outcome, actions, logs, return value.
  async near_tx(c) {
    const t = await nearTx(c.tx, c.signer);
    const e = c.expect;
    const logs = t.receipts_outcome.flatMap((r) => r.outcome.logs);
    const failures = JSON.stringify([t.status.Failure, ...t.receipts_outcome.map((r) => r.outcome.status.Failure)].filter(Boolean));
    const ok = t.status.Failure === undefined && t.receipts_outcome.every((r) => !r.outcome.status.Failure);
    need(t.transaction.signer_id === c.signer, `signer ${t.transaction.signer_id}`);
    if (e.receiver) need(t.transaction.receiver_id === e.receiver, `receiver ${t.transaction.receiver_id}`);
    if (e.outcome === "success") need(ok, `expected success, failures: ${failures.slice(0, 200)}`);
    if (e.outcome === "failure") need(!ok, "expected failure, but the transaction succeeded");
    if (e.error_contains) need(failures.includes(e.error_contains), `no failure containing "${e.error_contains}": ${failures.slice(0, 200)}`);
    if (e.actions) {
      const got = t.transaction.actions.map((a) => (typeof a === "string" ? a : Object.keys(a)[0] + (a.FunctionCall ? ":" + a.FunctionCall.method_name : "")));
      need(JSON.stringify(got) === JSON.stringify(e.actions), `actions ${JSON.stringify(got)}`);
    }
    for (const s of e.logs_contain || []) need(logs.some((l) => l.includes(s)), `no log containing ${JSON.stringify(s)}`);
    if (e.value_contains?.length) {
      const sv = t.status.SuccessValue !== undefined ? Buffer.from(t.status.SuccessValue, "base64").toString() : "";
      for (const s of e.value_contains) {
        const want = subst(s);
        need(sv.includes(want), `return value lacks ${JSON.stringify(want)}: ${sv.slice(0, 160)}`);
      }
    }
    return `${t.transaction.signer_id} -> ${t.transaction.receiver_id}`;
  },

  // A Base Sepolia receipt: status, sender, target, logs (address, topics, amount, index).
  async base_receipt(c) {
    const [r, tx] = await Promise.all([baseReceipt(c.tx), baseTx(c.tx)]);
    need(r && tx, `receipt or transaction ${c.tx} not found on Base Sepolia`);
    const e = c.expect;
    need(parseInt(tx.chainId, 16) === CHAIN_ID, `chain id ${parseInt(tx.chainId, 16)}`);
    need(parseInt(r.status, 16) === e.status, `status ${parseInt(r.status, 16)}`);
    if (e.from) need(tx.from.toLowerCase() === alias(e.from).toLowerCase(), `from ${tx.from}`);
    if (e.to) need(tx.to?.toLowerCase() === alias(e.to).toLowerCase(), `to ${tx.to}`);
    if (e.value_zero) need(BigInt(tx.value) === 0n, `value ${BigInt(tx.value)}`);
    if (e.nonce !== undefined) need(parseInt(tx.nonce, 16) === e.nonce, `nonce ${parseInt(tx.nonce, 16)}`);
    if (e.gas_used !== undefined) need(parseInt(r.gasUsed, 16) === e.gas_used, `gasUsed ${parseInt(r.gasUsed, 16)}`);
    if (e.logs_count !== undefined) need(r.logs.length === e.logs_count, `${r.logs.length} logs`);
    for (const want of e.logs || []) {
      const topics = want.topics.map((t) => (t === null ? null : EVENTS[t] ?? (t.startsWith("@") ? word(alias(t)) : t.length === 42 ? word(t) : t)));
      const hit = r.logs.find((l) => {
        if (l.address.toLowerCase() !== alias(want.address).toLowerCase()) return false;
        if (want.log_index !== undefined && parseInt(l.logIndex, 16) !== want.log_index) return false;
        if (!topics.every((t, i) => t === null || (l.topics[i] || "").toLowerCase() === t.toLowerCase())) return false;
        if (want.amount !== undefined) {
          const d = l.data.replace(/^0x/, "");
          const w = d.slice(64 * (want.amount_word ?? 0), 64 * ((want.amount_word ?? 0) + 1));
          if (!w || BigInt("0x" + w) !== BigInt(want.amount)) return false;
        }
        return true;
      });
      need(hit, `no log matching ${JSON.stringify(want)}`);
    }
    return `block ${parseInt(r.blockNumber, 16)}, gas ${parseInt(r.gasUsed, 16)}`;
  },

  // A Base transaction that must never have been mined (it was replaced at its nonce).
  async base_never_mined(c) {
    const r = await baseReceipt(c.tx);
    need(!r, "a receipt exists, so the transaction was mined");
    return "no receipt";
  },

  // Account keys: only function-call keys, receiver is the vault itself, constant method lists.
  async near_keys(c) {
    const keys = await memo(`keys:${c.account}`, () => paced(() => accessKeys(c.account)));
    need(keys.length > 0, "no keys");
    const full = keys.filter((k) => k.access_key.permission === "FullAccess");
    need(full.length === 0, `${full.length} full-access key(s)`);
    for (const k of keys) {
      const fc = k.access_key.permission.FunctionCall;
      need(fc.receiver_id === c.account, `key ${k.public_key.slice(0, 16)} receiver ${fc.receiver_id}`);
      need(fc.method_names.length > 0, `key ${k.public_key.slice(0, 16)} has an empty (= any) method list`);
      need(c.method_sets.some((m) => JSON.stringify(m) === JSON.stringify(fc.method_names)), `key ${k.public_key.slice(0, 16)} methods ${fc.method_names}`);
      need(fc.allowance !== null && fc.allowance !== undefined, `key ${k.public_key.slice(0, 16)} has an unlimited allowance`);
    }
    const st = await vaultView(c.account, "get_state");
    const agent = keys.filter((k) => k.public_key === st.agent_key);
    need(agent.length === 1 && JSON.stringify(agent[0].access_key.permission.FunctionCall.method_names) === '["agent_act"]', "the agent key is not a single agent_act key");
    for (const g of st.guardians) need(keys.some((k) => k.public_key === g), `guardian ${g.slice(0, 16)} has no key`);
    return `${keys.length} keys, all function-call`;
  },

  // Assertions over a view call of the vault.
  async vault_view(c) {
    const v = await vaultView(c.account, c.method, c.args || {});
    for (const a of c.assert) assertValue(`${c.method} ${a.path}`, pick(v, a.path), a);
    return `${c.method}: ${c.assert.length} assertion(s)`;
  },

  // The deployed code hash equals sha256 of the prebuilt wasm (and of nothing else).
  async code_hash(c) {
    const want = baseEncode(vaultSha());
    const r = await memo(`acct:${c.account}`, () => paced(() => nearRpc("query", { request_type: "view_account", finality: "final", account_id: c.account })));
    need(r.result, `view_account failed: ${JSON.stringify(r.error)}`);
    need(r.result.code_hash === want, `deployed ${r.result.code_hash}, prebuilt ${want}`);
    return `${r.result.code_hash} = sha256(${PREBUILT})`;
  },

  // deploy/prebuilt/SHA256SUMS matches the wasm files next to it.
  async prebuilt_sums() {
    const dir = path.join(ROOT, "deploy/prebuilt");
    const lines = fs.readFileSync(path.join(dir, "SHA256SUMS"), "utf8").trim().split("\n");
    need(lines.length >= 2, "SHA256SUMS lists fewer than 2 files");
    for (const l of lines) {
      const [h, f] = l.split(/\s+\*?/);
      need(crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, f))).digest("hex") === h, `${f} does not match SHA256SUMS`);
    }
    return `${lines.length} files match SHA256SUMS`;
  },

  // The wasm cannot import the host functions that add a full-access key or delete the account.
  async wasm_imports() {
    const out = execFileSync(process.execPath, [path.join(ROOT, "scripts/wasm-imports.mjs"), path.join(ROOT, PREBUILT)], { encoding: "utf8" });
    return out.trim().split("\n").pop().trim();
  },

  // The MPC-derived Base address of (predecessor, path) equals the address the vault reports.
  async derived_address(c) {
    const got = evmAddress(await memo(`dk:${c.predecessor}:${c.path}`, () => paced(() => derivedKeyHex(c.predecessor, c.path))));
    need(got === alias(c.equals), `derived ${got}, expected ${alias(c.equals)}`);
    return `${c.predecessor} + "${c.path}" -> ${got}`;
  },

  // Vault ledger against the real balances: idle = USDC at the vault's Base address,
  // principal = aUSDC (within the documented Aave rounding dust), no reservation or operation open.
  async ledger_vs_chain(c) {
    let st;
    for (let i = 0; ; i++) {
      st = await paced(() => view(c.account, "get_state"));
      const l = st.ledger;
      const open = st.active !== null || [l.supplying, l.withdrawing, l.sending].some((x) => BigInt(x) !== 0n);
      if (!open) break;
      if (i >= 3) throw new Skip("an operation is in flight; ledger and balances differ legitimately");
      await sleep(8000);
    }
    const [usdc, atoken] = [await balanceOf(st.chain.usdc, st.chain.vault), await balanceOf(st.chain.atoken, st.chain.vault)];
    const idle = BigInt(st.ledger.idle);
    const principal = BigInt(st.ledger.principal);
    need(usdc === idle, `idle ${idle} != USDC balance ${usdc}`);
    const diff = atoken > principal ? atoken - principal : principal - atoken;
    need(diff <= BigInt(c.dust), `principal ${principal} vs aUSDC ${atoken}: diff ${diff} > ${c.dust}`);
    if (c.check_sent) {
      const t = await balanceOf(st.chain.usdc, st.policy.treasury);
      need(t >= BigInt(st.ledger.total_sent), `treasury holds ${t}, ledger says ${st.ledger.total_sent} was sent`);
    }
    return `idle ${idle} = USDC ${usdc}; principal ${principal} vs aUSDC ${atoken}`;
  },

  // The vault's reserved nonce equals the Base account nonce of its derived address.
  async nonce_vs_chain(c) {
    let st;
    for (let i = 0; ; i++) {
      st = await paced(() => view(c.account, "get_state"));
      if (st.active === null) break;
      if (i >= 3) throw new Skip("an operation is in flight; the nonce is reserved ahead of Base");
      await sleep(8000);
    }
    const n = BigInt((await paced(() => baseRpc("eth_getTransactionCount", [st.chain.vault, "latest"]))).result);
    need(n === BigInt(st.next_nonce), `vault next_nonce ${st.next_nonce}, Base nonce ${n}`);
    return `next_nonce ${st.next_nonce} = Base nonce`;
  },

  // The on-chain mandate equals deploy/testnet.json for every field both name.
  async policy_matches_deploy(c) {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "deploy/testnet.json"), "utf8"));
    const st = await vaultView(c.account, "get_state");
    const bad = [];
    for (const [k, v] of Object.entries(cfg.policy)) if (k in st.policy && String(st.policy[k]) !== String(v)) bad.push(`${k}: chain ${st.policy[k]}, file ${v}`);
    for (const [k, v] of Object.entries(cfg.floors)) if (String(st.floors[k]) !== String(v)) bad.push(`floor ${k}: chain ${st.floors[k]}, file ${v}`);
    for (const [k, v] of Object.entries(cfg.chain)) if (String(st.chain[k]) !== String(v)) bad.push(`chain.${k}: chain ${st.chain[k]}, file ${v}`);
    need(bad.length === 0, bad.join("; "));
    return "policy, floors and chain match deploy/testnet.json";
  },
};

// ---- run ---------------------------------------------------------------------------------------
const selected = CLAIMS.claims.filter((c) => !only.length || only.includes(c.id));
need(selected.length > 0, "no claim selected");
const t0 = Date.now();
const rows = [];
const out = (...a) => asJson || console.log(...a);
out(`Bridle claims verifier: ${selected.length} claims against ${NEAR_RPC} and ${BASE_RPC}`);
out(`(MPC signer ${SIGNER}; no keys, no transactions, read-only)\n`);
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "~" : s.padEnd(n));
for (const c of selected) {
  let status = "PASS";
  let detail = "";
  try {
    detail = await checks[c.type](c);
  } catch (e) {
    if (e instanceof Skip) [status, detail] = ["SKIP", e.message];
    else [status, detail] = ["FAIL", String(e.message || e).slice(0, 300)];
  }
  rows.push({ id: c.id, chain: c.chain, claim: c.claim, status, detail });
  out(`${status}  ${c.id.padEnd(4)} ${c.chain.padEnd(5)} ${clip(c.claim, 88)}${status === "PASS" ? "" : "  <- " + detail}`);
}
const count = (s) => rows.filter((r) => r.status === s).length;
const secs = Math.round((Date.now() - t0) / 1000);
if (asJson) console.log(JSON.stringify({ rows, seconds: secs }, null, 2));
else {
  out("");
  for (const r of rows.filter((x) => x.status === "FAIL")) out(`FAILED ${r.id}: ${r.claim}\n        ${r.detail}`);
  for (const r of rows.filter((x) => x.status === "SKIP")) out(`SKIPPED ${r.id}: ${r.detail}`);
  out(`${count("PASS")}/${rows.length} claims verified (${count("FAIL")} failed, ${count("SKIP")} skipped) in ${secs}s`);
  out(count("FAIL") ? "RESULT: FAIL" : "RESULT: PASS");
}
process.exit(count("FAIL") ? 1 : 0);
