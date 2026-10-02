// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import { AggregatorV3Interface } from "./interfaces/AggregatorV3Interface.sol";
import { IHederaScheduleService } from "./interfaces/IHederaScheduleService.sol";

/**
 * @title AgentVault
 * @notice HBAR vault that lets AI agents spend on a human's behalf under on-chain, USD-denominated policies.
 *
 * Every agent payment lands in exactly one lane:
 *  - INSTANT:   recipient allowed, price fresh, within the per-tx and daily USD limits -> paid immediately.
 *  - TIMELOCK:  recipient allowed, price fresh, over the instant limits but within the agent's timelock
 *               budget -> the vault schedules its own execution through the Hedera Schedule Service
 *               after `vetoWindow` seconds; the owner can veto until then.
 *  - APPROVAL:  anything else (unknown recipient, stale/broken oracle, over every budget) -> waits for
 *               an explicit owner decision.
 *
 * The policy is enforced by the contract, so a prompt-injected or key-compromised agent cannot exceed it.
 * Worst-case unattended outflow per agent per day is bounded by
 *   dailyLimitUsd + timelockCapUsd * ceil(1 day / vetoWindow)
 * which `worstCaseDailyExposureUsd` exposes for UIs.
 *
 * @dev Units: on Hedera, `msg.value` and `address.balance` inside the EVM are tinybars (8 decimals).
 *      USD amounts are 6-decimal fixed point ("micro-dollars").
 */
