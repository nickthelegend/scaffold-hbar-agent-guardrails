//SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { ScaffoldETHDeploy } from "./DeployHelpers.s.sol";
import { AgentVaultFactory } from "../contracts/AgentVaultFactory.sol";
import { AggregatorV3Interface } from "../contracts/interfaces/AggregatorV3Interface.sol";

/**
 * @notice Deploys AgentVaultFactory wired to Chainlink's HBAR/USD feed.
 * @dev Example: yarn foundry:deploy --network hedera_testnet
 *      Override the feed with HBAR_USD_FEED=0x... (e.g. for mainnet or a local mock).
 */
contract DeployScript is ScaffoldETHDeploy {
    /// Chainlink HBAR/USD on Hedera testnet (chain 296).
    address internal constant TESTNET_HBAR_USD_FEED = 0x59bC155EB6c6C415fE43255aF66EcF0523c92B4a;
    /// Answers older than this route agent payments to manual approval.
    uint256 internal constant DEFAULT_MAX_PRICE_AGE = 1 hours;

    function run() external ScaffoldEthDeployerRunner {
        address feed = vm.envOr("HBAR_USD_FEED", TESTNET_HBAR_USD_FEED);
        AgentVaultFactory factory = new AgentVaultFactory(AggregatorV3Interface(feed), DEFAULT_MAX_PRICE_AGE);
        deployments.push(Deployment({ name: "AgentVaultFactory", addr: address(factory) }));
    }
}
