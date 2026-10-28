// A tiny stand-in for Base, used only by `make demo`. It plays the chain around the vault:
//   - a JSON-RPC surface (`rpc`) with the three calls the keeper needs (safe head, receipt, send raw tx);
//   - a mempool with per-account nonces and Base's replacement rule (both fee fields up by >= 10%);
//   - real transaction handling: signed EIP-1559 bytes are RLP-decoded and the sender is recovered
//     with ecrecover, so "who signed this" is checked, not assumed;
//   - just enough USDC / Aave behaviour to emit the logs the real chain emits (see the live
//     receipts in crates/bridle-core/tests/fixtures) and to move balances;
//   - `mine()`, which includes pending transactions in a block and registers each one with the mock
//     MPC signer (`mock_land`), the way the real MPC network would see them on Base.
// Nothing here is trusted by the vault: the vault only believes the (mock) MPC attestation.
import crypto from "crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { evmAddress, keccakHex } from "./lib.mjs";

export const TOPIC = {
  transfer: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
  approval: "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925",
  supply: "0x2b627736bca15cd5381dcf80b0bf11fd197d01a037c52b927a881a10fb73ba61",
  withdraw: "0x3115d1449a7b732c986cba18244e897a450f61e1bb8d589cd2e69e6c8924f9f7",
  reserveData: "0x804c9b842b2748a22bb64b345453a3de7ca54a6ca45ce00d415894979e22897a",
};
const SEL = { approve: "095ea7b3", supply: "617ba037", withdraw: "69328dec", transfer: "a9059cbb" };
const ZERO = "0x" + "0".repeat(40);
const hex = (n) => "0x" + n.toString(16);
const word = (v) => "0x" + (typeof v === "bigint" || typeof v === "number" ? BigInt(v).toString(16) : v.toLowerCase().replace(/^0x/, "")).padStart(64, "0");
const lc = (a) => a.toLowerCase();

// ---- RLP (decode only) and EIP-1559 transaction parsing -----------------------------------

function readBE(buf, o, n) {
  let v = 0;
  for (let i = 0; i < n; i++) v = v * 256 + buf[o + i];
  return v;
}

function rlpItem(buf, o) {
  const b = buf[o];
  if (b < 0x80) return { start: o, ds: o, end: o + 1, list: false };
  if (b < 0xb8) return { start: o, ds: o + 1, end: o + 1 + (b - 0x80), list: false };
  if (b < 0xc0) {
    const ll = b - 0xb7;
    const l = readBE(buf, o + 1, ll);
    return { start: o, ds: o + 1 + ll, end: o + 1 + ll + l, list: false };
  }
  if (b < 0xf8) return { start: o, ds: o + 1, end: o + 1 + (b - 0xc0), list: true };
  const ll = b - 0xf7;
  const l = readBE(buf, o + 1, ll);
  return { start: o, ds: o + 1 + ll, end: o + 1 + ll + l, list: true };
}

function rlpListHeader(len) {
  if (len < 56) return Buffer.from([0xc0 + len]);
  const lb = [];
  for (let l = len; l > 0; l = Math.floor(l / 256)) lb.unshift(l % 256);
  return Buffer.from([0xf7 + lb.length, ...lb]);
}

