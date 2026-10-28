// Sputnik DAO helper: propose a FunctionCall on the vault and approve it with the council key.
//   node scripts/dao.mjs <dao> <council> <vault> <method> '<json args>' ["description"]
// Returns the proposal id and the vault's response from the execution receipts.
import { account, call, log, view } from "./lib.mjs";

export async function daoCall(dao, council, vault, method, args, description = `${method} via Bridle`, gasT = 200) {
  const c = account(council);
  const policy = await view(dao, "get_policy");
  const bond = BigInt(policy.proposal_bond || "1000000000000000000000000");
  const proposal = {
    proposal: {
      description,
      kind: {
        FunctionCall: {
          receiver_id: vault,
          actions: [{ method_name: method, args: Buffer.from(JSON.stringify(args)).toString("base64"), deposit: "0", gas: (BigInt(gasT) * 10n ** 12n).toString() }],
        },
      },
    },
  };
  const add = await call(c, dao, "add_proposal", proposal, { gasT: 100, deposit: bond });
  const id = add.value;
  const act = await call(c, dao, "act_proposal", { id, action: "VoteApprove", proposal: proposal.proposal.kind }, { gasT: 300 });
  // The vault's own answer is in the logs/events of the execution receipts.
  const rejected = act.events.find((e) => e.event === "rejected");
  return { id, add_tx: add.hash, act_tx: act.hash, events: act.events.map((e) => e.event), rejected: rejected?.data, failures: act.failures };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [dao, council, vault, method, json, desc] = process.argv.slice(2);
  const r = await daoCall(dao, council, vault, method, JSON.parse(json), desc);
  log(JSON.stringify(r));
}
