# Outreach drafts (for the owner to send)

Nothing here is sent by the agent. These are short drafts the owner can paste, edit and send from their own accounts. One honest reply in three is enough. A reply goes into the README only with the sender's permission, quoted exactly.

Replace `[dashboard]` and `[repo]` with the public links once the repository is public.

## 1. NEAR MPC team (NEAR Discord `#dev-support` or the Chain Signatures channel, or neardev on Telegram)

> Hi! Solo NEAR HACKATHON entry here (Bridle). My contract calls `verify_foreign_transaction` on `v1.signer-prod.testnet` with an `expected_payload_hash` that it computes itself. It then recovers the attestation in-contract with `ecrecover` against the ForeignTx-domain key, and uses that as the landing proof before an AI agent's next action unlocks. It works well: about 12-15 s after Base `safe`. Golden test vectors reproduce your payload encoding byte for byte.
>
> Two questions:
> 1. Is `verify_foreign_transaction` meant to be used by third-party contracts like this?
> 2. Is there anything about its stability, or the provider quorum, that I should state in my README?
>
> Happy to share the vectors. Demo: [dashboard]. Code: [repo].

## 2. Trezu (NEAR DevHub treasury team)

> Hi! I built a policy module for a Sputnik DAO's Chain Signatures account (NEAR HACKATHON, testnet).
>
> - The DAO votes a mandate once.
> - An AI agent can act only inside it, with limits it earns only from transactions the NEAR MPC network proved landed.
> - Every Base transaction is built by the contract and proved landed by the MPC network before the next step.
> - Anything that loosens the mandate waits in a vetoable queue, with a "what can this vote let someone take" preview before the vote.
>
> Would a treasury like the ones on Trezu want something like this? If yes or no, could I quote you in one sentence in the README, by name or anonymously?
>
> Demo: [dashboard]. Code: [repo].

## 3. One DAO operator (any active Sputnik DAO council member)

> Quick question from a hackathon builder. If your DAO could give an AI agent a standing mandate over funds on another chain (Base), under these rules, would you use it?
>
> - The contract builds every transaction itself.
> - The agent cannot send funds anywhere except Aave and back.
> - Its limits grow only from proven results.
> - A large or rule-loosening vote waits for a guardian veto window.
>
> If not, what would stop you? One sentence is plenty.
>
> Demo: [dashboard].

## 4. X post (required for the submission; the owner posts it)

Draft, with the 45-second cut attached:

> Built at NEAR HACKATHON: Bridle gives an AI agent a DAO's money on Base without giving it any key.
> A NEAR contract builds every Base tx, the NEAR MPC network signs it, and the same network proves it landed before the next one is allowed. The agent's limits grow only from those proofs.
> We told the agent to send everything to an attacker. It agreed. The vault refused, on-chain. Try it: [dashboard] Code: [repo]

Reply under it: "Full walkthrough: [video link]. Everything runs on testnet; the arena vault's agent key is published on purpose."