/** Parse a signed type-2 transaction and recover its sender. */
export function parseRawTx(rawHex) {
  const buf = Buffer.from(rawHex.replace(/^0x/, ""), "hex");
  if (buf[0] !== 2) throw new Error("not an EIP-1559 transaction");
  const top = rlpItem(buf, 1);
  const items = [];
  for (let p = top.ds; p < top.end; ) {
    const it = rlpItem(buf, p);
    items.push(it);
    p = it.end;
  }
  const bytes = (i) => buf.subarray(items[i].ds, items[i].end);
  const num = (i) => (bytes(i).length ? BigInt("0x" + bytes(i).toString("hex")) : 0n);
  const body = Buffer.concat(items.slice(0, 9).map((it) => buf.subarray(it.start, it.end)));
  const sighash = Buffer.from(keccakHex(Buffer.concat([Buffer.from([2]), rlpListHeader(body.length), body])), "hex");
  const r = bytes(10).toString("hex").padStart(64, "0");
  const s = bytes(11).toString("hex").padStart(64, "0");
  const v = Number(num(9));
  const sig = Buffer.from([v, ...Buffer.from(r, "hex"), ...Buffer.from(s, "hex")]);
  const pub = secp256k1.Point.fromBytes(secp256k1.recoverPublicKey(sig, sighash, { prehash: false })).toBytes(false);
  return {
    hash: "0x" + keccakHex(buf),
    chainId: Number(num(0)),
    nonce: Number(num(1)),
    maxPriorityFee: num(2),
    maxFee: num(3),
    gas: Number(num(4)),
    to: "0x" + bytes(5).toString("hex"),
    value: num(6),
    data: bytes(7).toString("hex"),
    from: evmAddress(Buffer.from(pub.subarray(1)).toString("hex")),
  };
}

// ---- The chain ---------------------------------------------------------------------------------

export class MockBase {
  /**
   * @param chain   { chain_id, usdc, pool, atoken, vault } as given to the vault
   * @param land    async (txId, blockHash, blockNumber, txIndex, success, logs) => void: registers a
   *                mined transaction with the mock MPC signer
   * @param startNonce  the vault address's account nonce on this chain
   */
  constructor(chain, land, startNonce) {
    this.chain = Object.fromEntries(Object.entries(chain).map(([k, v]) => [k, typeof v === "string" ? lc(v) : v]));
    this.land = land;
    this.head = 1000;
    this.nonces = new Map([[this.chain.vault, startNonce]]);
    this.usdc = new Map();
    this.atoken = new Map();
    this.allowance = new Map();
    this.mempool = new Map(); // `${from}:${nonce}` -> parsed tx + raw
    this.receipts = new Map();
    this.history = []; // every mined transaction, for the final audit
    this.hold = false; // when true, mine() includes nothing (a stuck, underpriced transaction)
    this.failNext = null; // revert the next transaction of this kind ("approve" | "supply" | "withdraw" | "transfer")
    this.replaced = []; // { oldHash, newHash } for replacement-by-fee
  }

  nonceOf(a) {
    return this.nonces.get(lc(a)) ?? 0;
  }
  bal(map, a) {
    return map.get(lc(a)) ?? 0n;
  }
  usdcOf(a) {
    return this.bal(this.usdc, a);
  }
  aOf(a) {
    return this.bal(this.atoken, a);
  }
  add(map, a, d) {
    map.set(lc(a), this.bal(map, a) + d);
  }

  /** The JSON-RPC subset the keeper uses. */
  async rpc(method, params) {
    if (method === "eth_getBlockByNumber") return { result: { number: hex(this.head) } };
    if (method === "eth_getTransactionReceipt") return { result: this.receipts.get(lc(params[0])) ?? null };
    if (method === "eth_sendRawTransaction") return this.sendRaw(params[0]);
    return { error: { message: `mock base: unsupported method ${method}` } };
  }

  sendRaw(raw) {
    let tx;
    try {
      tx = parseRawTx(raw);
    } catch (e) {
      return { error: { message: `invalid transaction: ${e.message}` } };
    }
    if (tx.chainId !== this.chain.chain_id) return { error: { message: "invalid chain id" } };
    if (tx.nonce < this.nonceOf(tx.from)) return { error: { message: "nonce too low" } };
    const key = `${tx.from}:${tx.nonce}`;
    const old = this.mempool.get(key);
    if (old) {
      if (old.hash === tx.hash) return { error: { message: "already known" } };
      const bump = (a, b) => b * 100n >= a * 110n;
      if (!(bump(old.maxFee, tx.maxFee) && bump(old.maxPriorityFee, tx.maxPriorityFee))) return { error: { message: "replacement transaction underpriced" } };
      this.replaced.push({ oldHash: old.hash, newHash: tx.hash, nonce: tx.nonce });
    }
    this.mempool.set(key, { ...tx, raw });
    return { result: tx.hash };
  }

