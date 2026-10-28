// The keeper's logic, free of Node-only imports so the same code runs in the browser dashboard
// (web/) and in Node (agent/keeper.mjs). I/O is injected:
//   io.view(contract, method, args?)            -> parsed JSON of a NEAR view call
//   io.call(vault, method, args)                -> { hash, value, events } of a NEAR function call
//   io.baseRpc(method, params)                  -> the raw JSON-RPC reply from Base
//
// The keeper is an untrusted helper. It broadcasts the vault's signed Base transactions, waits for
// the `safe` head, and asks the vault to settle them with position hints. Hints only affect
// liveness: a wrong hint makes the MPC refuse to attest, it can never make the vault count
// something that did not happen.

export const TOPIC = {
  transfer: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
  approval: "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925",
  supply: "0x2b627736bca15cd5381dcf80b0bf11fd197d01a037c52b927a881a10fb73ba61",
  withdraw: "0x3115d1449a7b732c986cba18244e897a450f61e1bb8d589cd2e69e6c8924f9f7",
};
export const word = (a) => "0x" + a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class KeeperCore {
  constructor(vault, io, { onLog } = {}) {
    this.vault = vault;
    this.io = io;
    this.onLog = onLog || (() => {});
  }

  state() {
    return this.io.view(this.vault, "get_state");
  }

  call(method, args) {
    return this.io.call(this.vault, method, args);
  }

  async safeHead() {
    return parseInt((await this.io.baseRpc("eth_getBlockByNumber", ["safe", false])).result.number, 16);
  }

  async receipt(hash) {
    return (await this.io.baseRpc("eth_getTransactionReceipt", [hash])).result;
  }

  /** The log index of the log that proves `call` succeeded, or 0 for log-less checks. */
  expectedLogIndex(st, slotCall, rc) {
    const D = st.chain.vault.toLowerCase();
    const want = {
      approve: [st.chain.usdc, TOPIC.approval],
      supply: [st.chain.pool, TOPIC.supply],
      withdraw: [st.chain.pool, TOPIC.withdraw],
      transfer: [st.chain.usdc, TOPIC.transfer],
    }[slotCall.call];
    if (!want) return 0;
    const l = rc.logs.find((x) => x.address.toLowerCase() === want[0].toLowerCase() && x.topics[0] === want[1] && (slotCall.call !== "transfer" || x.topics[1] === word(D)));
    return l ? parseInt(l.logIndex, 16) : null;
  }

  hints(rc, logIndex) {
    return { block_hash: rc.blockHash, block_number: parseInt(rc.blockNumber, 16), tx_index: parseInt(rc.transactionIndex, 16), log_index: logIndex };
  }

  async broadcast(raw) {
    const r = await this.io.baseRpc("eth_sendRawTransaction", [raw]);
    if (r.error && !/already known|nonce too low|replacement transaction underpriced|known transaction/i.test(r.error.message)) this.onLog("broadcast error " + r.error.message);
    return r.result;
  }

  /** One step of work. Returns a short description of what it did, or null when idle. */
  async tick() {
    const st = await this.state();
    if (st.active === null || st.active === undefined) return null;
    const op = await this.io.view(this.vault, "get_op", { id: st.active });
    const si = op.cursor;
    const slot = op.slots[si];
    if (slot.signing) return "waiting for MPC signature";
    if (slot.verifying) return "waiting for MPC attestation";
    if (slot.status === "unreserved" || (slot.sign_unknown && !(slot.main?.signed?.length))) {
      const r = await this.call("advance", {});
      return `advance -> ${JSON.stringify(r.value)}`;
    }
    const drafts = [["main", slot.main], ["cancel", slot.cancel], ["probe", slot.probe]].filter(([, d]) => d && d.signed.length);
    const safe = await this.safeHead();
    for (const [which, d] of drafts) {
      for (const s of d.signed) {
        const rc = await this.receipt(s.hash);
        if (!rc) {
          await this.broadcast(s.raw);
          continue;
        }
        if (parseInt(rc.blockNumber, 16) > safe) return `${which} ${s.hash.slice(0, 10)} mined, waiting for safe head`;
        if (Date.now() < slot.cooldown_until_ms) return "verify cooldown";
        if (which === "main" && rc.status !== "0x1") {
          // Reverted: the MPC will never attest it. After the deadline anyone may probe the next nonce.
          if (Date.now() > slot.reserved_at_ms + st.policy.settle_deadline_ms && !slot.probe) {
            const r = await this.call("probe", {});
            return `main reverted; probe -> ${JSON.stringify(r.value)}`;
          }
          continue;
        }
        const li = which === "main" ? this.expectedLogIndex(st, slot.call, rc) : 0;
        if (li === null) return `main ${s.hash.slice(0, 10)} has no matching log`;
        const r = await this.call("settle", { op: op.id, slot: si, tx: s.hash, hints: this.hints(rc, li) });
        const ev = r.events.map((e) => e.event).join(",");
        return `settle ${which} ${s.hash.slice(0, 10)} -> ${JSON.stringify(r.value)} [${ev}]`;
      }
    }
    return "broadcast; waiting for inclusion";
  }

  /** Prove an inbound USDC transfer to the vault and credit it. */
  async credit(txHash) {
    const st = await this.state();
    const D = st.chain.vault.toLowerCase();
    let rc;
    while (!(rc = await this.receipt(txHash))) await sleep(2000);
    const l = rc.logs.find((x) => x.address.toLowerCase() === st.chain.usdc.toLowerCase() && x.topics[0] === TOPIC.transfer && x.topics[2] === word(D));
    if (!l) throw new Error("no USDC transfer to the vault in this tx");
    while ((await this.safeHead()) < parseInt(rc.blockNumber, 16)) await sleep(5000);
    const from = "0x" + l.topics[1].slice(26);
    const amount = BigInt(l.data).toString();
    const r = await this.call("credit_deposit", { tx: txHash, hints: this.hints(rc, parseInt(l.logIndex, 16)), from, amount });
    return { result: r.value, events: r.events.map((e) => e.event), near_tx: r.hash };
  }
}
