// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * SwapProbe
 *
 * Deploy this once, then never send a transaction to it again. The keeper
 * calls it with eth_call plus a balance state override, so it costs nothing
 * and touches no real funds.
 *
 * WHY THIS EXISTS
 *
 * router.getAmountsOut() is pure constant-product arithmetic over the pair
 * reserves. It knows nothing about the token's transfer function. A token that
 * takes 20% on every transfer, or blocks selling entirely, quotes exactly the
 * same as a clean one. Every honeypot on PulseChain passes a quote check.
 *
 * The only reliable test is to actually perform a buy and a sell and compare
 * what came back against what was quoted. That is what this does.
 *
 *   deployed = new SwapProbe(ROUTER, WPLS)
 *
 *   eth_call({
 *     to: probe, from: anyAddress, value: 100000e18,
 *     data: probe.interface.encodeFunctionData("probe", [token]),
 *   }, "latest", { [anyAddress]: { balance: "0x..." } })
 */

interface IRouter {
    function swapExactETHForTokensSupportingFeeOnTransferTokens(
        uint256 amountOutMin, address[] calldata path, address to, uint256 deadline
    ) external payable;
    function swapExactTokensForETHSupportingFeeOnTransferTokens(
        uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline
    ) external;
    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external view returns (uint256[] memory);
}

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

contract SwapProbe {
    IRouter public immutable router;
    address public immutable wpls;

    struct Result {
        bool buyOk;
        bool sellOk;
        uint256 quotedOut;   // what getAmountsOut promised on the buy
        uint256 actualOut;   // what actually landed, tax included
        uint256 plsReturned; // what came back after selling everything
        uint256 buyTaxBps;
        uint256 sellTaxBps;
        uint256 roundTripLossBps;
    }

    constructor(address _router, address _wpls) {
        router = IRouter(_router);
        wpls = _wpls;
    }

    /// Buys `token` with the PLS sent, then sells all of it back. Never reverts.
    function probe(address token) external payable returns (Result memory r) {
        address[] memory buyPath = new address[](2);
        buyPath[0] = wpls;
        buyPath[1] = token;

        try router.getAmountsOut(msg.value, buyPath) returns (uint256[] memory q) {
            r.quotedOut = q[1];
        } catch {
            return r; // no pair, nothing else is meaningful
        }

        uint256 before = IERC20(token).balanceOf(address(this));
        try router.swapExactETHForTokensSupportingFeeOnTransferTokens{value: msg.value}(
            0, buyPath, address(this), block.timestamp + 600
        ) {
            r.buyOk = true;
        } catch {
            return r;
        }
        r.actualOut = IERC20(token).balanceOf(address(this)) - before;
        if (r.actualOut == 0) return r;

        // Gap between quoted and actual is the buy-side transfer tax.
        if (r.quotedOut > r.actualOut) {
            r.buyTaxBps = ((r.quotedOut - r.actualOut) * 10_000) / r.quotedOut;
        }

        address[] memory sellPath = new address[](2);
        sellPath[0] = token;
        sellPath[1] = wpls;

        uint256 quotedBack;
        try router.getAmountsOut(r.actualOut, sellPath) returns (uint256[] memory q2) {
            quotedBack = q2[1];
        } catch {}

        try IERC20(token).approve(address(router), r.actualOut) {} catch { return r; }

        uint256 plsBefore = address(this).balance;
        try router.swapExactTokensForETHSupportingFeeOnTransferTokens(
            r.actualOut, 0, sellPath, address(this), block.timestamp + 600
        ) {
            r.sellOk = true;
        } catch {
            return r; // cannot sell. This is the honeypot signature.
        }
        r.plsReturned = address(this).balance - plsBefore;

        if (quotedBack > r.plsReturned) {
            r.sellTaxBps = ((quotedBack - r.plsReturned) * 10_000) / quotedBack;
        }
        if (msg.value > r.plsReturned) {
            r.roundTripLossBps = ((msg.value - r.plsReturned) * 10_000) / msg.value;
        }
    }

    receive() external payable {}
}
