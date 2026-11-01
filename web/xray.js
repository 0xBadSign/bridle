// Proposals X-ray: reads the owner DAO's proposals that call a Bridle vault and explains each one
// before anyone votes, using the vault's own read-only preview views (preview_policy,
// preview_outflow). The proposal description is untrusted text written by whoever proposed it;
// the X-ray is computed from the call's arguments only.
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

/** Explains one FunctionCall action on a vault. Returns { title, lane, wait_ms, html }. */
async function explain(vaultId, method, args) {
  const a = args || {};
  if (method === "propose_policy" && a.policy) {
    const p = await view(vaultId, "preview_policy", { policy: a.policy });
    return { title: "Change the vault policy", lane: p.lane, wait_ms: p.wait_ms, html: policyHtml(p) };
  }
  if (method === "dao_act" && a.action) {
    const act = a.action;
    if (act.action === "send_to_treasury") {
      const p = await view(vaultId, "preview_outflow", { amount: String(act.amount) });
      const notes = [];
      if (!p.enough_idle) notes.push(`The vault has only ${usdc(p.idle)} idle, so the operation would be refused when it runs.`);
      if (p.paused) notes.push("The vault is paused, so it would be refused now.");
      return {
        title: `Send ${usdc(act.amount)} to the treasury`,
        lane: p.lane,
        wait_ms: p.wait_ms,
        html: `<p>The money can only go to the treasury address set in the policy: ${addr(p.treasury)}. ${esc(usdc(p.fast_left))} of this epoch's fast allowance is left${p.lane === "fast" ? ", so this one needs no waiting period" : ", so this one is parked in the long lane"}.</p>${notes.map((n) => `<p class="err">${esc(n)}</p>`).join("")}${vetoHtml(p.vetoable_by)}`,
      };
    }
    const label = { supply: `Supply ${usdc(act.amount)} to Aave`, withdraw: `Withdraw ${usdc(act.amount)} from Aave`, unwind: "Withdraw everything from Aave" }[act.action] || `DAO action ${act.action}`;
    return { title: label, lane: "fast", wait_ms: 0, html: "<p>Funds move only between the vault's own Base address and Aave. Nothing leaves the vault.</p>" };
  }
  const fixed = {
    propose_guardian: ["Add a guardian", "long", `<p>Adds the guardian key <code>${esc(a.public_key)}</code>. A guardian can pause, veto, tighten and unwind, never loosen or send.</p>`],
    remove_guardian: ["Remove a guardian", "fast", `<p>Removes the guardian key <code>${esc(a.public_key)}</code> at once. Fewer guardians means fewer people who can veto parked changes.</p>`],
    set_agent_key: ["Replace the agent key", "fast", `<p>The new key <code>${esc(a.public_key)}</code> gets the agent's rights at once: <code>agent_act</code> only, inside the same mandate. Earned trust goes back to the floor.</p>`],
    propose_upgrade: ["Upgrade the vault contract", "long", `<p>Parks an upgrade to code hash <code>${esc(Array.isArray(a.code_hash) ? JSON.stringify(a.code_hash) : a.code_hash)}</code>. New code can change every rule, so compare the hash with a build of the published source before the wait ends.</p>`],
    dao_reset_trust: ["Reset the agent's earned trust", "fast", "<p>Sends the agent's per-action cap back to the floor. It only restricts.</p>"],
    dao_unpause: ["Lift a guardian pause", "fast", "<p>Ends a pause early.</p>"],
    dao_resolve: ["Resolve a stuck operation by vote", "fast", `<p>Declares the active operation ${a.landed ? "landed" : "not landed"} without an MPC proof. This is the trusted fallback; it never counts toward earned trust.</p>`],
  }[method];
  if (fixed) return { title: fixed[0], lane: fixed[1], wait_ms: null, html: fixed[2] };
  return { title: `Call ${method}`, lane: null, wait_ms: null, html: `<p class="muted">Bridle has no preview for <code>${esc(method)}</code>. The vault refuses methods the DAO is not allowed to call.</p>` };
}

const addr = (x) => `<a class="mono" href="${esc(links.baseAddr(x))}" target="_blank" rel="noopener">${esc(x)}</a>`;
const vetoHtml = (keys) => (keys && keys.length ? `<p class="small muted">Can be vetoed while it waits by ${keys.length} guardian key${keys.length > 1 ? "s" : ""}.</p>` : "");

