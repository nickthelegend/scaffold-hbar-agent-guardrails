# Agent Guardrails — product requirements

## Problem
AI agents that hold a private key can be prompt-injected or have the key stolen. Off-chain "policies" inside the
agent framework do not help once the key itself is compromised. Owners need spending limits the chain enforces.

## Users
- **Owner** (human, browser wallet): creates a vault, funds it, authorises agents with USD limits, vetoes or
  approves payments, can pause everything.
- **Agent** (process holding its own ECDSA key): pays from the vault through the Hedera Agent Kit plugin.

## Requirements
1. `AgentVaultFactory.createVault()` deploys a vault owned by the caller; `msg.value` funds it.
2. `AgentVault.pay(to, amount, intentHash)` routes every payment to exactly one lane:
   - **instant**: recipient allowed, Chainlink price fresh, `usd <= perTxLimitUsd`, daily instant spend within
     `dailyLimitUsd` → paid in the same transaction;
   - **timelock**: recipient allowed, price fresh, outstanding timelocked USD within `timelockCapUsd`, veto window
     > 0 → the vault schedules `executeTimelocked(id)` via the Hedera Schedule Service (0x16b) at
     `now + vetoWindow + SCHEDULE_DELAY` (10 s, because Hedera's `block.timestamp` is the block's start time); the owner can `veto` until then; execution is permissionless afterwards;
   - **approval**: everything else, including a stale or failing oracle → waits for `approve`/`reject`
     (expires after 7 days).
3. `worstCaseDailyExposureUsd(agent)` exposes the unattended worst case.
4. Agents publish their reasoning to an HCS topic whose submit key is the agent's key; the vault stores
   `keccak256(message)` and the dashboard shows "verified on HCS" when they match.
5. `@sh/agent` ships a Hedera Agent Kit v4 plugin (`guardrails_get_policy`, `guardrails_pay`,
   `guardrails_get_request`), a scripted demo, a Claude chat agent and an owner bootstrap CLI.
6. The Next.js dashboard lists the owner's vaults, shows balance (HBAR and USD), the live Chainlink price, agents
   with their limits and exposure, allowlists, and every payment request with veto/approve/reject actions.

## Out of scope
HTS-token payments, multi-owner vaults, mainnet deployment of the factory.
