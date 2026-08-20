// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./MockERC20.sol";
import "./AttackerExecutor.sol";

/// Test-only. An ERC20 whose transfer hook fires a callback the instant it
/// pays out to `watched` - the shape of a hostile launch-bot token that
/// tries to reenter the vault the moment it lands there mid-swap.
contract MaliciousReentrantToken is MockERC20 {
    address public watched;
    address public hook;

    constructor() MockERC20("Evil", "EVIL") {}

    function setHook(address _watched, address _hook) external {
        watched = _watched;
        hook = _hook;
    }

    function _transfer(address from, address to, uint256 amount) internal override {
        super._transfer(from, to, amount);
        if (hook != address(0) && to == watched) {
            address h = hook;
            hook = address(0); // one-shot: don't recurse regardless of what the callback does
            IReenterHook(h).onTokenReceived();
        }
    }
}
