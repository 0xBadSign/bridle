// Create the Sputnik DAO that owns the vault (testnet factory `sputnik-v2.testnet`).
//   node scripts/create-dao.mjs deploy/testnet.json
// The factory's `create` returns false (and refunds) on failure while the tx still succeeds, so we
// check that the DAO account exists afterwards.
import fs from "fs";
import { account, call, log, nearRpc } from "./lib.mjs";

const cfg = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const name = cfg.dao.split(".")[0];
const init = { config: { name, purpose: "Bridle demo DAO: owns a policy-bound vault on Base", metadata: "" }, policy: cfg.dao_council };
const res = await call(account(cfg.dao_creator), "sputnik-v2.testnet", "create",
  { name, public_key: null, args: Buffer.from(JSON.stringify(init)).toString("base64") },
  { gasT: 150, deposit: 6n * 10n ** 24n });
log("create tx", res.hash, "returned", JSON.stringify(res.value));
const r = await nearRpc("query", { request_type: "view_account", finality: "final", account_id: cfg.dao });
if (!r.result) {
  console.error("DAO not created");
  process.exit(1);
}
log("DAO", cfg.dao, "exists, balance", Number(BigInt(r.result.amount) / 10n ** 21n) / 1000, "NEAR");
