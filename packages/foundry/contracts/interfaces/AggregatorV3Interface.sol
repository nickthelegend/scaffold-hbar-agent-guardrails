// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Chainlink Data Feeds consumer interface (Hedera testnet HBAR/USD: 0x59bC155EB6c6C415fE43255aF66EcF0523c92B4a).
interface AggregatorV3Interface {
    function decimals() external view returns (uint8);

    function description() external view returns (string memory);

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}
