// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { Test } from "forge-std/Test.sol";
import { AgentVault } from "../../contracts/AgentVault.sol";
import { AggregatorV3Interface } from "../../contracts/interfaces/AggregatorV3Interface.sol";

/// @notice Runs against live Hedera testnet state: `yarn foundry:test:testnet`.
/// Proves the vault prices payments with the real Chainlink HBAR/USD feed.
contract AgentVaultForkTest is Test {
    AggregatorV3Interface internal constant FEED = AggregatorV3Interface(0x59bC155EB6c6C415fE43255aF66EcF0523c92B4a);

    function setUp() public {
        if (block.chainid != 296) vm.skip(true);
    }

    function test_quoteUsd_usesLiveChainlinkPrice() public {
        AgentVault vault = new AgentVault(address(this), FEED, 1 days);
        (, int256 answer,, uint256 updatedAt,) = FEED.latestRoundData();

        (bool ok, uint256 usd) = vault.quoteUsd(100e8); // 100 HBAR

        assertTrue(ok, "live feed should be fresh within a day");
        assertGt(answer, 0);
        assertLe(block.timestamp - updatedAt, 1 days);
        // 100 HBAR at the feed price, expressed with 6 decimals; answer > 0 was asserted above.
        // forge-lint: disable-next-line(unsafe-typecast)
        assertEq(usd, (100 * uint256(answer) * 1e6) / 10 ** FEED.decimals());
        assertGt(usd, 1e6, "100 HBAR should be worth more than $1");
    }

    function test_quoteUsd_tightFreshnessFailsSafe() public {
        AgentVault vault = new AgentVault(address(this), FEED, 0);
        (,,, uint256 updatedAt,) = FEED.latestRoundData();
        if (block.timestamp == updatedAt) vm.skip(true); // a zero-second-old answer is legitimately fresh
        (bool ok,) = vault.quoteUsd(1e8);
        assertFalse(ok, "an answer older than maxPriceAge must route payments to approval");
    }
}
