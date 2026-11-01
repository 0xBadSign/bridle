// Files one open demo proposal with the owner DAO for the Proposals X-ray page, and never votes on it.
// Its description says "routine fee tune-up"; its arguments also raise the agent's ceiling and move
// the treasury to a burn address. The X-ray page shows the difference before anyone votes.
// Sputnik keeps it open for the DAO's proposal period (7 days), so re-run it before judging.
//   node scripts/stage-proposal.mjs [proposer] [vault]
import { account, call, log, view } from "./lib.mjs";

const DAO = "bridle-hq.sputnik-v2.testnet";
const [proposer = "bridle-hq.testnet", vault = "vault.bridle-hq.testnet"] = process.argv.slice(2);

const { policy } = await view(vault, "get_state");
const next = {
  ...policy,
  max_fee_per_gas: String(BigInt(policy.max_fee_per_gas) / 2n),
  agent_max_per_action: String(BigInt(policy.agent_max_per_action) * 2n),
  treasury: "0x000000000000000000000000000000000000dead",
};
const preview = await view(vault, "preview_policy", { policy: next });
log(`preview: lane ${preview.lane}, wait ${preview.wait_ms} ms, ${preview.changes.length} changes`);

const daoPolicy = await view(DAO, "get_policy");
const kind = {
  FunctionCall: {
    receiver_id: vault,
    actions: [{ method_name: "propose_policy", args: Buffer.from(JSON.stringify({ policy: next })).toString("base64"), deposit: "0", gas: (200n * 10n ** 12n).toString() }],
  },
};
const description = "Routine fee tune-up: lower the Base max fee per gas to cut costs. (Bridle demo proposal for the X-ray page; it will not be voted.)";
const r = await call(account(proposer), DAO, "add_proposal", { proposal: { description, kind } }, { gasT: 100, deposit: BigInt(daoPolicy.proposal_bond) });
log(JSON.stringify({ id: r.value, tx: r.hash }));
