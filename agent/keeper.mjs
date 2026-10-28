// Keeper: an untrusted helper anyone can run. It broadcasts the vault's signed Base transactions,
// waits for the `safe` head, and asks the vault to settle them with position hints. Hints only
// affect liveness: a wrong hint makes the MPC refuse to attest, it can never make the vault count
// something that did not happen. The logic lives in keeper-core.mjs (shared with the web dashboard).
//
//   node agent/keeper.mjs <vault> [--as <near account>] [--key <key file>] [--once]
//   node agent/keeper.mjs <vault> --credit <base tx hash>       # prove an inbound USDC deposit
import { account, baseRpc, call, log, sleep, view } from "../scripts/lib.mjs";
import { KeeperCore } from "./keeper-core.mjs";

export class Keeper extends KeeperCore {
  /**
   * `signerAccount` is a keychain name or a ready near-api-js Account. `rpc` replaces the Base
   * JSON-RPC (the offline demo injects a mock Base); `pollMs` is the wait between receipt polls.
   */
  constructor(vault, signerAccount, { gasT = 150, keyFile, rpc = baseRpc, pollMs = 2000 } = {}) {
    const acct = typeof signerAccount === "string" ? account(signerAccount, keyFile || signerAccount) : signerAccount;
    super(vault, { view, baseRpc: rpc, pollMs, call: (v, method, args) => call(acct, v, method, args, { gasT }) }, { onLog: (m) => log(m) });
    this.acct = acct;
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
  const k = new Keeper(a[0], opt("--as", "bridle-hq.testnet"), { keyFile: opt("--key") });
  if (a.includes("--credit")) {
    console.log(JSON.stringify(await k.credit(opt("--credit")), null, 1));
  } else {
    await k.run({ once: a.includes("--once") });
  }
}
