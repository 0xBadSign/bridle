// PUBLISHED ON PURPOSE. These keys belong to the ARENA vault (arena.bridle-hq.testnet), a separate
// testnet vault with play-money funds. The agent key can only call agent_act on the arena vault and
// has a 0.5 NEAR gas allowance; the keeper key can only call the public methods settle, advance,
// probe, cancel and credit_deposit on it. Try to make the agent exceed its mandate.
// The production vault's keys are never published.
export const ARENA_VAULT = "arena.bridle-hq.testnet";
export const ARENA_AGENT_KEY = "ed25519:55YQAYCMBejSMbm6uZhB2XVT1h3UErpefaPMF7XWCXDtp3ytJaEJ8nGzVrp9pH5ZqVbaNbNG38LSzkk5KPSWTvmL";
export const PUBLIC_KEEPER_ACCOUNT = "keeper.bridle-hq.testnet";
export const PUBLIC_KEEPER_KEY = "ed25519:2u93KBfYCG2d9X9ce9u7jysBGAnvq1uRVhdYFKrEuiJkmVuBrtKvuTH2xTRcNr7HSEKWYazQqD92PXNAKnicJFcS";
