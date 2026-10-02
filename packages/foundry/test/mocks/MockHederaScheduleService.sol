// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Stand-in for the HSS system contract (0x16b); etched there by tests.
/// @dev Records scheduled calls so tests can "fire" them after warping time, like the network would.
///      State starts zeroed because vm.etch copies code only, so the defaults mean "healthy".
contract MockHederaScheduleService {
    struct Scheduled {
        address to;
        uint256 expirySecond;
        uint256 gasLimit;
        bytes callData;
    }

    Scheduled[] public scheduled;
    bool public noCapacity;
    /// @dev 0 means succeed with SUCCESS (22); anything else is returned as a failure code.
    int64 public failureCode;

    function setNoCapacity(bool value) external {
        noCapacity = value;
    }

    function setFailureCode(int64 value) external {
        failureCode = value;
    }

    function hasScheduleCapacity(uint256, uint256) external view returns (bool) {
        return !noCapacity;
    }

    function scheduleCall(address to, uint256 expirySecond, uint256 gasLimit, uint64, bytes memory callData)
        external
        returns (int64, address)
    {
        if (failureCode != 0) return (failureCode, address(0));
        scheduled.push(Scheduled(to, expirySecond, gasLimit, callData));
        return (22, address(uint160(0x5c4ed000 + scheduled.length)));
    }

    mapping(address schedule => bool) public deleted;

    function deleteSchedule(address schedule) external returns (int64) {
        deleted[schedule] = true;
        return 22;
    }

    function count() external view returns (uint256) {
        return scheduled.length;
    }

    /// @notice Executes scheduled call `index` the way the network would at expiry, with the requested gas limit.
    function fire(uint256 index) external returns (bool ok, bytes memory ret) {
        Scheduled memory s = scheduled[index];
        require(block.timestamp >= s.expirySecond, "not yet");
        (ok, ret) = s.to.call{ gas: s.gasLimit }(s.callData);
    }
}
