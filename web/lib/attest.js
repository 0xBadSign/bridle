// Independent check of an MPC landing proof, shared by `scripts/verify-attestation.mjs` (Node) and
// the dashboard (browser). It does not trust the vault: it reads the NEAR transaction in which the
// vault asked `v1.signer` to attest a Base transaction, re-reads that Base transaction from a Base
// RPC, rebuilds the payload the MPC signs (sha256 of the borsh `ForeignTxSignPayload::V1`, the same
// encoding as `crates/bridle-core/src/foreign.rs`), and recovers the attestation signature.
//
// Inputs are injected so the same code runs in both places:
//   io.nearTx(hash)          -> the transaction with receipts and outcomes (FastNEAR tx API shape)
//   io.baseReceipt(txHash)   -> eth_getTransactionReceipt result
//   io.sha256(bytes)         -> Uint8Array(32)
//   io.recover(sig65, msg32) -> uncompressed public key, 65 bytes (0x04 || x || y)
//   io.mpcKeyHex()           -> the signer's ForeignTx-domain public key, hex (64 or 65 bytes)

const PAYLOAD_V1 = 0;
const CHAIN_BASE = 6;
const EXTRACTOR_BLOCK_HASH = 0;
const EXTRACTOR_LOG = 1;
const FINALITY_SAFE = 1;
const VALUE_EVM = 1;
const EVM_VALUE_BLOCK_HASH = 0;
const EVM_VALUE_LOG = 1;

export const hexToBytes = (h) => {
  const s = String(h).replace(/^0x/, "");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
};
export const bytesToHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

