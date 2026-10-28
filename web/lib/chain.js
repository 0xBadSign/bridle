// Chain access for the dashboard: NEAR views over JSON-RPC, Base JSON-RPC, and (lazily loaded)
// transaction signing with near-api-js. No tracking, no backend: the browser talks to public RPCs.

export const NEAR_RPC = "https://test.rpc.fastnear.com";
export const BASE_RPC = "https://sepolia.base.org";
export const NEARBLOCKS = "https://testnet.nearblocks.io";
export const BASESCAN = "https://sepolia.basescan.org";
const NEAR_API_JS = "https://cdn.jsdelivr.net/npm/near-api-js@7.4.0/+esm";

export const VAULTS = {
  main: { id: "vault.bridle-hq.testnet", label: "Main vault", base: "0x96fbd55e58c16b10df15532e9157e067f2d1d8aa" },
  arena: { id: "arena.bridle-hq.testnet", label: "Arena vault", base: "0x53532502c663fdbe9dee366b17e03ce79ec6d3de" },
};

export const links = {
  nearTx: (h) => `${NEARBLOCKS}/txns/${h}`,
  nearAcct: (a) => `${NEARBLOCKS}/address/${a}`,
  baseTx: (h) => `${BASESCAN}/tx/${h}`,
  baseAddr: (a) => `${BASESCAN}/address/${a}`,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(url, method, params) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      const j = await r.json();
      if ((r.status === 429 || j?.error?.code === -429) && i < 4) {
        await sleep(1500 * (i + 1));
        continue;
      }
      return j;
    } catch (e) {
      if (i >= 2) throw e;
      await sleep(800 * (i + 1));
    }
  }
}
export const nearRpc = (m, p) => rpc(NEAR_RPC, m, p);
export const baseRpc = (m, p) => rpc(BASE_RPC, m, p);

const b64 = (obj) => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(obj))));

export async function view(contract, method, args = {}) {
  const r = await nearRpc("query", { request_type: "call_function", finality: "final", account_id: contract, method_name: method, args_base64: b64(args) });
  if (r.error || r.result?.error) throw new Error(`view ${contract}.${method}: ${JSON.stringify(r.error || r.result.error).slice(0, 200)}`);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(r.result.result)));
}

export async function accessKeys(accountId) {
  const r = await nearRpc("query", { request_type: "view_access_key_list", finality: "final", account_id: accountId });
  if (r.error || !r.result) throw new Error("access keys: " + JSON.stringify(r.error).slice(0, 200));
  return r.result.keys;
}

export async function fetchVault(id) {
  const [state, ops, parked, rej, keys] = await Promise.all([
    view(id, "get_state"),
    view(id, "get_ops"),
    view(id, "get_parked"),
    view(id, "get_rejections"),
    accessKeys(id),
  ]);
  return { state, ops, parked, rej, keys, fetchedAt: Date.now() };
}

// ---------------------------------------------------------------------------------------------
// Transactions. near-api-js is loaded only when something is signed, so read-only pages stay light.

let nearLib;
const loadNear = () => (nearLib ||= import(NEAR_API_JS));

async function sha256b58(bytes, baseEncode) {
  return baseEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

/** A signer for `accountId` with a published secret key. Returns call(receiver, method, args, gasT). */
export async function makeCaller(accountId, secretKey) {
  const n = await loadNear();
  const provider = new n.JsonRpcProvider({ url: NEAR_RPC });
  const acct = new n.Account(accountId, provider, n.KeyPairSigner.fromSecretKey(secretKey));
  return async function call(receiverId, method, args, { gasT = 150, timeoutMs = 240000 } = {}) {
    const stx = await acct.createSignedTransaction({ receiverId, actions: [n.actions.functionCall(method, args, BigInt(gasT) * 10n ** 12n, 0n)] });
    const hash = await sha256b58(n.encodeTransaction(stx.transaction), n.baseEncode);
    const bytes = stx.encode();
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    const sent = await nearRpc("send_tx", { signed_tx_base64: btoa(bin), wait_until: "INCLUDED" });
    if (sent.error && !/TIMEOUT/i.test(JSON.stringify(sent.error))) throw new Error(`NEAR rejected the transaction: ${JSON.stringify(sent.error.data || sent.error).slice(0, 300)}`);
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const r = await nearRpc("EXPERIMENTAL_tx_status", { tx_hash: hash, sender_account_id: accountId, wait_until: "FINAL" });
      if (r.result?.final_execution_status === "FINAL") return outcome(hash, r.result);
      if (r.error && !/UNKNOWN_TRANSACTION|TIMEOUT/i.test(JSON.stringify(r.error))) throw new Error(`tx ${hash}: ${JSON.stringify(r.error).slice(0, 300)}`);
      await sleep(2000);
    }
    throw new Error(`timeout waiting for ${hash}`);
  };
}

function outcome(hash, res) {
  const st = res.status;
  let value;
  if (st.SuccessValue !== undefined) {
    const s = atob(st.SuccessValue);
    try { value = s ? JSON.parse(s) : null; } catch { value = s; }
  }
  const logs = res.receipts_outcome.flatMap((r) => r.outcome.logs);
  const failures = res.receipts_outcome.filter((r) => r.outcome.status.Failure).map((r) => r.outcome.status.Failure);
  const events = logs.filter((l) => l.startsWith("EVENT_JSON:")).map((l) => JSON.parse(l.slice(11)));
  return { hash, status: st, value, logs, failures, events };
}
