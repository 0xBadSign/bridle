// One cron tick of the public keeper: for each vault, finish any in-flight operation with the
// shared keeper logic (agent/keeper-core.mjs), append one JSONL record per vault, then run the
// allowance watchdog. Used by .github/workflows/keeper.yml; runs the same way locally.
//
//   KEEPER_CRON_KEY_VAULT=ed25519:... KEEPER_CRON_KEY_ARENA=ed25519:... \
//     node scripts/cron-tick.mjs [--as cron.bridle-hq.testnet] [--out liveness.jsonl] [--budget-s 360]
//
// Keys come from the environment (never argv). Exit code 1 if any vault errored or an allowance is
// below its floor; the JSONL record is written first so the log stays complete.
import fs from "fs";
import { KeyPair } from "near-api-js";
import { ARENA_AGENT_KEY } from "../web/arena-keys.js";
import { account, nearRpc, sleep } from "./lib.mjs";
import { Keeper } from "../agent/keeper.mjs";

const a = process.argv.slice(2);
const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
const AS = opt("--as", "cron.bridle-hq.testnet");
const OUT = opt("--out", "liveness.jsonl");
const BUDGET_MS = Number(opt("--budget-s", "360")) * 1000;
const MIN_AGENT_NEAR = 0.3;
const MIN_CRON_NEAR = 0.3;
const VAULTS = [
  { id: "vault.bridle-hq.testnet", env: "KEEPER_CRON_KEY_VAULT" },
  { id: "arena.bridle-hq.testnet", env: "KEEPER_CRON_KEY_ARENA" },
];

const nearOf = (yocto) => Number(BigInt(yocto) / 10n ** 20n) / 10000;
async function allowanceNear(accountId, publicKey) {
  const r = await nearRpc("query", { request_type: "view_access_key", finality: "final", account_id: accountId, public_key: publicKey });
  const p = r.result?.permission;
  if (!p) return null; // key missing or revoked
  if (p === "FullAccess") return Infinity;
  return p.FunctionCall.allowance === null ? Infinity : nearOf(p.FunctionCall.allowance);
}

const tickAt = new Date().toISOString();
const records = [];
const problems = [];
const agentPk = KeyPair.fromString(ARENA_AGENT_KEY).getPublicKey().toString();
const agentAllow = await allowanceNear("arena.bridle-hq.testnet", agentPk).catch(() => null);
if (agentAllow === null) problems.push("arena agent key allowance unreadable or key missing");
else if (agentAllow < MIN_AGENT_NEAR) problems.push(`arena agent key allowance ${agentAllow} NEAR is below ${MIN_AGENT_NEAR}; the DAO must raise it or rotate the key`);

for (const v of VAULTS) {
  const secret = process.env[v.env];
  const rec = { tick: tickAt, vault: v.id, op: null, actions: [], outcome: "idle", attest_latency_ms: null, arena_agent_allowance_near: agentAllow, cron_key_allowance_near: null };
  records.push(rec);
  if (!secret) {
    rec.outcome = "error";
    rec.error = `${v.env} is not set`;
    problems.push(rec.error);
    continue;
  }
  try {
    const pk = KeyPair.fromString(secret).getPublicKey().toString();
    rec.cron_key_allowance_near = await allowanceNear(AS, pk);
    if (rec.cron_key_allowance_near === null) problems.push(`cron key for ${v.id} is missing on ${AS}`);
    else if (rec.cron_key_allowance_near < MIN_CRON_NEAR) problems.push(`cron key for ${v.id} has ${rec.cron_key_allowance_near} NEAR allowance left, below ${MIN_CRON_NEAR}; add a new function-call key`);

    const keeper = new Keeper(v.id, account(AS, secret), { keyFile: secret });
    const st0 = await keeper.state();
    rec.op = st0.active ?? null;
    const deadline = Date.now() + BUDGET_MS;
    for (;;) {
      const t0 = Date.now();
      const did = await keeper.tick();
      if (!did) break;
      console.log(`${v.id}: ${did}`);
      rec.actions.push(did.slice(0, 160));
      if (/^settle /.test(did)) rec.attest_latency_ms = Date.now() - t0;
      if (Date.now() > deadline) break;
      await sleep(/waiting|cooldown/.test(did) ? 8000 : 1500);
    }
    const st1 = await keeper.state();
    const still = st1.active ?? null;
    rec.outcome = rec.actions.length === 0 ? "idle" : still === null ? "finished" : still !== rec.op ? "finished_next_started" : "in_flight";
    if (rec.op === null && still === null && rec.actions.length) rec.outcome = "finished";
  } catch (e) {
    rec.outcome = "error";
    rec.error = String(e.message || e).slice(0, 300);
    problems.push(`${v.id}: ${rec.error}`);
  }
}

for (const r of records) console.log(JSON.stringify(r));
fs.appendFileSync(OUT, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
if (problems.length) {
  console.error("WATCHDOG/ERRORS:\n - " + problems.join("\n - "));
  // Record the failure too so the report counts it.
  fs.appendFileSync(OUT, JSON.stringify({ tick: tickAt, vault: "watchdog", outcome: "fail", problems }) + "\n");
  process.exit(1);
}