  topicAddr(a) {
    return word(a);
  }

  /** Execute a transaction against the toy state. Returns { kind, ok, logs[], text }. */
  execute(tx) {
    const c = this.chain;
    const D = tx.from;
    const arg = (i) => "0x" + tx.data.slice(8 + 64 * i, 8 + 64 * (i + 1));
    const addr = (i) => "0x" + arg(i).slice(26);
    const amt = (i) => BigInt(arg(i));
    const f = (n) => (Number(n) / 1e6).toFixed(2);
    const forced = (k) => {
      if (this.failNext !== k) return false;
      this.failNext = null;
      return true;
    };
    const reserve = () => ({ address: c.pool, topics: [TOPIC.reserveData, word(c.usdc)], data: word(1n) + word(2n).slice(2) + word(3n).slice(2) + word(4n).slice(2) + word(5n).slice(2) });
    if (tx.to === c.usdc && tx.data.startsWith(SEL.approve)) {
      const [spender, a] = [addr(0), amt(1)];
      if (forced("approve")) return { kind: "approve", ok: false, logs: [], text: `USDC.approve(${spender.slice(0, 8)}.., ${f(a)}) REVERTED` };
      this.allowance.set(`${D}:${spender}`, a);
      return { kind: "approve", ok: true, logs: [{ address: c.usdc, topics: [TOPIC.approval, word(D), word(spender)], data: word(a) }], text: `USDC.approve(pool, ${f(a)})` };
    }
    if (tx.to === c.usdc && tx.data.startsWith(SEL.transfer)) {
      const [to, a] = [addr(0), amt(1)];
      if (forced("transfer") || this.usdcOf(D) < a) return { kind: "transfer", ok: false, logs: [], text: `USDC.transfer(${to.slice(0, 8)}.., ${f(a)}) REVERTED` };
      this.add(this.usdc, D, -a);
      this.add(this.usdc, to, a);
      return { kind: "transfer", ok: true, logs: [{ address: c.usdc, topics: [TOPIC.transfer, word(D), word(to)], data: word(a) }], text: `USDC.transfer(${to.slice(0, 8)}.., ${f(a)})` };
    }
    if (tx.to === c.pool && tx.data.startsWith(SEL.supply)) {
      const a = amt(1);
      const allowed = this.allowance.get(`${D}:${c.pool}`) ?? 0n;
      if (forced("supply") || allowed < a || this.usdcOf(D) < a) return { kind: "supply", ok: false, logs: [], text: `Aave.supply(USDC, ${f(a)}) REVERTED` };
      this.allowance.set(`${D}:${c.pool}`, allowed - a);
      this.add(this.usdc, D, -a);
      this.add(this.usdc, c.atoken, a);
      this.add(this.atoken, D, a);
      return {
        kind: "supply",
        ok: true,
        text: `Aave.supply(USDC, ${f(a)})`,
        // Realistic noise before the Supply log: the keeper must find the right one.
        logs: [
          { address: c.usdc, topics: [TOPIC.transfer, word(D), word(c.atoken)], data: word(a) },
          reserve(),
          { address: c.atoken, topics: [TOPIC.transfer, word(ZERO), word(D)], data: word(a) },
          { address: c.pool, topics: [TOPIC.supply, word(c.usdc), word(D), word(0n)], data: word(D) + word(a).slice(2) },
        ],
      };
    }
    if (tx.to === c.pool && tx.data.startsWith(SEL.withdraw)) {
      const a = amt(1);
      if (forced("withdraw") || this.aOf(D) < a) return { kind: "withdraw", ok: false, logs: [], text: `Aave.withdraw(USDC, ${f(a)}) REVERTED` };
      this.add(this.atoken, D, -a);
      this.add(this.usdc, c.atoken, -a);
      this.add(this.usdc, D, a);
      return {
        kind: "withdraw",
        ok: true,
        text: `Aave.withdraw(USDC, ${f(a)})`,
        logs: [
          reserve(),
          { address: c.atoken, topics: [TOPIC.transfer, word(D), word(ZERO)], data: word(a) },
          { address: c.usdc, topics: [TOPIC.transfer, word(c.atoken), word(D)], data: word(a) },
          { address: c.pool, topics: [TOPIC.withdraw, word(c.usdc), word(D), word(D)], data: word(a) },
        ],
      };
    }
    if (tx.to === D && tx.data === "") return { kind: "cancel", ok: true, logs: [], text: "0-value self-transfer (cancel / probe)" };
    return { kind: "unknown", ok: false, logs: [], text: "call to an unexpected target REVERTED" };
  }

