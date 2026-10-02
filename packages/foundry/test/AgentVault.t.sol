// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { Test } from "forge-std/Test.sol";
import { AgentVault } from "../contracts/AgentVault.sol";
import { AgentVaultFactory } from "../contracts/AgentVaultFactory.sol";
import { MockAggregator } from "./mocks/MockAggregator.sol";
import { MockHederaScheduleService } from "./mocks/MockHederaScheduleService.sol";

contract AgentVaultTest is Test {
    address internal constant HSS_ADDRESS = address(0x16b);

    // $0.10 per HBAR with 8 feed decimals.
    int256 internal constant PRICE = 10_000_000;
    uint256 internal constant HBAR = 1e8; // tinybars
    uint64 internal constant USD = 1e6; // micro-dollars

    MockAggregator internal feed;
    MockHederaScheduleService internal hss;
    AgentVaultFactory internal factory;
    AgentVault internal vault;

    address internal owner = makeAddr("owner");
    address internal agent = makeAddr("agent");
    address internal shop = makeAddr("shop");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        vm.warp(1_790_000_000);
        feed = new MockAggregator(PRICE);
        vm.etch(HSS_ADDRESS, address(new MockHederaScheduleService()).code);
        hss = MockHederaScheduleService(HSS_ADDRESS);

        factory = new AgentVaultFactory(feed, 1 hours);
        vm.deal(owner, 10_000 * HBAR);
        vm.prank(owner);
        vault = factory.createVault{ value: 1_000 * HBAR }();

        vm.startPrank(owner);
        vault.setPolicy(agent, _policy(1 * USD, 3 * USD, 10 * USD, 1 hours, false));
        vault.setRecipient(agent, shop, true);
        vm.stopPrank();
    }

    function _policy(uint64 perTx, uint64 daily, uint64 timelockCap, uint32 vetoWindow, bool anyRecipient)
        internal
        pure
        returns (AgentVault.Policy memory)
    {
        return AgentVault.Policy({
            active: true,
            anyRecipient: anyRecipient,
            vetoWindow: vetoWindow,
            perTxLimitUsd: perTx,
            dailyLimitUsd: daily,
            timelockCapUsd: timelockCap
        });
    }

    function _pay(address to, uint256 amount) internal returns (uint256 id, AgentVault.Lane lane) {
        vm.prank(agent);
        return vault.pay(to, amount, keccak256("buy coffee"));
    }

    function _status(uint256 id) internal view returns (AgentVault.Status status) {
        (,,,,,, status,,,) = vault.requests(id);
    }

    /*//////////////////////////////////////////////////////////////
                              PRICING
    //////////////////////////////////////////////////////////////*/

    function test_quoteUsd_convertsTinybarsAtFeedPrice() public view {
        (bool ok, uint256 usd) = vault.quoteUsd(10 * HBAR);
        assertTrue(ok);
        assertEq(usd, 1 * USD);
    }

    function test_quoteUsd_rejectsStalePrice() public {
        feed.set(PRICE, block.timestamp - 1 hours - 1);
        (bool ok,) = vault.quoteUsd(HBAR);
        assertFalse(ok);
    }

    function test_quoteUsd_rejectsNonPositiveAnswer() public {
        feed.set(0, block.timestamp);
        (bool ok,) = vault.quoteUsd(HBAR);
        assertFalse(ok);
    }

    function test_quoteUsd_survivesRevertingFeed() public {
        feed.setRevert(true);
        (bool ok,) = vault.quoteUsd(HBAR);
        assertFalse(ok);
    }

    /*//////////////////////////////////////////////////////////////
                             INSTANT LANE
    //////////////////////////////////////////////////////////////*/

    function test_pay_instantWithinLimits() public {
        (uint256 id, AgentVault.Lane lane) = _pay(shop, 5 * HBAR); // $0.50

        assertEq(uint8(lane), uint8(AgentVault.Lane.Instant));
        assertEq(uint8(_status(id)), uint8(AgentVault.Status.Executed));
        assertEq(shop.balance, 5 * HBAR);
        assertEq(vault.remainingDailyUsd(agent), 2.5e6);
    }

    function test_pay_dailyLimitPushesToTimelock() public {
        _pay(shop, 10 * HBAR);
        _pay(shop, 10 * HBAR);
        _pay(shop, 10 * HBAR); // $3 spent, daily limit reached

        (, AgentVault.Lane lane) = _pay(shop, 1 * HBAR);
        assertEq(uint8(lane), uint8(AgentVault.Lane.Timelock));
        assertEq(shop.balance, 30 * HBAR);
    }

    function test_pay_dailyLimitResetsNextDay() public {
        _pay(shop, 10 * HBAR);
        _pay(shop, 10 * HBAR);
        _pay(shop, 10 * HBAR);
        vm.warp(block.timestamp + 1 days);
        feed.set(PRICE, block.timestamp);

        (, AgentVault.Lane lane) = _pay(shop, 10 * HBAR);
        assertEq(uint8(lane), uint8(AgentVault.Lane.Instant));
    }

    /*//////////////////////////////////////////////////////////////
                            TIMELOCK LANE
    //////////////////////////////////////////////////////////////*/

    function test_pay_overPerTxIsTimelockedAndScheduled() public {
        (uint256 id, AgentVault.Lane lane) = _pay(shop, 50 * HBAR); // $5 > $1 per tx

        assertEq(uint8(lane), uint8(AgentVault.Lane.Timelock));
        assertEq(uint8(_status(id)), uint8(AgentVault.Status.Timelocked));
        assertEq(hss.count(), 1);
        (address to, uint256 expiry, uint256 gasLimit,) = hss.scheduled(0);
        assertEq(to, address(vault));
        assertEq(expiry, block.timestamp + 1 hours);
        assertEq(gasLimit, vault.SCHEDULE_GAS_LIMIT());
        assertEq(vault.pendingTimelockCount(agent), 1);
        assertEq(vault.pendingTimelockUsd(agent), 5 * USD);
        assertEq(shop.balance, 0);
    }

    function test_scheduledExecution_paysAfterVetoWindow() public {
        (uint256 id,) = _pay(shop, 50 * HBAR);
        vm.warp(block.timestamp + 1 hours);

        (bool ok,) = hss.fire(0);

        assertTrue(ok);
        assertEq(uint8(_status(id)), uint8(AgentVault.Status.Executed));
        assertEq(shop.balance, 50 * HBAR);
        assertEq(vault.pendingTimelockUsd(agent), 0);
    }

    function test_executeTimelocked_revertsBeforeWindow() public {
        (uint256 id,) = _pay(shop, 50 * HBAR);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.TooEarly.selector, block.timestamp + 1 hours));
        vault.executeTimelocked(id);
    }

    function test_veto_cancelsTimelockedPayment() public {
        (uint256 id,) = _pay(shop, 50 * HBAR);
        vm.prank(owner);
        vault.veto(id);
        vm.warp(block.timestamp + 1 hours);

        (bool ok,) = hss.fire(0);

        assertFalse(ok);
        assertEq(uint8(_status(id)), uint8(AgentVault.Status.Vetoed));
        assertEq(shop.balance, 0);
        assertEq(vault.pendingTimelockUsd(agent), 0);
        assertEq(vault.pendingTimelockCount(agent), 0);
        (,,,,,,,,, address schedule) = vault.requests(id);
        assertTrue(hss.deleted(schedule), "veto should delete the pending Hedera schedule");
    }

    function test_timelockCapRoutesToApproval() public {
        _pay(shop, 60 * HBAR); // $6 timelocked
        (, AgentVault.Lane lane) = _pay(shop, 50 * HBAR); // $5 more would exceed the $10 cap
        assertEq(uint8(lane), uint8(AgentVault.Lane.Approval));
    }

    function test_revokedAgent_timelockResolvesAsVeto() public {
        (uint256 id,) = _pay(shop, 50 * HBAR);
        vm.prank(owner);
        vault.revokeAgent(agent);
        vm.warp(block.timestamp + 1 hours);

        vault.executeTimelocked(id);

        assertEq(uint8(_status(id)), uint8(AgentVault.Status.Vetoed));
        assertEq(shop.balance, 0);
    }

    function test_missedSchedule_isPermissionlesslyExecutable() public {
        hss.setNoCapacity(true);
        (uint256 id,) = _pay(shop, 50 * HBAR);
        assertEq(hss.count(), 0);

        vm.warp(block.timestamp + 1 hours);
        vm.prank(stranger);
        vault.executeTimelocked(id);

        assertEq(shop.balance, 50 * HBAR);
    }

    function test_failedScheduleResponse_keepsPaymentTimelocked() public {
        hss.setFailureCode(21);
        (uint256 id,) = _pay(shop, 50 * HBAR);
        assertEq(uint8(_status(id)), uint8(AgentVault.Status.Timelocked));
        assertEq(hss.count(), 0);
    }

    function test_timelockExecution_insufficientBalanceMarksFailed() public {
        (uint256 id,) = _pay(shop, 50 * HBAR);
        vm.prank(owner);
        vault.withdraw(owner, address(vault).balance);
        vm.warp(block.timestamp + 1 hours);

        vault.executeTimelocked(id);

        assertEq(uint8(_status(id)), uint8(AgentVault.Status.Failed));
    }

    /*//////////////////////////////////////////////////////////////
                            APPROVAL LANE
    //////////////////////////////////////////////////////////////*/

    function test_unknownRecipientNeedsApproval() public {
        (uint256 id, AgentVault.Lane lane) = _pay(stranger, 1 * HBAR);
        assertEq(uint8(lane), uint8(AgentVault.Lane.Approval));
        assertEq(stranger.balance, 0);

        vm.prank(owner);
        vault.approve(id);

        assertEq(uint8(_status(id)), uint8(AgentVault.Status.Executed));
        assertEq(stranger.balance, 1 * HBAR);
    }

    function test_approve_revertsAndStaysPendingWhenVaultIsEmpty() public {
        (uint256 id,) = _pay(stranger, 1 * HBAR);
        vm.startPrank(owner);
        vault.withdraw(owner, address(vault).balance);
        vm.expectRevert(AgentVault.InsufficientBalance.selector);
        vault.approve(id);
        vm.stopPrank();
        assertEq(uint8(_status(id)), uint8(AgentVault.Status.AwaitingApproval));
    }

    function test_stalePriceNeedsApprovalEvenWithinLimits() public {
        feed.set(PRICE, block.timestamp - 2 hours);
        (, AgentVault.Lane lane) = _pay(shop, 1 * HBAR);
        assertEq(uint8(lane), uint8(AgentVault.Lane.Approval));
    }

    function test_reject() public {
        (uint256 id,) = _pay(stranger, 1 * HBAR);
        vm.prank(owner);
        vault.reject(id);
        assertEq(uint8(_status(id)), uint8(AgentVault.Status.Rejected));

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.WrongStatus.selector, AgentVault.Status.Rejected));
        vault.approve(id);
    }

    function test_approvalExpires() public {
        (uint256 id,) = _pay(stranger, 1 * HBAR);
        vm.warp(block.timestamp + vault.APPROVAL_TTL() + 1);
        vm.prank(owner);
        vm.expectRevert(AgentVault.ApprovalExpired.selector);
        vault.approve(id);
    }

    /*//////////////////////////////////////////////////////////////
                         ACCESS AND KILL SWITCH
    //////////////////////////////////////////////////////////////*/

    function test_pay_revertsForNonAgent() public {
        vm.prank(stranger);
        vm.expectRevert(AgentVault.NotAgent.selector);
        vault.pay(shop, HBAR, bytes32(0));
    }

    function test_pay_revertsForZeroAmountOrRecipient() public {
        vm.startPrank(agent);
        vm.expectRevert(AgentVault.ZeroAmount.selector);
        vault.pay(shop, 0, bytes32(0));
        vm.expectRevert(AgentVault.ZeroAddress.selector);
        vault.pay(address(0), HBAR, bytes32(0));
        vm.stopPrank();
    }

    function test_paused_blocksPaymentsAndExecutions() public {
        (uint256 id,) = _pay(shop, 50 * HBAR);
        vm.prank(owner);
        vault.setPaused(true);

        vm.prank(agent);
        vm.expectRevert(AgentVault.IsPaused.selector);
        vault.pay(shop, HBAR, bytes32(0));

        vm.warp(block.timestamp + 1 hours);
        vm.expectRevert(AgentVault.IsPaused.selector);
        vault.executeTimelocked(id);

        vm.prank(owner);
        vault.setPaused(false);
        vault.executeTimelocked(id);
        assertEq(shop.balance, 50 * HBAR);
    }

    function test_ownerFunctions_revertForOthers() public {
        vm.startPrank(agent);
        vm.expectRevert(AgentVault.NotOwner.selector);
        vault.setPolicy(agent, _policy(100 * USD, 100 * USD, 0, 0, true));
        vm.expectRevert(AgentVault.NotOwner.selector);
        vault.withdraw(agent, 1);
        vm.expectRevert(AgentVault.NotOwner.selector);
        vault.setPaused(true);
        vm.stopPrank();
    }

    function test_setPolicy_rejectsInvalidPolicies() public {
        vm.startPrank(owner);
        vm.expectRevert(AgentVault.InvalidPolicy.selector);
        vault.setPolicy(agent, _policy(5 * USD, 1 * USD, 0, 0, false)); // perTx > daily
        vm.expectRevert(AgentVault.InvalidPolicy.selector);
        vault.setPolicy(owner, _policy(1 * USD, 1 * USD, 0, 0, false)); // owner cannot be an agent
        vm.stopPrank();
    }

    function test_worstCaseDailyExposure() public view {
        // Two daily budgets can straddle midnight; the $10 timelock budget can execute floor(24h/1h)+1 = 25 times.
        assertEq(vault.worstCaseDailyExposureUsd(agent), 2 * 3 * USD + 10 * USD * 25);
    }

    function test_quoteUsd_roundsUpSoDustIsNeverFree() public view {
        (, uint256 usd) = vault.quoteUsd(1); // 1 tinybar = $0.000000001
        assertEq(usd, 1);
    }

    function test_quoteUsd_rejectsAbsurdAnswer() public {
        feed.set(type(int256).max, block.timestamp);
        (bool ok,) = vault.quoteUsd(HBAR);
        assertFalse(ok);
    }

    function test_pendingTimelockCountIsCapped() public {
        vm.prank(owner);
        vault.setPolicy(agent, _policy(0, 0, 1_000 * USD, 1 hours, false));
        for (uint256 i; i < vault.MAX_PENDING_TIMELOCKS(); i++) {
            (, AgentVault.Lane lane) = _pay(shop, 1 * HBAR);
            assertEq(uint8(lane), uint8(AgentVault.Lane.Timelock));
        }
        (, AgentVault.Lane overflow) = _pay(shop, 1 * HBAR);
        assertEq(uint8(overflow), uint8(AgentVault.Lane.Approval), "each timelock costs the vault a scheduled tx");
    }

    function test_missingScheduleService_stillTimelocks() public {
        vm.etch(HSS_ADDRESS, "");
        (uint256 id, AgentVault.Lane lane) = _pay(shop, 50 * HBAR);
        assertEq(uint8(lane), uint8(AgentVault.Lane.Timelock));
        vm.warp(block.timestamp + 1 hours);
        vault.executeTimelocked(id);
        assertEq(shop.balance, 50 * HBAR);
    }

    function test_factory_tracksVaultsPerOwner() public view {
        address[] memory vaults = factory.vaultsOf(owner);
        assertEq(vaults.length, 1);
        assertEq(vaults[0], address(vault));
        assertEq(vault.owner(), owner);
        assertEq(address(vault).balance, 1_000 * HBAR);
    }

    /*//////////////////////////////////////////////////////////////
                                FUZZ
    //////////////////////////////////////////////////////////////*/

    /// Whatever sequence of payments the agent attempts, instant spend never exceeds the daily limit.
    function testFuzz_instantSpendNeverExceedsDailyLimit(uint64[8] memory amounts) public {
        uint256 instantPaid;
        for (uint256 i; i < amounts.length; i++) {
            uint256 amount = bound(amounts[i], 1, 100 * HBAR);
            (, AgentVault.Lane lane) = _pay(shop, amount);
            if (lane == AgentVault.Lane.Instant) instantPaid += amount;
        }
        (, uint256 usd) = vault.quoteUsd(instantPaid);
        assertLe(usd, 3 * USD);
        assertEq(shop.balance, instantPaid);
    }
}