const u32le = (n) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
};
const u64le = (n) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
  return b;
};
const concat = (parts) => {
  const len = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

/** The bytes the MPC hashes for a Base request with `[BlockHash]` or `[BlockHash, Log{logIndex}]`. */
export function payloadBytes({ txId, logIndex, blockHash, blockNumber, txIndex, log }) {
  const tx = hexToBytes(txId);
  const bh = hexToBytes(blockHash);
  const withLog = logIndex !== null && logIndex !== undefined;
  const request = withLog
    ? [Uint8Array.of(CHAIN_BASE), tx, u32le(2), Uint8Array.of(EXTRACTOR_BLOCK_HASH, EXTRACTOR_LOG), u64le(logIndex), Uint8Array.of(FINALITY_SAFE)]
    : [Uint8Array.of(CHAIN_BASE), tx, u32le(1), Uint8Array.of(EXTRACTOR_BLOCK_HASH), Uint8Array.of(FINALITY_SAFE)];
  const parts = [Uint8Array.of(PAYLOAD_V1), ...request];
  if (withLog) {
    const data = new TextEncoder().encode(String(log.data).toLowerCase());
    parts.push(u32le(2), Uint8Array.of(VALUE_EVM, EVM_VALUE_BLOCK_HASH), bh, Uint8Array.of(VALUE_EVM, EVM_VALUE_LOG));
    parts.push(Uint8Array.of(0), u64le(logIndex), u64le(txIndex), tx, bh, u64le(blockNumber), hexToBytes(log.address));
    parts.push(u32le(data.length), data, u32le(log.topics.length), ...log.topics.map(hexToBytes));
  } else {
    parts.push(u32le(1), Uint8Array.of(VALUE_EVM, EVM_VALUE_BLOCK_HASH), bh);
  }
  return concat(parts);
}

const b64json = (v) => {
  try {
    const text = typeof atob === "function" ? new TextDecoder().decode(Uint8Array.from(atob(v), (c) => c.charCodeAt(0))) : Buffer.from(v, "base64").toString();
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** Find the verify request, the MPC's answer and the vault's verdict inside one NEAR transaction. */
export function findAttestation(tx) {
  let request = null;
  let answer = null;
  const events = [];
  for (const r of tx.receipts || []) {
    const fc = r.receipt?.receipt?.Action?.actions?.find((a) => a.FunctionCall)?.FunctionCall;
    const out = r.execution_outcome?.outcome;
    if (fc?.method_name === "verify_foreign_transaction") request = { from: r.receipt.predecessor_id, signer: r.receipt.receiver_id, args: b64json(fc.args) };
    const v = out?.status?.SuccessValue ? b64json(out.status.SuccessValue) : null;
    if (v && v.payload_hash && v.signature) answer = { by: out.executor_id, ...v };
    for (const l of out?.logs || []) {
      if (l.startsWith("EVENT_JSON:")) {
        try {
          const e = JSON.parse(l.slice(11));
          if (e.standard === "bridle") events.push({ event: e.event, data: e.data, by: out.executor_id });
        } catch {
          /* not ours */
        }
      }
    }
  }
  return { request, answer, events };
}

/** Run every check; returns { ok, steps: [{ name, ok, detail }] }. */
export async function verifyAttestation(nearHash, io) {
  const steps = [];
  const step = (name, ok, detail = "") => {
    steps.push({ name, ok: Boolean(ok), detail });
    return Boolean(ok);
  };
  const tx = await io.nearTx(nearHash);
  if (!step("NEAR transaction found", tx, nearHash)) return { ok: false, steps };
  const { request, answer, events } = findAttestation(tx);
  if (!step("it contains a verify_foreign_transaction request", request, request ? `${request.from} -> ${request.signer}` : "none (not a settle or credit transaction?)")) return { ok: false, steps };
  const base = request.args?.request?.request?.Base;
  const expected = request.args?.request?.expected_payload_hash;
  if (!step("the request names a Base transaction and an expected payload hash", base && expected, base ? `tx ${base.tx_id}, extractors ${JSON.stringify(base.extractors)}, finality ${base.finality}` : "")) return { ok: false, steps };
  step("the request asks for Safe finality", base.finality === "Safe", base.finality);
  const logEx = (base.extractors || []).find((e) => e && e.Log);
  const logIndex = logEx ? logEx.Log.log_index : null;

  const rc = await io.baseReceipt("0x" + String(base.tx_id).replace(/^0x/, ""));
  if (!step("Base RPC knows the transaction", rc, rc ? `block ${parseInt(rc.blockNumber, 16)}, status ${rc.status}` : "not found")) return { ok: false, steps };
  step("it succeeded on Base (status 1)", rc.status === "0x1", rc.status);
  let log = null;
  if (logIndex !== null) {
    log = rc.logs.find((l) => parseInt(l.logIndex, 16) === logIndex);
    step(`log ${logIndex} belongs to this transaction`, log, log ? `${log.address} topic0 ${log.topics[0].slice(0, 10)}...` : "no such log in this receipt");
  }
  const bytes = payloadBytes({
    txId: base.tx_id,
    logIndex,
    blockHash: rc.blockHash,
    blockNumber: parseInt(rc.blockNumber, 16),
    txIndex: parseInt(rc.transactionIndex, 16),
    log,
  });
  const recomputed = bytesToHex(await io.sha256(bytes));
  step("the payload rebuilt from Base data equals the hash the vault expected", recomputed === String(expected).replace(/^0x/, "").toLowerCase(), `sha256 ${recomputed}`);
  if (!step("the MPC answered with an attestation", answer, answer ? `by ${answer.by}` : "no answer in this transaction (refused or timed out: nothing was attested)")) return { ok: steps.every((s) => s.ok), steps, events };
  step("the MPC signed exactly that payload", String(answer.payload_hash).toLowerCase() === recomputed, `payload_hash ${answer.payload_hash}`);
  const r = hexToBytes(answer.signature.big_r.affine_point).slice(1);
  const s = hexToBytes(answer.signature.s.scalar);
  const sig = concat([Uint8Array.of(answer.signature.recovery_id), r, s]);
  const pub = bytesToHex(io.recover(sig, hexToBytes(recomputed))).replace(/^04/, "");
  const mpc = String(await io.mpcKeyHex()).replace(/^0x/, "").replace(/^04/, "").toLowerCase();
  step("the signature recovers to the MPC network's ForeignTx-domain key", pub === mpc, `recovered 04${pub.slice(0, 16)}...`);
  const verdict = events.find((e) => e.event === "attested" || e.event === "credited" || e.event === "not_attested" || e.event === "credit_not_attested");
  step("the vault recorded the same verdict on-chain", verdict && (verdict.event === "attested" || verdict.event === "credited"), verdict ? `${verdict.event} ${JSON.stringify(verdict.data)}` : "no vault event");
  return { ok: steps.every((x) => x.ok), steps, events };
}