  /** Include a block of transactions: those whose nonce is next for their sender. */
  async mine() {
    const mined = [];
    if (this.hold) return mined;
    const number = ++this.head;
    const blockHash = "0x" + crypto.createHash("sha256").update(`bridle-demo-block-${number}`).digest("hex");
    let progress = true;
    let txIndex = 0;
    let logIndex = 0;
    const included = [];
    while (progress) {
      progress = false;
      for (const [key, tx] of [...this.mempool]) {
        if (tx.nonce !== this.nonceOf(tx.from)) continue;
        this.mempool.delete(key);
        this.nonces.set(tx.from, tx.nonce + 1);
        const r = this.execute(tx);
        const logs = r.logs.map((l) => ({ ...l, logIndex: hex(logIndex++) }));
        const receipt = {
          status: r.ok ? "0x1" : "0x0",
          blockHash,
          blockNumber: hex(number),
          transactionIndex: hex(txIndex),
          transactionHash: tx.hash,
          logs,
        };
        this.receipts.set(tx.hash, receipt);
        const entry = { hash: tx.hash, from: tx.from, nonce: tx.nonce, kind: r.kind, ok: r.ok, text: r.text, block: number, maxFee: tx.maxFee, maxPriorityFee: tx.maxPriorityFee, logs: logs.length };
        this.history.push(entry);
        included.push({ tx, receipt, entry });
        mined.push(entry);
        txIndex++;
        progress = true;
      }
    }
    for (const { tx, receipt } of included) {
      await this.land(
        tx.hash,
        blockHash,
        number,
        parseInt(receipt.transactionIndex, 16),
        receipt.status === "0x1",
        receipt.logs.map((l) => ({ log_index: parseInt(l.logIndex, 16), address: l.address, topics: l.topics, data: l.data })),
      );
    }
    return mined;
  }

  /** An outside account sends USDC to the vault. Returns the mined transaction hash. */
  async deposit(from, amount) {
    const number = ++this.head;
    const blockHash = "0x" + crypto.createHash("sha256").update(`bridle-demo-block-${number}`).digest("hex");
    const hash = "0x" + crypto.createHash("sha256").update(`bridle-demo-deposit-${number}-${from}-${amount}`).digest("hex");
    this.add(this.usdc, this.chain.vault, amount);
    const logs = [{ address: this.chain.usdc, topics: [TOPIC.transfer, word(from), word(this.chain.vault)], data: word(amount), logIndex: "0x0" }];
    this.receipts.set(hash, { status: "0x1", blockHash, blockNumber: hex(number), transactionIndex: "0x0", transactionHash: hash, logs });
    this.nonces.set(lc(from), this.nonceOf(from) + 1);
    this.history.push({ hash, from: lc(from), nonce: this.nonceOf(from) - 1, kind: "deposit", ok: true, text: `USDC.transfer(vault, ${(Number(amount) / 1e6).toFixed(2)})`, block: number, logs: 1 });
    await this.land(hash, blockHash, number, 0, true, [{ log_index: 0, address: this.chain.usdc, topics: logs[0].topics, data: logs[0].data }]);
    return hash;
  }
}
