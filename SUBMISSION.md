# Scaffold-HBAR Template Bounty: submission pack (Agent Guardrails)

Form: https://docs.google.com/forms/d/e/1FAIpQLSfMrExu3tI95KP9WlwtS9JFka5iy3uWOi8vVK4JqpLbd0FTPA/viewform
Deadline: **Sunday 4 Oct 2026, 23:59 ET (5 Oct, 03:59 UTC)**

Fields marked **YOU** need your input; everything else is ready to paste.

---

## Page 1

| Field | Answer |
|---|---|
| Email | **YOU** (the address you registered with) |
| Bounty | Scaffold HBAR Template |

## Team Details

| Field | Answer |
|---|---|
| Team Size | **YOU** |
| Team Member Names | **YOU** (comma separated, include yourself) |
| Team Member Emails | **YOU** |
| Team Member X handles | **YOU** (optional) |
| Mainnet Account ID | **YOU**: your *mainnet* `0.0.x` account, where the prize is paid. Not a testnet account. |

## Submission Details

**Project Name**

```
Agent Guardrails
```

**Project Description** (3 sentences max)

```
Agent Guardrails is a Scaffold-HBAR template that gives AI agents a wallet they can't drain: an AgentVault contract routes every agent payment into an instant, timelocked or owner-approval lane using USD limits priced live by Chainlink's HBAR/USD feed, so a prompt-injected agent or stolen key can only move what the policy allows. Over-limit payments to known vendors are timelocked and executed by the vault's own Hedera Schedule Service call (HIP-1215, no keeper) unless the owner vetoes, and the agent publishes its reasoning to a Hedera Consensus Service topic whose hash the contract stores, making every payment explainable and verifiable. It ships a Hedera Agent Kit v4 plugin with a Claude agent, a mirror-node-powered owner dashboard, a Hedera Harness recipe, and a recorded live testnet run of every lane.
```

**Project GitHub URL**

```
https://github.com/nickthelegend/scaffold-hbar-agent-guardrails
```

**Video demo** (< 5 min): https://agent-guardrails-demo.vercel.app/agent-guardrails-demo.mp4 (72 s; player page: https://agent-guardrails-demo.vercel.app)

**Any other links**

```
Scaffold: npm create scaffold-hbar@latest -- --template nickthelegend/scaffold-hbar-agent-guardrails
Live dashboard (testnet): https://scaffold-hbar-agent-guardrails.vercel.app
Demo vault with real history: https://scaffold-hbar-agent-guardrails.vercel.app/vault/0xC3d9Fcb5Dd342BDD5dd54254Ba6bd2dA9a426513
AgentVaultFactory (Sourcify verified): https://hashscan.io/testnet/contract/0.0.10853767
Network-executed timelock (Hedera Schedule Service): https://hashscan.io/testnet/schedule/0.0.10853788
Agent intent log (HCS): https://hashscan.io/testnet/topic/0.0.10853784
Full proof table: https://github.com/nickthelegend/scaffold-hbar-agent-guardrails#live-on-hedera-testnet
```

## Developer Experience

The 1–10 scores are your call. Suggested free-text answers, drawn from what actually happened while building:

**Biggest friction or blocker**

```
Hedera reports the start of the ~2s block as block.timestamp, so a call the Schedule Service executes exactly at its expiry second can see an earlier timestamp: our first scheduled release reverted with TooEarly even though it ran on time, and we had to schedule 10s past every deadline. The ecosystem integration we first chose, Bonzo Lend, turned out to be paused on both testnet and mainnet after the July exploit, and its docs still list a stale testnet deployment, so we lost time before switching to Chainlink. On the tooling side: the JSON-RPC relay undercounts gas for calls that reach Hedera system contracts (veto → HSS deleteSchedule used 111k gas vs a 66k estimate, so the transaction failed with INSUFFICIENT_GAS); viem's EIP-1559 fee estimate on Hashio is near zero and gets rejected; and forking contracts that use immutables fails because eth_getCode returns runtime bytecode with immutable references zeroed.
```

**One thing to improve**

```
A single maintained page of "live on testnet right now" ecosystem integrations (address, status, last activity), plus documentation and a gas buffer guideline for the Schedule Service (HIP-1215) from smart contracts: who pays scheduled fees, capacity throttling, and that relay gas estimates under-count system-contract work.
```

**What worked especially well**

```
Hedera Agent Kit v4's BaseTool lifecycle and hooks made it easy to ship a plugin where off-chain policies compose with on-chain enforcement. The Schedule Service letting a contract schedule its own future call is a genuinely unique primitive. The mirror node made a backend-free dashboard possible. And create-scaffold-hbar's template.json (capabilities and outro) made the template feel first-class.
```

---

## Eligibility gate: evidence

| Gate item | Status |
|---|---|
| Scaffolds via `npm create scaffold-hbar@latest -- --template nickthelegend/scaffold-hbar-agent-guardrails` | ✅ Fresh scaffold verified on 4 Oct |
| `template.json` valid | ✅ Parsed by the CLI (capabilities and outro render) |
| `README.md` and `AGENTS.md` | ✅ |
| Install, lint, build clean from a fresh scaffold | ✅ Lint clean; 57 tests (34 Foundry, 18 agent, 5 frontend); `next build` OK |
| App boots, routes OK | ✅ `/`, `/debug`, `/vault/[address]`, `/api/health` return 200 (local and hosted) |
| Hedera services with a testnet tx and HashScan proof | ✅ Smart contracts, HSS, HCS, plus Chainlink. See README "Live on Hedera testnet" |
| No secrets or `.env` committed | ✅ Keys live only in encrypted Foundry keystores outside the repo |
| MIT licence, original work | ✅ |
| Harness spec and validators | ✅ `.harness/`: on a fresh scaffold `yarn harness:validate` reports `passed=true`, 0 findings (static, commands, Playwright gate on 3 routes) |

## Still to do

- [x] Record the demo video (< 5 min) and paste its URL into "Video demo".
- [ ] Fill in the **YOU** fields and submit before 03:59 UTC on 5 Oct.
