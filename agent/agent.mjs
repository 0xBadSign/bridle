// The Bridle agent: an untrusted operator holding only the vault's `agent_act` function-call key.
//
//   node agent/agent.mjs <vault> --key <agent key file or ed25519:...> [--loop] [--say "<instruction>"]
//                        [--keeper <near account> [--keeper-key <key file or ed25519:...>]] [--min-apr-bps 50]
//
// Without --say it reads Aave's rate and the vault state and acts within the mandate (planFromMarket).
// With --say it obeys the instruction like a prompt-injected LLM would (planFromText), or, if
// OPENAI_BASE_URL / OPENAI_API_KEY / OPENAI_MODEL are set, asks that model. Either way the vault
// decides on-chain; the agent prints the vault's answer.
import { account, baseRpc, call, log, sleep, view } from "../scripts/lib.mjs";
import { Keeper } from "./keeper.mjs";
import { planFromMarket, planFromText, planWithLlm } from "./planner.mjs";

/** Aave v3 `getReserveData(asset).currentLiquidityRate` (ray). */
export async function aaveRate(pool, asset) {
  const data = "0x35ea6a75" + asset.replace(/^0x/, "").padStart(64, "0");
  const r = await baseRpc("eth_call", [{ to: pool, data }, "latest"]);
  // ReserveDataLegacy: configuration, liquidityIndex, currentLiquidityRate, ...
  return BigInt("0x" + r.result.slice(2 + 64 * 2, 2 + 64 * 3));
}

export async function act(vault, keyFile, plan) {
  if (!plan.action) return { skipped: true };
  const agent = account(vault, keyFile);
  const r = await call(agent, vault, "agent_act", { action: plan.action }, { gasT: 150 });
  return { near_tx: r.hash, result: r.value, events: r.events.map((e) => e.event) };
}

async function once(vault, keyFile, say, minAprBps = 50n) {
  const st = await view(vault, "get_state");
  let plan;
  if (say && process.env.OPENAI_BASE_URL && process.env.OPENAI_API_KEY) {
    plan = await planWithLlm(say, st, { baseUrl: process.env.OPENAI_BASE_URL, apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL || "gpt-4o-mini" });
  } else if (say) {
    plan = planFromText(say, st);
  } else {
    plan = planFromMarket(st, await aaveRate(st.chain.pool, st.chain.usdc), { minAprBps });
  }
  log("agent plans:", JSON.stringify(plan.action), "-", plan.why);
  const res = await act(vault, keyFile, plan);
  log("vault says:", JSON.stringify(res.result ?? res), res.near_tx ? `(NEAR tx ${res.near_tx})` : "");
  return res;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  const vault = a[0];
  // `--key arena` uses the deliberately published arena key (web/arena-keys.js).
  const keyFile = opt("--key") === "arena" ? (await import("../web/arena-keys.js")).ARENA_AGENT_KEY : opt("--key");
  // Optional: drive accepted operations to their landing proof (any NEAR account can be the keeper).
  const keeper = a.includes("--keeper") ? new Keeper(vault, opt("--keeper"), { keyFile: opt("--keeper-key") }) : null;
  do {
    const res = await once(vault, keyFile, opt("--say"), BigInt(opt("--min-apr-bps", "50")));
    if (res.result?.ok && keeper) {
      for (let did; (did = await keeper.tick()) !== null; ) {
        log("keeper:", did);
        await sleep(/waiting|cooldown/.test(did) ? 8000 : 1500);
      }
    }
    if (a.includes("--loop")) await sleep(Number(opt("--every", "120000")));
  } while (a.includes("--loop"));
}