function policyHtml(p) {
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
${vetoHtml(p.vetoable_by)}`;
}

function laneHtml(x) {
  if (!x.lane) return "";
  const wait = x.wait_ms ? ` Waiting period: ${dur(x.wait_ms)}.` : "";
  return `<p class="small">${pill(x.lane + " lane", LANE_CLS[x.lane])} ${esc(LANE_TEXT[x.lane])}${esc(wait)}</p>`;
}

async function proposalCard(p, nowMs) {
  const fc = p.kind.FunctionCall;
  const v = vaultOf(fc.receiver_id)[1];
  const expires = Number(BigInt(p.submission_time) / 1_000_000n) + p.period_ms;
  const parts = [];
  for (const act of fc.actions) {
    const args = decodeArgs(act.args);
    let x;
    try {
      x = await explain(fc.receiver_id, act.method_name, args);
    } catch (e) {
      x = { title: `Call ${act.method_name}`, lane: null, html: `<p class="err">Preview failed: ${esc(String(e.message || e).slice(0, 200))}</p>` };
    }
    parts.push(`<h3 style="margin:10px 0 4px">${esc(x.title)}</h3>${laneHtml(x)}${x.html}
<details><summary class="small">Raw call: <code>${esc(act.method_name)}</code></summary><pre class="log">${esc(JSON.stringify(args, null, 1))}</pre></details>`);
  }
  const votes = Object.entries(p.votes || {}).map(([who, how]) => `${esc(who)}: ${esc(how)}`).join(", ") || "no votes yet";
  return `<div class="card" style="margin-bottom:12px">
<div class="row"><b>Proposal #${esc(p.id)}</b> ${pill(p.status === "InProgress" ? "open" : p.status, p.status === "InProgress" ? "warn" : "")} ${pill(v.label)}</div>
<p class="small muted" style="margin:6px 0">Proposer <code>${esc(p.proposer)}</code>, ${esc(ago(Number(BigInt(p.submission_time) / 1_000_000n), nowMs))}. ${p.status === "InProgress" ? `Voting closes ${esc(when(expires))}.` : ""} Votes: ${votes}.</p>
<p class="small" style="margin:6px 0">What the proposer says: <q>${esc(p.description.slice(0, 300))}</q></p>
<p class="small muted" style="margin:0">What it does, read from the arguments by the vault (<code>${esc(fc.receiver_id)}</code>):</p>
${parts.join("")}
<p class="small">Filed with <a href="${esc(links.nearAcct(p.dao))}" target="_blank" rel="noopener">${esc(p.dao)}</a>, the vault's owner DAO.</p>
</div>`;
}

/** Proposals from each vault's owner DAO (read from the vault, not configured) that call that vault. */
async function daoProposals() {
  const owners = {};
  for (const v of Object.values(VAULTS)) {
    const dao = (await view(v.id, "get_state")).owner;
    (owners[dao] ||= []).push(v.id);
  }
  const all = [];
  for (const [dao, vaultIds] of Object.entries(owners)) {
    const period_ms = Number(BigInt((await view(dao, "get_policy")).proposal_period) / 1_000_000n);
    const last = await view(dao, "get_last_proposal_id");
    const ps = await view(dao, "get_proposals", { from_index: Math.max(0, last - RECENT), limit: RECENT });
    for (const p of ps) if (p.kind.FunctionCall && vaultIds.includes(p.kind.FunctionCall.receiver_id)) all.push({ ...p, dao, period_ms });
  }
  return { daos: Object.keys(owners), list: all.sort((x, y) => (BigInt(y.submission_time) > BigInt(x.submission_time) ? 1 : -1)) };
}

async function loadList(el) {
  const nowMs = Date.now();
  const { daos, list: mine } = await daoProposals();
  const open = mine.filter((p) => p.status === "InProgress" && Number(BigInt(p.submission_time) / 1_000_000n) + p.period_ms > nowMs);
  const done = mine.filter((p) => !open.includes(p));
  const cards = await Promise.all(open.map((p) => proposalCard(p, nowMs)));
  el.innerHTML = `<h2>Open proposals (${open.length})</h2>
${cards.join("") || `<p class="muted">No open proposal calls a Bridle vault right now. Try a change below.</p>`}
<h2>Recent decided proposals</h2>
<div class="card tablewrap"><table><thead><tr><th>#</th><th>Status</th><th>Vault</th><th>Call</th><th>Description</th></tr></thead><tbody>
${done.slice(0, 12).map((p) => {
    const fc = p.kind.FunctionCall;
    return `<tr><td>${esc(p.id)}</td><td>${pill(p.status === "InProgress" ? "expired" : p.status, p.status === "Approved" ? "ok" : "")}</td><td>${esc(vaultOf(fc.receiver_id)[1].label)}</td><td><code>${esc(fc.actions.map((a) => a.method_name).join(", "))}</code></td><td class="small">${esc(p.description.slice(0, 90))}</td></tr>`;
  }).join("")}
</tbody></table></div>
<p class="small muted">Read from ${daos.map((d) => `<code>${esc(d)}</code>`).join(", ")} at ${esc(when(nowMs))}; refreshes every 30 s.</p>`;
}

function tryPanel(el, getVault) {
  el.innerHTML = `<h2>Try a change yourself</h2>
<div class="card">
<p style="margin-top:0">Edit any field of the current policy and preview it. This is a free read-only call to <code>preview_policy</code>; nothing is signed or sent.</p>
<div id="xr-fields" class="kv"></div>
<div class="row" style="margin:10px 0"><button id="xr-go">Preview this policy</button><button id="xr-reset" class="ghost">Reset to current</button><span id="xr-busy" class="small muted"></span></div>
<div id="xr-out"></div>
</div>`;
  const $ = (id) => el.querySelector("#" + id);
  let current = null;
  async function fill() {
    const vid = VAULTS[getVault()].id;
    current = (await view(vid, "get_state")).policy;
    $("xr-fields").innerHTML = Object.entries(current).map(([k, v]) => `<div><label for="xr-${esc(k)}"><code>${esc(k)}</code></label><div class="small">${esc(FIELD_TEXT[k] || "")}</div></div><div><input id="xr-${esc(k)}" data-k="${esc(k)}" value="${esc(v)}" style="width:100%;max-width:420px"><div class="small muted" data-hint="${esc(k)}">${esc(fieldVal(k, v))}</div></div>`).join("");
    $("xr-fields").querySelectorAll("input").forEach((i) => i.addEventListener("input", () => {
      const h = $("xr-fields").querySelector(`[data-hint="${i.dataset.k}"]`);
      try { h.textContent = fieldVal(i.dataset.k, i.value.trim()); } catch { h.textContent = ""; }
    }));
    $("xr-out").innerHTML = "";
  }
  $("xr-reset").addEventListener("click", () => fill().catch((e) => ($("xr-out").innerHTML = `<p class="err">${esc(e.message)}</p>`)));
  $("xr-go").addEventListener("click", async () => {
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
      const p = await view(VAULTS[getVault()].id, "preview_policy", { policy });
      $("xr-out").innerHTML = laneHtml({ lane: p.invalid ? null : p.lane, wait_ms: p.wait_ms }) + policyHtml(p);
    } catch (e) {
      $("xr-out").innerHTML = `<p class="err">${esc(String(e.message || e).slice(0, 300))}</p>`;
    }
    $("xr-busy").textContent = "";
  });
  return fill;
}

/** Mounts the page. Returns an unmount function. */
export function mountXray(el, getVault) {
  el.innerHTML = `<h1>Proposals X-ray</h1>
<p>Anyone can file a proposal with the owner DAO, and its description is whatever the proposer typed. Before you vote, this page reads what each proposal would actually do to a Bridle vault from its arguments, using the vault's own read-only previews: which lane it takes, how long guardians have to veto it, which limits it loosens, and how much more could be at risk.</p>
<div id="xr-list"><p class="muted">Reading proposals from the owner DAO...</p></div>
<div id="xr-try"></div>`;
  const list = el.querySelector("#xr-list");
  const refresh = () => loadList(list).catch((e) => (list.innerHTML = `<p class="err">Could not read the DAO: ${esc(String(e.message || e).slice(0, 200))}. Retrying.</p>`));
  refresh();
  const fill = tryPanel(el.querySelector("#xr-try"), getVault);
  fill().catch((e) => (el.querySelector("#xr-out").innerHTML = `<p class="err">${esc(e.message)}</p>`));
  const t = setInterval(() => !document.hidden && refresh(), REFRESH_MS);
  return { unmount: () => clearInterval(t), vaultChanged: () => fill().catch(() => {}) };
}

