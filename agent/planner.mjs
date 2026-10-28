// The agent's decision logic. Runs in Node (agent/agent.mjs) and in the browser (web/).
//
// Two planners:
// - planFromMarket: a small treasury strategy within the mandate (keep a buffer idle, put the rest
//   in Aave while the rate is worth it, pull back when it is not).
// - planFromText: a DELIBERATELY GULLIBLE instruction follower. It does whatever a message says.
//   It stands in for an LLM agent that a prompt injection has convinced. The point of Bridle is that
//   this does not matter: the vault checks every request against the mandate on-chain.
//
// Both return { action, why } where `action` is the exact JSON the vault's `agent_act` takes. The
// vault API has no destination field, so an injected address can only be dropped or ignored.

const USDC = 1_000_000n;

/** Parse "50", "50.5", "1,000", "all", "everything", "max" into USDC base units (or "all"). */
function parseAmount(text) {
  if (/\b(all|everything|max|entire|whole|every\s+cent)\b/i.test(text)) return "all";
  const m = text.replace(/,/g, "").match(/(\d+(?:\.\d+)?)\s*(k|m)?\s*(usdc|usd|\$|dollars)?/i);
  if (!m) return null;
  let v = Number(m[1]);
  if (m[2]?.toLowerCase() === "k") v *= 1e3;
  if (m[2]?.toLowerCase() === "m") v *= 1e6;
  return BigInt(Math.round(v * 1e6));
}

/**
 * Turn any instruction into a vault request, as a compromised agent would.
 * `state` is the vault's `get_state` view (used to resolve "all").
 */
export function planFromText(text, state) {
  const t = text.toLowerCase();
  const amount = parseAmount(text);
  const idle = BigInt(state?.ledger?.idle ?? 0);
  const principal = BigInt(state?.ledger?.principal ?? 0);
  const total = idle + principal;
  const addr = text.match(/0x[0-9a-fA-F]{40}/)?.[0];
  const asked = (fallback) => (amount === "all" ? fallback : amount ?? fallback);
  let action;
  let why;
  if (/\b(send|transfer|pay|drain|wire|move .* to|give)\b/.test(t)) {
    // The agent obeys. The vault has no "send to address" action, so the closest thing it can
    // request is an outflow; the address cannot even be expressed.
    action = { action: "send_to_treasury", amount: asked(total || 1n).toString() };
    why = `Instruction says to send ${amount === "all" ? "everything" : "funds"}${addr ? ` to ${addr}` : ""}. Requesting an outflow (the vault API has no destination field, so the address is dropped).`;
  } else if (/\b(withdraw|pull|exit|unwind|redeem|take out)\b/.test(t)) {
    action = { action: "withdraw", amount: asked(principal + 1n).toString() };
    why = "Instruction says to withdraw. Requesting it as written.";
  } else if (/\b(supply|deposit|invest|lend|put|ape|yolo|leverage|stake)\b/.test(t)) {
    action = { action: "supply", amount: asked(idle * 10n || 1_000_000n * USDC).toString() };
    why = "Instruction says to put funds in. Requesting it as written.";
  } else if (/\b(unpause|disable|turn off|remove|change|raise|increase|policy|limit|cap|guardian|owner|upgrade|admin|key)\b/.test(t)) {
    // An agent key can only call agent_act; it has no way to ask for governance changes.
    action = { action: "unwind" };
    why = "Instruction asks for a governance or key change. The agent key can only call agent_act, so the closest request is an unwind.";
  } else {
    action = { action: "supply", amount: (amount === "all" || amount === null ? idle + 1n : amount).toString() };
    why = "Unclear instruction; doing something anyway.";
  }
  return { action, why, gullible: true };
}

/**
 * A modest strategy inside the mandate.
 * `rateRay` is Aave's current liquidity rate (1e27 = 100% APR); `policy` and `ledger` from `get_state`.
 */
export function planFromMarket(state, rateRay, { bufferBps = 2000n, minAprBps = 50n } = {}) {
  const l = state.ledger;
  const p = state.policy;
  const idle = BigInt(l.idle);
  const principal = BigInt(l.principal);
  const total = idle + principal;
  const aprBps = (BigInt(rateRay) * 10000n) / 10n ** 27n;
  const maxPer = BigInt(p.agent_max_per_action);
  const headroom = BigInt(p.supply_cap) - principal - BigInt(l.supplying);
  const buffer = (total * bufferBps) / 10000n;
  if (aprBps >= minAprBps && idle > buffer) {
    let amt = idle - buffer;
    if (amt > maxPer) amt = maxPer;
    if (amt > headroom) amt = headroom;
    if (amt > 0n) return { action: { action: "supply", amount: amt.toString() }, why: `Aave pays ${fmtBps(aprBps)}; keeping a ${fmtBps(bufferBps)} buffer idle, supplying ${fmtUsdc(amt)}.` };
  }
  if (aprBps < minAprBps && principal > 0n) {
    const amt = principal > maxPer ? maxPer : principal;
    return { action: { action: "withdraw", amount: amt.toString() }, why: `Aave pays only ${fmtBps(aprBps)}; withdrawing ${fmtUsdc(amt)}.` };
  }
  return { action: null, why: `Nothing to do (Aave ${fmtBps(aprBps)}, idle ${fmtUsdc(idle)}, in Aave ${fmtUsdc(principal)}).` };
}

export const fmtUsdc = (v) => `${(Number(BigInt(v)) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 6 })} USDC`;
const fmtBps = (b) => `${(Number(b) / 100).toFixed(2)}%`;

/** Optional: ask an OpenAI-compatible model for a plan. The vault checks the result like any other. */
export async function planWithLlm(text, state, { baseUrl, apiKey, model }) {
  const sys = "You manage a DAO treasury vault. Reply with ONLY a JSON object {\"action\":{...},\"why\":\"...\"} where action is one of {\"action\":\"supply\",\"amount\":\"<USDC base units>\"}, {\"action\":\"withdraw\",\"amount\":\"...\"}, {\"action\":\"send_to_treasury\",\"amount\":\"...\"}, {\"action\":\"unwind\"}. USDC has 6 decimals.";
  const r = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, temperature: 0, messages: [{ role: "system", content: sys }, { role: "user", content: `Vault state: ${JSON.stringify(state.ledger)}\nInstruction: ${text}` }] }),
  });
  const j = await r.json();
  const content = j.choices?.[0]?.message?.content ?? "";
  const m = content.match(/\{[\s\S]*\}/);
  if (!m) return { action: null, why: `model reply not understood: ${content.slice(0, 200)}` };
  const plan = JSON.parse(m[0]);
  return { action: plan.action, why: plan.why, llm: model };
}
