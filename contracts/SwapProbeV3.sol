// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * SwapProbeV3
 *
 * Same purpose and same eth_call-plus-balance-override usage as
 * SwapProbe.sol - see that file's top comment for the full reasoning. This
 * is the Uniswap V3 equivalent, needed because V3 speaks a different
 * calldata dialect and has no simple pre-trade quote this contract can
 * compare a post-trade balance against (see the missing buyTaxBps/
 * sellTaxBps below).
 *
 * DIFFERENCES FROM SwapProbe.sol, READ BEFORE TRUSTING THIS:
 *
 *   - No separate buyTaxBps/sellTaxBps. V2's probe gets those by comparing
 *     router.getAmountsOut()'s promise against what actually arrived. V3 has
 *     no equivalent simple view-callable quote from inside a non-view
 *     function; QuoterV2's quote functions are their own can of worms
 *     (revert-encoded results, gas-estimate-only in older versions). This
 *     probe only reports roundTripLossBps (buy then sell, compare native
 *     ETH out to native ETH in), which folds tax, slippage, AND price
 *     impact into one number rather than separating them. Good enough to
 *     catch "this token cannot be sold" and "round-tripping this loses an
 *     absurd amount," not good enough to distinguish "high tax" from "thin
 *     liquidity."
 *   - Takes an explicit `fee` tier parameter. The caller (the keeper) has
 *     already decided which V3 pool to test by the time it calls this -
 *     this probe does not discover which fee tier has liquidity itself.
 *   - Wraps to WETH itself via deposit()/withdraw() rather than relying on
 *     the router's own ETH-handling, so this does not depend on exactly how
 *     (or whether) the deployed SwapRouter02 auto-wraps native value - see
 *     MultiVenueVault.sol's open question #2 on unverified router behavior.
 */

interface IWETH {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IV3Router {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
}

contract SwapProbeV3 {
    IV3Router public immutable router;
    IWETH public immutable weth;

    struct Result {
        bool buyOk;
        bool sellOk;
        uint256 actualOut;      // tokens received from the buy
        uint256 ethReturned;    // native ETH recovered from the sell
        uint256 roundTripLossBps;
    }

    constructor(address _router, address _weth) {
        router = IV3Router(_router);
        weth = IWETH(_weth);
    }

    /// Buys `token` on the given V3 fee tier with the ETH sent, then sells
    /// all of it back. Never reverts - every failure path returns a Result
    /// with the relevant *Ok flag false instead.
    function probe(address token, uint24 fee) external payable returns (Result memory r) {
        weth.deposit{value: msg.value}();
        weth.approve(address(router), msg.value);

        uint256 before = IERC20(token).balanceOf(address(this));
        try router.exactInputSingle(IV3Router.ExactInputSingleParams({
            tokenIn: address(weth),
            tokenOut: token,
            fee: fee,
            recipient: address(this),
            amountIn: msg.value,
            amountOutMinimum: 0,
            sqrtPriceLimitX96: 0
        })) returns (uint256) {
            r.buyOk = true;
        } catch {
            return r;
        }
        r.actualOut = IERC20(token).balanceOf(address(this)) - before;
        if (r.actualOut == 0) return r;

        try IERC20(token).approve(address(router), r.actualOut) {} catch { return r; }

        uint256 wethBefore = weth.balanceOf(address(this));
        try router.exactInputSingle(IV3Router.ExactInputSingleParams({
            tokenIn: token,
            tokenOut: address(weth),
            fee: fee,
            recipient: address(this),
            amountIn: r.actualOut,
            amountOutMinimum: 0,
            sqrtPriceLimitX96: 0
        })) returns (uint256) {
            r.sellOk = true;
        } catch {
            return r; // cannot sell. This is the honeypot signature.
        }
        uint256 wethGained = weth.balanceOf(address(this)) - wethBefore;

        weth.withdraw(wethGained);
        r.ethReturned = wethGained;

        if (msg.value > r.ethReturned) {
            r.roundTripLossBps = ((msg.value - r.ethReturned) * 10_000) / msg.value;
        }
    }

    receive() external payable {}
}
