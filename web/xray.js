// Proposals X-ray: reads the owner DAO's proposals that call a Bridle vault and explains each one
// before anyone votes, using the vault's own read-only preview views (preview_policy,
// preview_outflow). The proposal description is untrusted text written by whoever proposed it;
// the X-ray is computed from the call's arguments only. Owner-DAO governance proposals are listed too.
import { links, VAULTS, view } from "./lib/chain.js";
import { ago, dur, esc, usdc, when } from "./lib/fmt.js";
import { EX_LABEL, exFmt } from "./pages.js";

const RECENT = 30;
const REFRESH_MS = 30000;

const pill = (t, c = "") => `<span class="pill ${c}">${esc(t)}</span>`;
const LANE_CLS = { fast: "warn", short: "info", long: "info" };
const LANE_TEXT = {
  fast: "Takes effect as soon as the vote passes. No guardian can stop it.",
  short: "Parked in the short lane after the vote. Guardians can veto it during the wait.",
  long: "Parked in the long lane after the vote. Guardians can veto it during the wait.",
};

// Units for policy fields, so the diff reads as amounts and durations instead of raw integers.
const USDC_FIELDS = new Set(["supply_cap", "agent_max_per_action", "fast_outflow_per_epoch", "trust_floor_per_action", "trust_step_per_action"]);
const GWEI_FIELDS = new Set(["max_fee_per_gas", "max_priority_fee_per_gas"]);
function fieldVal(field, v) {
  if (USDC_FIELDS.has(field)) return usdc(v);
  if (GWEI_FIELDS.has(field)) return `${(Number(v) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 4 })} gwei`;
  if (field.endsWith("_ms")) return dur(Number(v));
  return String(v);
}
const FIELD_TEXT = {
  supply_cap: "most USDC the vault may hold in Aave",
  agent_max_per_action: "ceiling of the agent's per-action cap",
  agent_quota_per_epoch: "agent actions per epoch",
  agent_min_interval_ms: "minimum gap between agent actions",
  fast_outflow_per_epoch: "treasury outflow per epoch that needs no waiting period",
  max_fee_per_gas: "Base max fee per gas",
  max_priority_fee_per_gas: "Base priority fee per gas",
  short_window_ms: "short-lane waiting period",
  long_window_ms: "long-lane waiting period",
  settle_deadline_ms: "time allowed to prove a transaction landed",
  epoch_ms: "epoch length",
  max_pause_ms: "longest guardian pause",
  max_vetoes_per_epoch: "guardian vetoes per epoch",
  treasury: "the only address funds can be sent to",
  trust_floor_per_action: "agent's starting per-action cap",
  trust_step_per_action: "cap increase per earned-trust step",
  trust_landings_per_step: "proved landings needed per step",
  trust_epochs_per_step: "epochs between steps",
};

const vaultOf = (id) => Object.entries(VAULTS).find(([, v]) => v.id === id);

