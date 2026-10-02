# Agent instructions

Briefing for coding agents (Claude Code, Cursor, Codex) working in an **Agent Guardrails** project. Claude Code loads it through `CLAUDE.md`.

The project lets AI agents spend HBAR from an `AgentVault` under USD limits that the contract enforces. Read `README.md` → "How it works" before changing contract logic.

## Packages

| Path | What | Toolchain |
|---|---|---|
| `packages/foundry` | `AgentVault`, `AgentVaultFactory`, deploy script, tests | Foundry (`forge`) |
| `packages/agent` | `@sh/agent`: Hedera Agent Kit plugin, Claude toolkit, `setup`/`demo`/`chat` CLIs | TypeScript, tsx, vitest |
| `packages/nextjs` | Owner dashboard | Next.js App Router, RainbowKit, wagmi, viem, DaisyUI |

The dashboard imports the ABI, intent encoding, unit conversions, lanes and network constants from `@sh/agent` (`/abi`, `/intent`, `/units`, `/vault`, `/network`, `/mirror`). Never duplicate the ABI or the intent encoding in the frontend. `utils/guardrails/format.ts` holds display-only formatting.

## Commands

```bash
yarn install
yarn lint                 # ESLint + forge fmt --check + prettier + tsc
yarn test                 # foundry + agent + frontend unit tests

yarn foundry:compile
yarn foundry:test                                     # unit + fuzz
yarn foundry:test:testnet --match-path "test/fork/*"  # live Chainlink feed (unit suites also run on a fork)
yarn foundry:deploy --network hedera_testnet          # regenerates packages/nextjs/contracts/deployedContracts.ts

yarn workspace @sh/agent sync-abi   # after changing contracts: copy ABIs into packages/agent/src/abi.ts
yarn agent:test
yarn agent:setup          # needs OWNER_PRIVATE_KEY=0x... (funded testnet ECDSA)
yarn agent:demo --wait
yarn agent:chat           # needs ANTHROPIC_API_KEY or `ant auth login`

yarn next:dev             # http://localhost:3000
yarn next:test
yarn next:build
```

After any contract change run, in order: `yarn foundry:test`, `yarn workspace @sh/agent sync-abi`, `yarn agent:test`, `yarn next:check-types`.

## Invariants you must preserve

1. **Units.** `AgentVault` amounts are **tinybars** (8 decimals); USD values are **6-decimal** fixed point, rounded up. JSON-RPC transaction `value` and `eth_getBalance` are **weibars** (18 decimals). Use the helpers in `packages/agent/src/units.ts` (`hbarToWeibars`, `weibarsToTinybars`, …); never hand-roll decimal conversions.
2. **Every `pay` lands in exactly one lane** (Instant, Timelock, Approval) and emits `PaymentRequested`. Anything uncertain (oracle failure, unknown recipient, budget exceeded) must fall to **Approval**, never to Instant.
3. **`quoteUsd` must never revert.** Oracle problems return `ok = false`. Feed decimals are read once, in the constructor.
4. **`executeTimelocked` only reverts for a wrong status, before `executeAfter`, or while paused** (the payment then stays timelocked). Otherwise it records the outcome (executed, vetoed or failed), so the scheduled transaction never fails. Revoked agents or removed recipients resolve as `Vetoed`.
5. **Scheduling is best effort.** A failed or missing Schedule Service must not revert `pay`; execution stays permissionless after `executeAfter`, which `PaymentRequested` carries.
6. **`pendingTimelockUsd` and `pendingTimelockCount` are released exactly once** per timelocked request (execute or veto), via `_releaseTimelock`. Keep the count cap: every timelock costs the vault a scheduled transaction.
7. **Intent encoding is canonical.** `encodeIntent` key order and formatting are part of the on-chain hash. Changing them breaks verification of existing HCS messages, so bump `v` instead.
8. The owner can never be an agent (`setPolicy` rejects it), and `perTxLimitUsd ≤ dailyLimitUsd`.

## Layout

- Contracts: `packages/foundry/contracts/` (`interfaces/` holds the Schedule Service and Chainlink interfaces)
- Contract tests: `packages/foundry/test/AgentVault.t.sol`; mocks in `test/mocks/` are etched at the system addresses (`0x16b`); live fork test in `test/fork/`
- Plugin tools: `packages/agent/src/plugin/index.ts` (extend `BaseQueryTool` for reads; transaction tools build in `coreAction` and submit in `secondaryAction` so Agent Kit hooks can inspect them first)
- Claude adapter: `packages/agent/src/claude-toolkit.ts`
- Dashboard: `packages/nextjs/app/page.tsx`, `app/vault/[address]/page.tsx`, `components/guardrails/`, `hooks/guardrails/`, `utils/guardrails/`

## Frontend conventions

- Vault addresses are dynamic, so use `useVaultRead` / `useVaultWrite` from `~~/hooks/guardrails` (typed against the vault ABI). Use `useScaffoldReadContract` / `useScaffoldWriteContract` only for `AgentVaultFactory`, which lives in `deployedContracts.ts`.
- History comes from the mirror node (`utils/guardrails/activity.ts`). It pages through the full history and sorts by consensus timestamp and then log index, because the mirror node returns newest first. Keep decoding logic pure and unit-tested in `packages/nextjs/test/`.
- Use DaisyUI classes (`btn`, `badge`, `card`, `join`) before raw Tailwind. Imports use the `~~` alias. Add `"use client"` to pages that use hooks.
- Scaffold's abitype config types addresses as `string`. Cast to viem's `Address` at the boundary.

## Extending

- **HTS token payments (e.g. USDC):** add `payToken(token, to, amount, intentHash)` with a per-token feed or a 1:1 stablecoin price, associate the vault with the token, and add a lane test for each branch.
- **More lanes or rules (per-recipient caps, time-of-day windows):** add them to the lane decision in `pay`, keep the fall-through to Approval, and extend `worstCaseDailyExposureUsd`.
- **Another agent framework:** the plugin already works with every Agent Kit adapter; pass `createAgentGuardrailsPlugin(...)` in `configuration.plugins`.

## Style

| Style | Use |
|---|---|
| `UpperCamelCase` | types, components, contracts |
| `lowerCamelCase` | variables, functions |
| `CONSTANT_CASE` | constants |

Solidity: custom errors (no `require` strings), NatSpec on external functions, `forge fmt`. TypeScript: prefer `type` over `interface` except for implementable contracts (`VaultGateway`, `IntentPublisher`), let inference work, and write comments that add information.
