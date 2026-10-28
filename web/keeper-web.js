// The browser as an untrusted keeper for the ARENA vault. Same logic as `agent/keeper.mjs`
// (shared through agent/keeper-core.mjs); only the I/O differs. The keeper key is published on
// purpose (see arena-keys.js): it can only call public methods that any visitor could call.
import { KeeperCore } from "../agent/keeper-core.mjs";
import { ARENA_VAULT, PUBLIC_KEEPER_ACCOUNT, PUBLIC_KEEPER_KEY } from "./arena-keys.js";
import { baseRpc, makeCaller, view } from "./lib/chain.js";

export function createKeeper() {
  let caller;
  let chain = Promise.resolve(); // serialize NEAR calls so the key's nonce never races
  const io = {
    view,
    baseRpc,
    call: (vault, method, args) => {
      const run = async () => {
        caller ||= await makeCaller(PUBLIC_KEEPER_ACCOUNT, PUBLIC_KEEPER_KEY);
        return caller(vault, method, args, { gasT: 150 });
      };
      const p = chain.then(run, run);
      chain = p.catch(() => {});
      return p;
    },
  };
  const lines = [];
  const subs = new Set();
  const note = (text) => {
    lines.push({ at: Date.now(), text });
    if (lines.length > 60) lines.shift();
    subs.forEach((f) => f(lines));
  };
  const core = new KeeperCore(ARENA_VAULT, io, { onLog: note });
  let busy = false;
  let timer = null;
  let working = false;
  let lastTxs = [];

  async function tickOnce() {
    if (busy) return;
    busy = true;
    let delay = 9000 + Math.random() * 4000; // jitter so many visitors do not collide
    try {
      const did = await core.tick();
      working = did !== null;
      if (did) {
        note(did);
        if (/^(advance|settle)/.test(did)) delay = 2500;
      }
    } catch (e) {
      working = false;
      note("error: " + String(e.message || e).slice(0, 200));
    } finally {
      busy = false;
      schedule(delay);
    }
  }
  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (document.hidden) return schedule(5000);
      tickOnce();
    }, ms);
  }
  return {
    start: () => schedule(1500),
    kick: () => schedule(1500),
    isWorking: () => working,
    lines: () => lines,
    subscribe: (f) => (subs.add(f), () => subs.delete(f)),
    lastTxs: () => lastTxs,
  };
}
