// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Min {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/**
 * Test-only. A minimal constant-product router+pool combined into one
 * contract, shaped to match the two IPulseXRouter functions BotVault calls
 * and nothing else. It is not a full Uniswap V2 reimplementation (no LP
 * tokens, no per-pair contracts) - it exists to give BotVault's tests a
 * router that prices trades the same way PulseX does, and that behaves
 * realistically against a fee-on-transfer token: it only ever credits what
 * it actually received, exactly like a real pair contract would.
 *
 * This is a same-shape stand-in for PulseX, not PulseX itself and not a fork
 * of PulseChain - this sandbox has no route to a live PulseChain RPC, so a
 * real fork test isn't possible here. Say so before calling anything tested
 * against this "tested against PulseChain".
 */
contract MockRouter {
    struct Pool {
        uint256 reserveA;
        uint256 reserveB;
        bool exists;
    }

    mapping(bytes32 => Pool) public pools;

    function _key(address tokenA, address tokenB) internal pure returns (bytes32) {
        (address t0, address t1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        return keccak256(abi.encodePacked(t0, t1));
    }

    function addLiquidity(address tokenA, uint256 amountA, address tokenB, uint256 amountB) external {
        require(IERC20Min(tokenA).transferFrom(msg.sender, address(this), amountA), "pull A failed");
        require(IERC20Min(tokenB).transferFrom(msg.sender, address(this), amountB), "pull B failed");
        bytes32 k = _key(tokenA, tokenB);
        Pool storage p = pools[k];
        if (tokenA < tokenB) {
            p.reserveA += amountA;
            p.reserveB += amountB;
        } else {
            p.reserveA += amountB;
            p.reserveB += amountA;
        }
        p.exists = true;
    }

    function _reserves(address tokenIn, address tokenOut)
        internal
        view
        returns (uint256 rIn, uint256 rOut, bytes32 k, bool inIsToken0)
    {
        k = _key(tokenIn, tokenOut);
        Pool memory p = pools[k];
        require(p.exists, "no pool");
        inIsToken0 = tokenIn < tokenOut;
        (rIn, rOut) = inIsToken0 ? (p.reserveA, p.reserveB) : (p.reserveB, p.reserveA);
    }

    function _setReserves(bytes32 k, bool inIsToken0, uint256 newIn, uint256 newOut) internal {
        Pool storage p = pools[k];
        if (inIsToken0) {
            p.reserveA = newIn;
            p.reserveB = newOut;
        } else {
            p.reserveB = newIn;
            p.reserveA = newOut;
        }
    }

    /// Standard Uniswap V2 pricing: 0.3% pool fee, constant product.
    function _amountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) internal pure returns (uint256) {
        uint256 amountInWithFee = amountIn * 997;
        uint256 numerator = amountInWithFee * reserveOut;
        uint256 denominator = reserveIn * 1000 + amountInWithFee;
        return numerator / denominator;
    }

    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts) {
        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        for (uint256 i; i + 1 < path.length; ++i) {
            (uint256 rIn, uint256 rOut, , ) = _reserves(path[i], path[i + 1]);
            amounts[i + 1] = _amountOut(amounts[i], rIn, rOut);
        }
    }

    /// Plain variant: prices every hop off the nominal amountIn and never
    /// checks what the pool actually received. This is why it reverts
    /// (rather than silently under-delivering) when the input token takes a
    /// transfer tax - the pool ends up short of what the math assumed it
    /// got, same as a real Uniswap V2 pair's K-invariant check failing.
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 /* deadline */
    ) external returns (uint256[] memory amounts) {
        uint256 beforeBal = IERC20Min(path[0]).balanceOf(address(this));
        require(IERC20Min(path[0]).transferFrom(msg.sender, address(this), amountIn), "pull failed");
        uint256 actuallyReceived = IERC20Min(path[0]).balanceOf(address(this)) - beforeBal;

        amounts = new uint256[](path.length);
        amounts[0] = amountIn; // priced off the nominal amount, exactly like the real router - it never checks this
        for (uint256 i; i + 1 < path.length; ++i) {
            (uint256 rIn, uint256 rOut, bytes32 k, bool inIsToken0) = _reserves(path[i], path[i + 1]);
            uint256 out = _amountOut(amounts[i], rIn, rOut);
            require(out > 0 && out < rOut, "insufficient liquidity");
            _setReserves(k, inIsToken0, rIn + amounts[i], rOut - out);
            amounts[i + 1] = out;
        }
        // A real pair's K-invariant check, done here for hop 0 since this
        // mock has no separate pair contract: if the input token took a cut
        // on the way in, the pool actually received less than the router
        // just priced the swap against, and the pool would be left insolvent.
        // This is exactly why BotVault can never use this variant to SELL a
        // taxed token - the tax bites on the leg going into the pool.
        require(actuallyReceived >= amountIn, "K");
        uint256 finalOut = amounts[amounts.length - 1];
        require(finalOut >= amountOutMin, "INSUFFICIENT_OUTPUT_AMOUNT");
        require(IERC20Min(path[path.length - 1]).transfer(to, finalOut), "payout failed");
    }

    /// Fee-on-transfer-safe variant: at every hop, measures what the pool
    /// actually received (and what the recipient actually gained) by balance
    /// difference rather than trusting nominal amounts - exactly the
    /// behaviour BotVault's own comments describe relying on.
    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 /* deadline */
    ) external {
        uint256 amount = _pullMeasured(path[0], msg.sender, amountIn);
        for (uint256 i; i + 1 < path.length; ++i) {
            (uint256 rIn, uint256 rOut, bytes32 k, bool inIsToken0) = _reserves(path[i], path[i + 1]);
            uint256 out = _amountOut(amount, rIn, rOut);
            require(out > 0 && out < rOut, "insufficient liquidity");
            _setReserves(k, inIsToken0, rIn + amount, rOut - out);
            address recipient = (i + 2 == path.length) ? to : address(this);
            uint256 beforeBal = IERC20Min(path[i + 1]).balanceOf(recipient);
            require(IERC20Min(path[i + 1]).transfer(recipient, out), "hop payout failed");
            uint256 afterBal = IERC20Min(path[i + 1]).balanceOf(recipient);
            amount = afterBal - beforeBal;
        }
        require(amount >= amountOutMin, "INSUFFICIENT_OUTPUT_AMOUNT");
    }

    function _pullMeasured(address token, address from, uint256 amount) internal returns (uint256 received) {
        uint256 beforeBal = IERC20Min(token).balanceOf(address(this));
        require(IERC20Min(token).transferFrom(from, address(this), amount), "pull failed");
        uint256 afterBal = IERC20Min(token).balanceOf(address(this));
        received = afterBal - beforeBal;
    }
}