function decodeArgs(b64) {
  try {
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

const isAmount = (v) => typeof v === "string" && /^\d+$/.test(v);
const refused = (title, why) => ({ title, lane: null, wait_ms: null, html: `<p class="err">The vault would refuse these arguments: ${why}. This proposal would fail if executed.</p>` });

/**
 * Explains one FunctionCall action on a vault. Returns { title, lane, wait_ms, html }.
 * ctx: { removed: Set of guardian keys removed by earlier actions of the same proposal,
 *        unpausedEarlier: an earlier action of the same proposal lifts a pause,
 *        pendingOut: total treasury outflow asked for by all open proposals on this vault }.
 */
async function explain(vaultId, method, args, ctx = {}) {
  const a = args && typeof args === "object" ? args : {};
  const veto = (keys) => vetoHtml((keys || []).filter((k) => !ctx.removed?.has(k)), (keys || []).length);
  if (method === "propose_policy") {
    if (!a.policy || typeof a.policy !== "object") return refused("Change the vault policy", "there is no <code>policy</code> object");
    const p = await view(vaultId, "preview_policy", { policy: a.policy });
    return { title: "Change the vault policy", lane: p.invalid ? null : p.lane, wait_ms: p.invalid ? null : p.wait_ms, html: policyHtml(p, veto) };
  }
  if (method === "dao_act") {
    const act = a.action;
    if (!act || typeof act !== "object") return refused("DAO action", "there is no <code>action</code> object");
    if (act.action !== "unwind" && !isAmount(act.amount)) return refused(`DAO action ${act.action}`, `<code>amount</code> must be a decimal string, got <code>${esc(JSON.stringify(act.amount))}</code>`);
    if (act.action === "send_to_treasury") {
      const p = await view(vaultId, "preview_outflow", { amount: act.amount });
      const notes = [];
      if (!p.enough_idle) notes.push(["err", `The vault has only ${usdc(p.idle)} idle, so the operation would be refused when it runs.`]);
      if (p.paused) notes.push(ctx.unpausedEarlier ? ["muted", "The vault is paused now; an earlier action in this same proposal lifts the pause, so this send runs right after it."] : ["err", "The vault is paused now. If the pause ends or is lifted before this proposal runs, the send goes through."]);
      if (p.lane === "fast" && ctx.pendingOut > BigInt(p.fast_left)) notes.push(["err", `Open proposals together ask for ${usdc(ctx.pendingOut)} against ${usdc(p.fast_left)} of fast allowance left, so whichever runs later may be parked in the long lane instead.`]);
      return {
        title: `Send ${usdc(act.amount)} to the treasury`,
        lane: p.lane,
        wait_ms: p.wait_ms,
        html: `<p>The money can only go to the treasury address set in the policy: ${addr(p.treasury)}. ${esc(usdc(p.fast_left))} of this epoch's fast allowance is left${p.lane === "fast" ? ", so this one needs no waiting period" : ", so this one is parked in the long lane"}.</p>${notes.map(([c, n]) => `<p class="${c}">${esc(n)}</p>`).join("")}${p.lane === "fast" ? "" : veto(p.vetoable_by)}`,
      };
    }
    const label = { supply: `Supply ${usdc(act.amount)} to Aave`, withdraw: `Withdraw ${usdc(act.amount)} from Aave`, unwind: "Withdraw everything from Aave" }[act.action];
    if (!label) return refused("DAO action", `unknown action <code>${esc(JSON.stringify(act.action))}</code>`);
    return { title: label, lane: "fast", wait_ms: 0, html: "<p>Funds move only between the vault's own Base address and Aave. Nothing leaves the vault.</p>" };
  }
  const needsKey = ["propose_guardian", "remove_guardian", "set_agent_key"];
  if (needsKey.includes(method) && typeof a.public_key !== "string") return refused(`Call ${method}`, "<code>public_key</code> must be a string");
  if (method === "propose_upgrade" && typeof a.code_hash !== "string") return refused("Upgrade the vault contract", "<code>code_hash</code> must be a 0x hex string");
  if (method === "dao_resolve" && typeof a.landed !== "boolean") return refused("Resolve a stuck operation by vote", "<code>landed</code> must be true or false");
  const fixed = {
    propose_guardian: ["Add a guardian", "long", `<p>Adds the guardian key <code>${esc(a.public_key)}</code>. A guardian can pause, veto, tighten and unwind, never loosen or send.</p>`],
    remove_guardian: ["Remove a guardian", "fast", `<p>Removes the guardian key <code>${esc(a.public_key)}</code> at once. Fewer guardians means fewer people who can veto parked changes.</p>`],
    set_agent_key: ["Replace the agent key", "fast", `<p>The new key <code>${esc(a.public_key)}</code> gets the agent's rights at once: <code>agent_act</code> only, inside the same mandate. Earned trust goes back to the floor.</p>`],
    propose_upgrade: ["Upgrade the vault contract", "long", `<p>Parks an upgrade to code hash <code>${esc(a.code_hash)}</code>. New code can change every rule, so compare the hash with a build of the published source before the wait ends.</p>`],
    dao_reset_trust: ["Reset the agent's earned trust", "fast", "<p>Sends the agent's per-action cap back to the floor. It only restricts.</p>"],
    dao_unpause: ["Lift a guardian pause", "fast", "<p>Ends a pause early.</p>"],
    dao_resolve: ["Resolve a stuck operation by vote", "fast", `<p>Declares the active operation ${a.landed ? "landed" : "not landed"} without an MPC proof. This is the trusted fallback; it never counts toward earned trust.</p>`],
  }[method];
  if (fixed) return { title: fixed[0], lane: fixed[1], wait_ms: null, html: fixed[2] };
  return { title: `Call ${method}`, lane: null, wait_ms: null, html: `<p class="err">The vault has no DAO method <code>${esc(method)}</code>; this call would fail.</p>` };
}

const addr = (x) => `<a class="mono" href="${esc(links.baseAddr(x))}" target="_blank" rel="noopener">${esc(x)}</a>`;
function vetoHtml(keys, before = keys.length) {
  if (before && !keys.length) return `<p class="err">No guardian could veto this: earlier actions in this same proposal remove every guardian.</p>`;
  if (!keys.length) return "";
  const lost = before > keys.length ? ` (${before - keys.length} removed by an earlier action in this proposal)` : "";
  return `<p class="small muted">Can be vetoed while it waits by ${keys.length} guardian key${keys.length > 1 ? "s" : ""}${lost}.</p>`;
}

function policyHtml(p, veto = (k) => vetoHtml(k || [])) {
  if (p.invalid) return `<p class="err">The vault would refuse this policy outright: <code>${esc(p.invalid)}</code>.</p>`;
  const rows = p.changes.map((c) => {
    const from = c.field === "treasury" ? addr(c.from) : esc(fieldVal(c.field, c.from));
    const to = c.field === "treasury" ? addr(c.to) : esc(fieldVal(c.field, c.to));
    return `<tr><td><code>${esc(c.field)}</code><div class="small muted">${esc(FIELD_TEXT[c.field] || "")}</div></td><td>${from}</td><td>${to}</td><td>${c.loosens ? pill("loosens", "bad") : pill("tightens", "ok")} ${pill(c.lane)}</td></tr>`;
  }).join("");
  const ex = Object.keys(EX_LABEL).map((k) => {
    const b = p.exposure_before[k], af = p.exposure_after[k];
    return `<tr><td>${esc(EX_LABEL[k])}</td><td>${esc(exFmt(k, b))}</td><td>${b === af ? "same" : "<b>" + esc(exFmt(k, af)) + "</b>"}</td></tr>`;
  }).join("");
  const cap = p.agent_cap_before === p.agent_cap_after ? "" : `<p>The agent's per-action cap goes from <b>${esc(usdc(p.agent_cap_before))}</b> to <b>${esc(usdc(p.agent_cap_after))}</b>.</p>`;
  const treasury = p.changes.find((c) => c.field === "treasury");
  const warn = treasury ? `<p class="err"><b>This changes where money can be sent.</b> After it, every treasury outflow goes to ${addr(treasury.to)}.</p>` : "";
  return `${warn}${cap}
<div class="tablewrap"><table><thead><tr><th>Field</th><th>Now</th><th>Proposed</th><th>Effect</th></tr></thead><tbody>${rows || `<tr><td colspan="4" class="muted">No field changes.</td></tr>`}</tbody></table></div>
<div class="tablewrap"><table><thead><tr><th>Most that can be at risk</th><th>Now</th><th>If passed</th></tr></thead><tbody>${ex}</tbody></table></div>
${p.lane === "fast" ? "" : veto(p.vetoable_by)}`;
}

function laneHtml(x) {
  if (!x.lane) return "";
  const wait = x.wait_ms ? ` Waiting period: ${dur(x.wait_ms)}.` : "";
  return `<p class="small">${pill(x.lane + " lane", LANE_CLS[x.lane])} ${esc(LANE_TEXT[x.lane])}${esc(wait)}</p>`;
}

const msOf = (p) => Number(BigInt(p.submission_time) / 1_000_000n);
const kindName = (k) => (typeof k === "string" ? k : Object.keys(k)[0]);
// Owner-DAO proposals that never call a vault but can change who controls every vault the DAO owns.
const GOVERNANCE = new Set(["ChangePolicy", "ChangePolicyAddOrUpdateRole", "ChangePolicyRemoveRole", "ChangePolicyUpdateDefaultVotePolicy", "ChangePolicyUpdateParameters", "AddMemberToRole", "RemoveMemberFromRole", "UpgradeSelf", "UpgradeRemote"]);

async function proposalCard(p, nowMs, pendingOut) {
  const fc = p.kind.FunctionCall;
  const head = (label) => `<div class="row"><b>Proposal #${esc(p.id)}</b> ${pill("open", "warn")} ${pill(label)}</div>
<p class="small muted" style="margin:6px 0">Proposer <code>${esc(p.proposer)}</code>, ${esc(ago(msOf(p), nowMs))}. Voting closes ${esc(when(msOf(p) + p.period_ms))}. Votes: ${Object.entries(p.votes || {}).map(([who, how]) => `${esc(who)}: ${esc(how)}`).join(", ") || "no votes yet"}.</p>
<p class="small" style="margin:6px 0">What the proposer says: <q>${esc(String(p.description).slice(0, 300))}</q></p>`;
  const foot = `<p class="small">Filed with <a href="${esc(links.nearAcct(p.dao))}" target="_blank" rel="noopener">${esc(p.dao)}</a>, the vault's owner DAO.</p>`;
  if (!fc) {
    return `<div class="card" style="margin-bottom:12px">${head("owner DAO governance")}
<p class="err"><b>${esc(kindName(p.kind))}</b> changes the owner DAO itself. The vault cannot preview it, but it can change who controls every vault this DAO owns: whoever controls the DAO can vote any rule change, subject to the vault's waiting periods and guardian vetoes.</p>
<details data-key="${esc(p.dao + ":" + p.id)}"><summary class="small">Raw proposal kind</summary><pre class="log">${esc(JSON.stringify(p.kind, null, 1))}</pre></details>${foot}</div>`;
  }
  const v = vaultOf(fc.receiver_id)[1];
  const ctx = { removed: new Set(), unpausedEarlier: false, pendingOut: pendingOut[fc.receiver_id] || 0n };
  const parts = [];
  for (const [i, act] of fc.actions.entries()) {
    const args = decodeArgs(act.args);
    let x;
    try {
      x = args === null ? refused(`Call ${act.method_name}`, "the arguments are not valid JSON") : await explain(fc.receiver_id, act.method_name, args, ctx);
    } catch (e) {
      x = refused(`Call ${act.method_name}`, `the vault could not read them (${esc(String(e.message || e).slice(0, 200))})`);
    }
    if (act.method_name === "remove_guardian" && typeof args?.public_key === "string") ctx.removed.add(args.public_key);
    if (act.method_name === "dao_unpause") ctx.unpausedEarlier = true;
    parts.push(`<h3 style="margin:10px 0 4px">${fc.actions.length > 1 ? `${i + 1}. ` : ""}${esc(x.title)}</h3>${laneHtml(x)}${x.html}
<details data-key="${esc(p.dao + ":" + p.id + ":" + i)}"><summary class="small">Raw call: <code>${esc(act.method_name)}</code></summary><pre class="log">${esc(JSON.stringify(args, null, 1))}</pre></details>`);
  }
  const multi = fc.actions.length > 1 ? `<p class="small muted">This proposal runs ${fc.actions.length} calls in order; each is previewed against the vault as it is now, with the guardian and pause changes of earlier calls taken into account.</p>` : "";
  return `<div class="card" style="margin-bottom:12px">${head(v.label)}
<p class="small muted" style="margin:0">What it does, read from the arguments by the vault (<code>${esc(fc.receiver_id)}</code>):</p>${multi}
${parts.join("")}${foot}</div>`;
}

/**
 * Proposals from each vault's owner DAO (read from the vault, not configured). Pages backwards until
 * a whole voting period is covered, so no open proposal can be pushed out of view by newer ones.
 */
async function daoProposals(nowMs) {
  const owners = {};
  for (const v of Object.values(VAULTS)) {
    const dao = (await view(v.id, "get_state")).owner;
    (owners[dao] ||= []).push(v.id);
  }
  const open = [], done = [];
  let scanned = 0;
  for (const [dao, vaultIds] of Object.entries(owners)) {
    const period_ms = Number(BigInt((await view(dao, "get_policy")).proposal_period) / 1_000_000n);
    let from = await view(dao, "get_last_proposal_id");
    while (from > 0) {
      const lim = Math.min(50, from);
      from -= lim;
      const ps = await view(dao, "get_proposals", { from_index: from, limit: lim });
      scanned += ps.length;
      for (const p of ps) {
        const q = { ...p, dao, period_ms };
        const fc = p.kind.FunctionCall;
        const onVault = fc && vaultIds.includes(fc.receiver_id);
        const live = p.status === "InProgress" && msOf(p) + period_ms > nowMs;
        if (live && (onVault || GOVERNANCE.has(kindName(p.kind)))) open.push(q);
        else if (onVault) done.push(q);
      }
      if (ps.length && msOf(ps[0]) + period_ms < nowMs && done.length >= RECENT) break;
    }
  }
  const newest = (x, y) => (BigInt(y.submission_time) > BigInt(x.submission_time) ? 1 : -1);
  return { daos: Object.keys(owners), open: open.sort(newest), done: done.sort(newest), scanned };
}

async function loadList(el) {
  const nowMs = Date.now();
  const { daos, open, done, scanned } = await daoProposals(nowMs);
  // Treasury outflow asked for by all open proposals, per vault: they share one fast allowance.
  const pendingOut = {};
  for (const p of open) {
    const fc = p.kind.FunctionCall;
    if (!fc) continue;
    for (const act of fc.actions) {
      const x = act.method_name === "dao_act" ? decodeArgs(act.args)?.action : null;
      if (x && x.action === "send_to_treasury" && isAmount(x.amount)) pendingOut[fc.receiver_id] = (pendingOut[fc.receiver_id] || 0n) + BigInt(x.amount);
    }
  }
  const cards = await Promise.all(open.map((p) => proposalCard(p, nowMs, pendingOut)));
  el.innerHTML = `<h2>Open proposals (${open.length})</h2>
${cards.join("") || `<p class="muted">No open proposal calls a Bridle vault or changes the owner DAO right now. Try a change below.</p>`}
<h2>Recent decided proposals</h2>
<div class="card tablewrap"><table><thead><tr><th>#</th><th>Status</th><th>Vault</th><th>Call</th><th>Description</th></tr></thead><tbody>
${done.slice(0, 12).map((p) => {
    const fc = p.kind.FunctionCall;
    return `<tr><td>${esc(p.id)}</td><td>${pill(p.status === "InProgress" ? "expired" : p.status, p.status === "Approved" ? "ok" : "")}</td><td>${esc(vaultOf(fc.receiver_id)[1].label)}</td><td><code>${esc(fc.actions.map((a) => a.method_name).join(", "))}</code></td><td class="small">${esc(String(p.description).slice(0, 90))}</td></tr>`;
  }).join("")}
</tbody></table></div>
<p class="small muted">Read ${scanned} proposals from ${daos.map((d) => `<code>${esc(d)}</code>`).join(", ")} at ${esc(when(nowMs))}, covering at least one full voting period; refreshes every 30 s.</p>`;
}

function tryPanel(el, getVault) {
  el.innerHTML = `<h2>Try a change yourself</h2>
<div class="card">
<p style="margin-top:0">Edit any field of the current policy of <code id="xr-vault"></code> and preview it. This is a free read-only call to <code>preview_policy</code>; nothing is signed or sent.</p>
<div id="xr-fields" class="kv"></div>
<div class="row" style="margin:10px 0"><button id="xr-go">Preview this policy</button><button id="xr-reset" class="ghost">Reset to current</button><span id="xr-busy" class="small muted"></span></div>
<div id="xr-out"></div>
</div>`;
  const $ = (id) => el.querySelector("#" + id);
  let current = null, loadedVault = null, seq = 0;
  async function fill() {
    const my = ++seq;
    const key = getVault();
    current = null;
    loadedVault = null;
    $("xr-vault").textContent = VAULTS[key].id;
    $("xr-fields").innerHTML = `<p class="muted">Loading the policy...</p>`;
    $("xr-out").innerHTML = "";
    let pol;
    try {
      pol = (await view(VAULTS[key].id, "get_state")).policy;
    } catch (e) {
      if (my === seq) $("xr-fields").innerHTML = `<p class="err">Could not read the policy: ${esc(String(e.message || e).slice(0, 200))}. Press Reset to retry.</p>`;
      return;
    }
    if (my !== seq) return;
    current = pol;
    loadedVault = key;
    $("xr-fields").innerHTML = Object.entries(current).map(([k, v]) => `<div><label for="xr-${esc(k)}"><code>${esc(k)}</code></label><div class="small">${esc(FIELD_TEXT[k] || "")}</div></div><div><input id="xr-${esc(k)}" data-k="${esc(k)}" value="${esc(v)}" style="width:100%;max-width:420px"><div class="small muted" data-hint="${esc(k)}">${esc(fieldVal(k, v))}</div></div>`).join("");
    $("xr-fields").querySelectorAll("input").forEach((i) => i.addEventListener("input", () => {
      const h = $("xr-fields").querySelector(`[data-hint="${i.dataset.k}"]`);
      try { h.textContent = fieldVal(i.dataset.k, i.value.trim()); } catch { h.textContent = ""; }
    }));
  }
  $("xr-reset").addEventListener("click", () => fill());
  $("xr-go").addEventListener("click", async () => {
    if (!current || loadedVault !== getVault()) { $("xr-out").innerHTML = `<p class="err">The policy for this vault is not loaded yet. Press Reset to load it.</p>`; return; }
    const vaultId = VAULTS[loadedVault].id;
    const policy = {};
    for (const [k, v] of Object.entries(current)) {
      const raw = $("xr-fields").querySelector(`[data-k="${k}"]`).value.trim();
      if (typeof v === "number") {
        if (!/^\d+$/.test(raw)) { $("xr-out").innerHTML = `<p class="err"><code>${esc(k)}</code> must be a whole number.</p>`; return; }
        policy[k] = Number(raw);
      } else {
        if (k !== "treasury" && !/^\d+$/.test(raw)) { $("xr-out").innerHTML = `<p class="err"><code>${esc(k)}</code> must be a whole number in base units.</p>`; return; }
        if (k === "treasury" && !/^0x[0-9a-fA-F]{40}$/.test(raw)) { $("xr-out").innerHTML = `<p class="err"><code>treasury</code> must be a 0x address.</p>`; return; }
        policy[k] = k === "treasury" ? raw.toLowerCase() : raw;
      }
    }
    $("xr-busy").textContent = "asking the vault...";
    try {
      const p = await view(vaultId, "preview_policy", { policy });
      $("xr-out").innerHTML = laneHtml({ lane: p.invalid ? null : p.lane, wait_ms: p.wait_ms }) + policyHtml(p);
    } catch (e) {
      $("xr-out").innerHTML = `<p class="err">${esc(String(e.message || e).slice(0, 300))}</p>`;
    }
    $("xr-busy").textContent = "";
  });
  return fill;
}

/** Mounts the page. Returns { unmount, vaultChanged }. */
export function mountXray(el, getVault) {
  el.innerHTML = `<h1>Proposals X-ray</h1>
<p>Anyone can file a proposal with the owner DAO, and its description is whatever the proposer typed. Before you vote, this page reads what each open proposal that calls a Bridle vault would actually do, from its arguments, using the vault's own read-only previews: which lane it takes, how long guardians have to veto it, which limits it loosens, and how much more could be at risk. Open proposals that change the owner DAO itself are listed too.</p>
<div id="xr-list"><p class="muted">Reading proposals from the owner DAO...</p></div>
<div id="xr-try"></div>`;
  const list = el.querySelector("#xr-list");
  let busy = false, dead = false;
  const refresh = async () => {
    if (busy || dead) return;
    busy = true;
    const tmp = document.createElement("div");
    try {
      await loadList(tmp);
    } catch (e) {
      // Keep the last good list on a transient error; show the error only if there is nothing yet.
      tmp.innerHTML = list.querySelector("h2") ? list.innerHTML : `<p class="err">Could not read the DAO: ${esc(String(e.message || e).slice(0, 200))}. Retrying.</p>`;
    } finally {
      busy = false;
    }
    if (dead) return;
    const openKeys = new Set([...list.querySelectorAll("details[open]")].map((d) => d.dataset.key));
    list.innerHTML = tmp.innerHTML;
    list.querySelectorAll("details").forEach((d) => { if (openKeys.has(d.dataset.key)) d.open = true; });
  };
  refresh();
  const fill = tryPanel(el.querySelector("#xr-try"), getVault);
  fill();
  const t = setInterval(() => !document.hidden && refresh(), REFRESH_MS);
  return { unmount: () => { dead = true; clearInterval(t); }, vaultChanged: () => fill() };
}
