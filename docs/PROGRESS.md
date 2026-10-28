# Progress

## Where we are
M0 scaffold in progress (2026-10-28).

## Owner actions
- O-1 (before submission): mainnet NEAR account for the prize payout.
- O-2 (end): record the video, publish the X post, confirm the submission payload.
- O-3 (end): create the public GitHub repo, or confirm it can be made public.

## Decisions
- D-001 (2026-10-28): full scope of 18-security-design.md; the owner rejected the scope cut.
- D-002: agent and guardian roles are function-call keys on the vault account, identified by `env::signer_account_pk()`. The DAO acts by predecessor.
- D-003: the injection box signs in the browser with a published arena key on a separate arena vault. No hosted server, zero cost.
- D-004: the default agent planner is a deliberately gullible rule-based parser, labelled as such. An LLM is optional via an OpenAI-compatible env var. No paid API.
- D-005: keeper hints (block hash, block number, tx index, log index, credit sender and amount) enter the expected payload hash. A wrong hint can only cause a missing attestation.

## Session log
- 2026-10-28: repo created; plan written from near-research 11-19.
