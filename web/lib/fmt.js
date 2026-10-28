// Formatting helpers. Everything user-visible goes through esc() before it reaches innerHTML.
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function usdc(v) {
  const n = BigInt(v ?? 0);
  const whole = n / 1_000_000n;
  const frac = (n % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole.toLocaleString("en-US")}${frac ? "." + frac : ""} USDC`;
}

export function ago(ms, now = Date.now()) {
  if (!ms) return "never";
  const d = Math.round((now - ms) / 1000);
  if (d < -1) return "in " + dur(-d * 1000);
  if (d < 5) return "just now";
  return dur(d * 1000) + " ago";
}

export function dur(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min${s % 60 >= 30 && s < 600 ? ` ${s % 60} s` : ""}`;
  if (s < 86400) return `${(s / 3600).toFixed(s % 3600 ? 1 : 0)} h`;
  return `${(s / 86400).toFixed(s % 86400 ? 1 : 0)} days`;
}

export const when = (ms) => (ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 19) + " UTC" : "n/a");
export const short = (h, a = 8, b = 6) => (h && h.length > a + b + 3 ? `${h.slice(0, a)}...${h.slice(-b)}` : h || "");

export function gwei(wei) {
  const n = Number(BigInt(wei)) / 1e9;
  return `${n.toLocaleString("en-US", { maximumFractionDigits: 4 })} gwei`;
}
export function eth(wei) {
  const n = Number(BigInt(wei)) / 1e18;
  return `${n.toLocaleString("en-US", { maximumFractionDigits: 6 })} ETH`;
}

export const REASONS = {
  not_allowed: "Not allowed: this caller may not do that",
  paused: "The vault is paused",
  busy: "Another operation is already running",
  zero_amount: "Amount is zero",
  above_agent_max: "Above the agent's per-action limit",
  quota_exhausted: "Agent's action quota for this epoch is used up",
  too_soon: "Too soon after the previous agent action",
  cap_exceeded: "Would exceed the cap on funds in Aave",
  insufficient_idle: "Not enough idle USDC",
  insufficient_principal: "Not enough USDC in Aave",
  no_such_op: "No such operation",
  no_such_parked: "No such parked item",
  wrong_state: "Not possible in the current state",
  cooldown: "Cooling down after a failed verification",
  unknown_tx: "Unknown transaction",
  not_yet_unlocked: "Parked item has not unlocked yet",
  parked_expired: "Parked item has expired",
  veto_limit: "Guardian used all vetoes for this epoch",
  pause_too_long: "Pause longer than the maximum",
  pause_cooldown: "Pause is on cooldown",
  policy_invalid: "Policy is invalid",
  not_tighter: "A guardian may only tighten the policy",
  too_many_guardians: "Guardian limit reached",
  unknown_guardian: "Unknown guardian",
  too_many_parked: "Too many open parked items",
  already_consumed: "Already used",
  bad_credit_sender: "Deposit sender not accepted",
  code_hash_mismatch: "Code hash does not match",
  before_deadline: "Settle deadline has not passed",
};
export const reasonKey = (r) => (r && typeof r === "object" ? r.reason : String(r));
export const reasonText = (r) => {
  const k = reasonKey(r);
  const d = r && typeof r === "object" && r.detail ? ` (${typeof r.detail === "string" ? r.detail : JSON.stringify(r.detail)})` : "";
  return (REASONS[k] || k) + d;
};

export function callerLabel(c) {
  if (typeof c === "string") return c;
  if (c && c.guardian) return `guardian ${short(c.guardian, 12, 4)}`;
  return JSON.stringify(c);
}

export const actionText = (a) => {
  if (!a) return "nothing";
  const amt = a.amount !== undefined ? " " + usdc(a.amount) : "";
  return { supply: "Supply" + amt + " to Aave", withdraw: "Withdraw" + amt + " from Aave", send_to_treasury: "Send" + amt + " to the treasury", unwind: "Unwind: withdraw everything from Aave" }[a.action] || JSON.stringify(a);
};
