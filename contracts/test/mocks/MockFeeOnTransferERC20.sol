// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./MockERC20.sol";

/// Test-only. Reproduces the exact shape of token this repo's own bug
/// history warns about: every transfer sends `taxBps` of the amount to
/// `sink` instead of `to`, on both the buy-out payout and the sell-in pull.
contract MockFeeOnTransferERC20 is MockERC20 {
    uint16 public immutable taxBps;
    address public immutable sink;

    constructor(string memory _name, string memory _symbol, uint16 _taxBps, address _sink)
        MockERC20(_name, _symbol)
    {
        taxBps = _taxBps;
        sink = _sink;
    }

    function _transfer(address from, address to, uint256 amount) internal override {
        require(balanceOf[from] >= amount, "balance");
        uint256 tax = (amount * taxBps) / 10_000;
        uint256 net = amount - tax;
        balanceOf[from] -= amount;
        balanceOf[to] += net;
        if (tax > 0) balanceOf[sink] += tax;
    }
}
