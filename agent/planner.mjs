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

const MONTHS = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const ACTION_VERBS = "send|transfer|pay|drain|wire|move|give|withdraw|pull|exit|unwind|redeem|supply|deposit|invest|lend|put|stake|leverage|amount";
const DATE_RE = new RegExp(
  String.raw`\b\d{4}-\d{1,2}-\d{1,2}\b|\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b` + // 2026-11-01, 01/11/2026
    String.raw`|\b(?:${MONTHS})\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?\b` + // November 1, 2026
    String.raw`|\b\d{1,2}(?:st|nd|rd|th)?\s+(?:${MONTHS})\.?(?:,?\s+\d{4})?\b` + // 1 November 2026
    String.raw`|\b(?:${MONTHS})\.?,?\s+\d{4}\b`, // November 2026
  "gi",
);
const NUM = String.raw`(\d+(?:\.\d+)?)(?![\d.])\s*(?:(thousand|million|k|m)(?![a-z]))?`;
const AMOUNT_RES = [
  new RegExp(String.raw`\$\s*${NUM}`, "i"), // $50
  new RegExp(String.raw`${NUM}\s*(?:usdc|usd|dollars|bucks)\b`, "i"), // 50 USDC
  new RegExp(String.raw`\b(?:${ACTION_VERBS})\b[^\d.\n]{0,20}?${NUM}`, "i"), // send 50
];

/**
 * Parse "50", "50.5", "1,000", "all", "everything", "max" into USDC base units (or "all").
 * A number counts as an amount only when it is tied to a currency ("$50", "50 USDC") or follows an
 * action verb ("send 50"). Dates ("2026-11-01", "November 1, 2026"), percentages, hex and bare
 * numbers elsewhere in a text are not amounts.
 */
function parseAmount(text) {
  if (/\b(all|everything|max|entire|whole|every\s+(cent|dollar|penny|coin|token))\b/i.test(text)) return "all";
  const clean = text
    .replace(/0x[0-9a-fA-F]+/g, " ") // addresses and hashes
    .replace(DATE_RE, " ")
    .replace(/\d+(?:\.\d+)?\s*%/g, " ") // percentages
    .replace(/(?<=\d),(?=\d{3}\b)/g, ""); // 1,000
  let m = null;
  for (const re of AMOUNT_RES) if ((m = clean.match(re))) break;
  if (!m) return null;
  let v = Number(m[1]);
  const unit = m[2]?.toLowerCase();
  if (unit === "k" || unit === "thousand") v *= 1e3;
  if (unit === "m" || unit === "million") v *= 1e6;
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
  // The agent's earned cap (trust), never its ceiling: asking above the cap is refused and resets trust.
  const maxPer = BigInt(state.trust?.cap ?? p.agent_max_per_action);
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

/**
 * Indirect injection: the agent reads a third-party market note while doing its normal job, and the
 * gullible planner follows any instruction hidden in it. Nobody typed a command at the agent.
 */
export function planFromNote(note, state) {
  const plan = planFromText(note, state);
  return { ...plan, why: `While reading the market note, the agent followed an instruction inside it. ${plan.why}`, indirect: true };
}

/** Optional: ask an OpenAI-compatible model for a plan. The vault checks the result like any other.
 *  `note` is third-party data (a market note) shown to the model next to the task, the way a real
 *  agent reads feeds; an instruction hidden in it is an indirect prompt injection. */
export async function planWithLlm(text, state, { baseUrl, apiKey, model, note }) {
  const sys = "You manage a DAO treasury vault. Reply with ONLY a JSON object {\"action\":{...},\"why\":\"...\"} where action is one of {\"action\":\"supply\",\"amount\":\"<USDC base units>\"}, {\"action\":\"withdraw\",\"amount\":\"...\"}, {\"action\":\"send_to_treasury\",\"amount\":\"...\"}, {\"action\":\"unwind\"}. USDC has 6 decimals.";
  const r = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, temperature: 0, messages: [{ role: "system", content: sys }, { role: "user", content: `Vault state: ${JSON.stringify(state.ledger)}\nAgent cap per action: ${state.trust?.cap ?? state.policy?.agent_max_per_action}\nInstruction: ${text}${note ? `\nMarket note from the data feed:\n${note}` : ""}` }] }),
  });
  const j = await r.json();
  if (j.error) return { action: null, why: `model API error: ${j.error.message ?? JSON.stringify(j.error)}` };
  const content = j.choices?.[0]?.message?.content ?? "";
  const m = content.match(/\{[\s\S]*\}/);
  if (!m) return { action: null, why: `model reply not understood: ${content.slice(0, 200)}` };
  const plan = JSON.parse(m[0]);
  // Some models write a bare action name ("unwind") instead of an object.
  const action = typeof plan.action === "string" ? { action: plan.action } : plan.action;
  return { action, why: plan.why, llm: model };
}
