// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Subset of the Hedera Schedule Service system contract (HIP-1215) at 0x16b.
/// @dev Lets a contract schedule a future call to itself; the network executes it at `expirySecond`
///      with no off-chain keeper involved.
interface IHederaScheduleService {
    /// @return responseCode 22 (SUCCESS) on success
    /// @return scheduleAddress address of the created schedule entity, address(0) on failure
    function scheduleCall(address to, uint256 expirySecond, uint256 gasLimit, uint64 value, bytes memory callData)
        external
        returns (int64 responseCode, address scheduleAddress);

    /// @notice Whether the given consensus second still has throttle capacity for a call of `gasLimit`.
    function hasScheduleCapacity(uint256 expirySecond, uint256 gasLimit) external view returns (bool hasCapacity);

    function deleteSchedule(address scheduleAddress) external returns (int64 responseCode);
}
