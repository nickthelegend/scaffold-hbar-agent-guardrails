// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { AgentVault } from "./AgentVault.sol";
import { AggregatorV3Interface } from "./interfaces/AggregatorV3Interface.sol";

/// @title AgentVaultFactory
/// @notice Deploys one AgentVault per call, owned by the caller, wired to a fixed HBAR/USD feed.
contract AgentVaultFactory {
    AggregatorV3Interface public immutable hbarUsdFeed;
    uint256 public immutable defaultMaxPriceAge;

    mapping(address owner => address[] vaults) internal _vaultsOf;
    address[] public allVaults;

    event VaultCreated(address indexed owner, address indexed vault);

    error FundingFailed();

    constructor(AggregatorV3Interface hbarUsdFeed_, uint256 defaultMaxPriceAge_) {
        hbarUsdFeed = hbarUsdFeed_;
        defaultMaxPriceAge = defaultMaxPriceAge_;
    }

    /// @notice Creates a vault owned by the caller; any HBAR sent along funds it.
    function createVault() external payable returns (AgentVault vault) {
        vault = new AgentVault(msg.sender, hbarUsdFeed, defaultMaxPriceAge);
        _vaultsOf[msg.sender].push(address(vault));
        allVaults.push(address(vault));
        emit VaultCreated(msg.sender, address(vault));
        if (msg.value > 0) {
            (bool ok,) = address(vault).call{ value: msg.value }("");
            if (!ok) revert FundingFailed();
        }
    }

    function vaultsOf(address owner) external view returns (address[] memory) {
        return _vaultsOf[owner];
    }

    function vaultCount() external view returns (uint256) {
        return allVaults.length;
    }
}
