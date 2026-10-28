// Keeper: an untrusted helper anyone can run. It broadcasts the vault's signed Base transactions,
// waits for the `safe` head, and asks the vault to settle them with position hints. Hints only
// affect liveness: a wrong hint makes the MPC refuse to attest, it can never make the vault count
// something that did not happen.
//
//   node agent/keeper.mjs <vault> [--as <near account>] [--once]
//   node agent/keeper.mjs <vault> --credit <base tx hash>       # prove an inbound USDC deposit
import { account, baseRpc, call, log, sleep, view } from "../scripts/lib.mjs";

const TOPIC = {
  transfer: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
  approval: "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925",
  supply: "0x2b627736bca15cd5381dcf80b0bf11fd197d01a037c52b927a881a10fb73ba61",
  withdraw: "0x3115d1449a7b732c986cba18244e897a450f61e1bb8d589cd2e69e6c8924f9f7",
};
const word = (a) => "0x" + a.toLowerCase().replace(/^0x/, "").padStart(64, "0");

export class Keeper {
  /**
   * `signerAccount` is a keychain name or a ready near-api-js Account. `rpc` replaces the Base JSON-RPC
   * (the offline demo injects a mock Base); `pollMs` is the wait between receipt polls.
   */
  constructor(vault, signerAccount, { gasT = 150, rpc = baseRpc, pollMs = 2000 } = {}) {
    this.vault = vault;
    this.acct = typeof signerAccount === "string" ? account(signerAccount) : signerAccount;
    this.rpc = rpc;
    this.pollMs = pollMs;
    this.gasT = gasT;
  }

  async state() {
    return view(this.vault, "get_state");
  }

  call(method, args) {
    return call(this.acct, this.vault, method, args, { gasT: this.gasT });
  }

  async safeHead() {
    return parseInt((await this.rpc("eth_getBlockByNumber", ["safe", false])).result.number, 16);
  }

  async receipt(hash) {
    return (await this.rpc("eth_getTransactionReceipt", [hash])).result;
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
    const r = await this.rpc("eth_sendRawTransaction", [raw]);
    if (r.error && !/already known|nonce too low|replacement transaction underpriced|known transaction/i.test(r.error.message)) log("broadcast error", r.error.message);
    return r.result;
  }

  /** One step of work. Returns a short description of what it did, or null when idle. */
  async tick() {
    const st = await this.state();
    if (st.active === null || st.active === undefined) return null;
    const op = await view(this.vault, "get_op", { id: st.active });
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
        let rc = await this.receipt(s.hash);
        if (!rc) {
          await this.broadcast(s.raw);
          continue;
        }
        if (parseInt(rc.blockNumber, 16) > safe) return `${which} ${s.hash.slice(0, 10)} mined, waiting for safe head`;
        if (st.now_ms < slot.cooldown_until_ms) return "verify cooldown";
        if (which === "main" && rc.status !== "0x1") {
          // Reverted: the MPC will never attest it. After the deadline anyone may probe the next nonce.
          if (st.now_ms > slot.reserved_at_ms + st.policy.settle_deadline_ms && !slot.probe) {
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
    while (!(rc = await this.receipt(txHash))) await sleep(this.pollMs);
    const l = rc.logs.find((x) => x.address.toLowerCase() === st.chain.usdc.toLowerCase() && x.topics[0] === TOPIC.transfer && x.topics[2] === word(D));
    if (!l) throw new Error("no USDC transfer to the vault in this tx");
    while ((await this.safeHead()) < parseInt(rc.blockNumber, 16)) await sleep(this.pollMs * 2.5);
    const from = "0x" + l.topics[1].slice(26);
    const amount = BigInt(l.data).toString();
    const r = await this.call("credit_deposit", { tx: txHash, hints: this.hints(rc, parseInt(l.logIndex, 16)), from, amount });
    return { result: r.value, events: r.events.map((e) => e.event), near_tx: r.hash };
  }

  async run({ once = false, idleMs = 8000 } = {}) {
    for (;;) {
      let did;
      try {
        did = await this.tick();
      } catch (e) {
        did = `error: ${String(e.message || e).slice(0, 200)}`;
      }
      if (did) log(did);
      if (once && !did) return;
      await sleep(did && !/waiting|cooldown/.test(did) ? 1500 : idleMs);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  const k = new Keeper(a[0], opt("--as", "bridle-hq.testnet"));
  if (a.includes("--credit")) {
    console.log(JSON.stringify(await k.credit(opt("--credit")), null, 1));
  } else {
    await k.run({ once: a.includes("--once") });
  }
}