contract AgentVault is ReentrancyGuard {
    enum Lane {
        Instant,
        Timelock,
        Approval
    }

    enum Status {
        None,
        Executed,
        Timelocked,
        AwaitingApproval,
        Vetoed,
        Rejected,
        Failed
    }

    struct Policy {
        bool active;
        bool anyRecipient;
        uint32 vetoWindow;
        uint64 perTxLimitUsd;
        uint64 dailyLimitUsd;
        uint64 timelockCapUsd;
    }

    struct Request {
        address agent;
        address to;
        uint64 amount;
        uint128 usdValue;
        uint40 createdAt;
        uint40 executeAfter;
        Status status;
        Lane lane;
        bytes32 intentHash;
        address schedule;
    }

    IHederaScheduleService internal constant HSS = IHederaScheduleService(address(0x16b));
    int64 internal constant HSS_SUCCESS = 22;
    uint256 public constant SCHEDULE_GAS_LIMIT = 400_000;
    uint256 public constant APPROVAL_TTL = 7 days;
    uint256 internal constant USD_DECIMALS = 6;
    uint256 internal constant TINYBARS_PER_HBAR = 1e8;

    address public immutable owner;
    AggregatorV3Interface public immutable hbarUsdFeed;

    /// @notice Maximum age of the Chainlink answer before payments fall back to the approval lane.
    uint256 public maxPriceAge;
    /// @notice HCS topic number (shard.realm 0.0) where agents publish the reasoning behind each payment.
    uint64 public intentTopic;
    bool public paused;

    uint256 public nextRequestId = 1;
    mapping(uint256 id => Request) public requests;
    mapping(address agent => Policy) public policies;
    mapping(address agent => mapping(address recipient => bool)) public isAllowedRecipient;
    mapping(address agent => mapping(uint256 day => uint256 usd)) public spentUsd;
    mapping(address agent => uint256 usd) public pendingTimelockUsd;
    address[] internal _agents;
    mapping(address agent => bool) internal _known;

    event Funded(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event PolicySet(address indexed agent, Policy policy);
    event RecipientSet(address indexed agent, address indexed recipient, bool allowed);
    event AgentRevoked(address indexed agent);
    event PausedSet(bool paused);
    event MaxPriceAgeSet(uint256 maxPriceAge);
    event IntentTopicSet(uint64 topic);
    event PaymentRequested(
        uint256 indexed id,
        address indexed agent,
        address indexed to,
        uint256 amount,
        uint256 usdValue,
        Lane lane,
        bytes32 intentHash
    );
    event PaymentExecuted(uint256 indexed id, address indexed to, uint256 amount);
    event PaymentVetoed(uint256 indexed id);
    event PaymentRejected(uint256 indexed id);
    event PaymentFailed(uint256 indexed id);
    event ExecutionScheduled(uint256 indexed id, address schedule, uint256 executeAfter);
    event ScheduleFailed(uint256 indexed id, int64 responseCode);

    error NotOwner();
    error NotAgent();
    error IsPaused();
    error ZeroAmount();
    error ZeroAddress();
    error InvalidPolicy();
    error AmountTooLarge();
    error InsufficientBalance();
    error TransferFailed();
    error WrongStatus(Status status);
    error TooEarly(uint256 executeAfter);
    error ApprovalExpired();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address owner_, AggregatorV3Interface hbarUsdFeed_, uint256 maxPriceAge_) {
        if (owner_ == address(0) || address(hbarUsdFeed_) == address(0)) revert ZeroAddress();
        owner = owner_;
        hbarUsdFeed = hbarUsdFeed_;
        maxPriceAge = maxPriceAge_;
    }

    receive() external payable {
        emit Funded(msg.sender, msg.value);
    }

    /*//////////////////////////////////////////////////////////////
                                AGENT
    //////////////////////////////////////////////////////////////*/

    /// @notice Pay `amount` tinybars to `to`, routed through the caller's policy.
    /// @param intentHash keccak256 of the reasoning text the agent published to `intentTopic`.
    function pay(address to, uint256 amount, bytes32 intentHash) external nonReentrant returns (uint256 id, Lane lane) {
        if (paused) revert IsPaused();
        Policy memory p = policies[msg.sender];
        if (!p.active) revert NotAgent();
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (amount > type(uint64).max) revert AmountTooLarge();

        (bool priceOk, uint256 usd) = quoteUsd(amount);
        bool recipientOk = p.anyRecipient || isAllowedRecipient[msg.sender][to];
        uint256 day = block.timestamp / 1 days;

        if (priceOk && recipientOk && usd <= p.perTxLimitUsd && spentUsd[msg.sender][day] + usd <= p.dailyLimitUsd) {
            lane = Lane.Instant;
        } else if (
            priceOk && recipientOk && p.vetoWindow > 0 && pendingTimelockUsd[msg.sender] + usd <= p.timelockCapUsd
        ) {
            lane = Lane.Timelock;
        } else {
            lane = Lane.Approval;
        }

        id = nextRequestId++;
        Request storage r = requests[id];
        r.agent = msg.sender;
        r.to = to;
        // casting to uint64 is safe: amounts above type(uint64).max reverted with AmountTooLarge above
        // forge-lint: disable-next-line(unsafe-typecast)
        r.amount = uint64(amount);
        r.usdValue = SafeCast.toUint128(usd);
        r.createdAt = uint40(block.timestamp);
        r.lane = lane;
        r.intentHash = intentHash;
        emit PaymentRequested(id, msg.sender, to, amount, usd, lane, intentHash);

        if (lane == Lane.Instant) {
            spentUsd[msg.sender][day] += usd;
            r.status = Status.Executed;
            _send(to, amount);
            emit PaymentExecuted(id, to, amount);
        } else if (lane == Lane.Timelock) {
            pendingTimelockUsd[msg.sender] += usd;
            r.status = Status.Timelocked;
            r.executeAfter = uint40(block.timestamp + p.vetoWindow);
            _scheduleExecution(id, r.executeAfter);
        } else {
            r.status = Status.AwaitingApproval;
        }
    }

    /*//////////////////////////////////////////////////////////////
                         TIMELOCK EXECUTION
    //////////////////////////////////////////////////////////////*/

    /// @notice Executes a timelocked payment once its veto window has passed.
    /// @dev Normally invoked by the Hedera Schedule Service; permissionless so a missed schedule never strands
    ///      a payment the owner already had the chance to veto. Never reverts after the checks, so the
    ///      scheduled transaction records the outcome instead of failing.
    function executeTimelocked(uint256 id) external nonReentrant {
        Request storage r = requests[id];
        if (r.status != Status.Timelocked) revert WrongStatus(r.status);
        if (block.timestamp < r.executeAfter) revert TooEarly(r.executeAfter);
        if (paused) revert IsPaused();

        pendingTimelockUsd[r.agent] -= r.usdValue;
        Policy memory p = policies[r.agent];
        if (!p.active || !(p.anyRecipient || isAllowedRecipient[r.agent][r.to])) {
            // The agent was revoked or the recipient removed during the window: treat as a veto.
            r.status = Status.Vetoed;
            emit PaymentVetoed(id);
            return;
        }
        _settle(id, r);
    }

    /*//////////////////////////////////////////////////////////////
                                OWNER
    //////////////////////////////////////////////////////////////*/

    function veto(uint256 id) external onlyOwner {
        Request storage r = requests[id];
        if (r.status != Status.Timelocked) revert WrongStatus(r.status);
        pendingTimelockUsd[r.agent] -= r.usdValue;
        r.status = Status.Vetoed;
        emit PaymentVetoed(id);
    }

    function approve(uint256 id) external onlyOwner nonReentrant {
        Request storage r = requests[id];
        if (r.status != Status.AwaitingApproval) revert WrongStatus(r.status);
        if (block.timestamp > r.createdAt + APPROVAL_TTL) revert ApprovalExpired();
        _settle(id, r);
    }

    function reject(uint256 id) external onlyOwner {
        Request storage r = requests[id];
        if (r.status != Status.AwaitingApproval) revert WrongStatus(r.status);
        r.status = Status.Rejected;
        emit PaymentRejected(id);
    }

    function setPolicy(address agent, Policy calldata policy) external onlyOwner {
        if (agent == address(0)) revert ZeroAddress();
        if (agent == owner || !policy.active || policy.perTxLimitUsd > policy.dailyLimitUsd) revert InvalidPolicy();
        policies[agent] = policy;
        if (!_known[agent]) {
            _known[agent] = true;
            _agents.push(agent);
        }
        emit PolicySet(agent, policy);
    }

    function setRecipient(address agent, address recipient, bool allowed) external onlyOwner {
        if (recipient == address(0)) revert ZeroAddress();
        isAllowedRecipient[agent][recipient] = allowed;
        emit RecipientSet(agent, recipient, allowed);
    }

    /// @notice Immediately stops an agent; its timelocked payments resolve as vetoed.
    function revokeAgent(address agent) external onlyOwner {
        policies[agent].active = false;
        emit AgentRevoked(agent);
    }

    /// @notice Kill switch: blocks new payments and timelock executions for every agent.
    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    function setMaxPriceAge(uint256 maxPriceAge_) external onlyOwner {
        maxPriceAge = maxPriceAge_;
        emit MaxPriceAgeSet(maxPriceAge_);
    }

    function setIntentTopic(uint64 topic) external onlyOwner {
        intentTopic = topic;
        emit IntentTopicSet(topic);
    }

    function withdraw(address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        _send(to, amount);
        emit Withdrawn(to, amount);
    }

    /*//////////////////////////////////////////////////////////////
                                VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @notice USD value (6 decimals) of `amount` tinybars, and whether the oracle answer is usable.
    /// @dev Any oracle failure (revert, non-positive or stale answer) returns ok=false, which routes the
    ///      payment to the approval lane rather than trusting a bad price.
    function quoteUsd(uint256 amount) public view returns (bool ok, uint256 usd) {
        try hbarUsdFeed.latestRoundData() returns (uint80, int256 answer, uint256, uint256 updatedAt, uint80) {
            if (answer <= 0 || updatedAt == 0 || updatedAt > block.timestamp) return (false, 0);
            if (block.timestamp - updatedAt > maxPriceAge) return (false, 0);
            uint256 feedDecimals = hbarUsdFeed.decimals();
            // casting to uint256 is safe because non-positive answers returned above
            // forge-lint: disable-next-line(unsafe-typecast)
            usd = (amount * uint256(answer) * 10 ** USD_DECIMALS) / (TINYBARS_PER_HBAR * 10 ** feedDecimals);
            ok = true;
        } catch {
            return (false, 0);
        }
    }

    function remainingDailyUsd(address agent) external view returns (uint256) {
        uint256 spent = spentUsd[agent][block.timestamp / 1 days];
        uint256 limit = policies[agent].dailyLimitUsd;
        return spent >= limit ? 0 : limit - spent;
    }

    /// @notice Upper bound on what `agent` can move per day without any owner action.
    function worstCaseDailyExposureUsd(address agent) external view returns (uint256) {
        Policy memory p = policies[agent];
        if (!p.active) return 0;
        if (p.vetoWindow == 0) return p.dailyLimitUsd;
        uint256 windows = (1 days + p.vetoWindow - 1) / p.vetoWindow;
        return p.dailyLimitUsd + uint256(p.timelockCapUsd) * windows;
    }

    function agents() external view returns (address[] memory) {
        return _agents;
    }

    /*//////////////////////////////////////////////////////////////
                              INTERNALS
    //////////////////////////////////////////////////////////////*/

    function _settle(uint256 id, Request storage r) internal {
        if (address(this).balance < r.amount) {
            r.status = Status.Failed;
            emit PaymentFailed(id);
            return;
        }
        r.status = Status.Executed;
        (bool ok,) = r.to.call{ value: r.amount }("");
        if (!ok) {
            r.status = Status.Failed;
            emit PaymentFailed(id);
            return;
        }
        emit PaymentExecuted(id, r.to, r.amount);
    }

    function _send(address to, uint256 amount) internal {
        if (address(this).balance < amount) revert InsufficientBalance();
        (bool ok,) = to.call{ value: amount }("");
        if (!ok) revert TransferFailed();
    }

    /// @dev Best effort: if the network has no capacity at that second or scheduling fails, the payment stays
    ///      timelocked and anyone may call `executeTimelocked` after `executeAfter`.
    function _scheduleExecution(uint256 id, uint256 executeAfter) internal {
        bytes memory callData = abi.encodeCall(this.executeTimelocked, (id));
        try HSS.hasScheduleCapacity(executeAfter, SCHEDULE_GAS_LIMIT) returns (bool hasCapacity) {
            if (!hasCapacity) {
                emit ScheduleFailed(id, -1);
                return;
            }
        } catch {
            emit ScheduleFailed(id, -1);
            return;
        }
        try HSS.scheduleCall(address(this), executeAfter, SCHEDULE_GAS_LIMIT, 0, callData) returns (
            int64 rc, address schedule
        ) {
            if (rc != HSS_SUCCESS || schedule == address(0)) {
                emit ScheduleFailed(id, rc);
                return;
            }
            requests[id].schedule = schedule;
            emit ExecutionScheduled(id, schedule, executeAfter);
        } catch {
            emit ScheduleFailed(id, -1);
        }
    }
}
