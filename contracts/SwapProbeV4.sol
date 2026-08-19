// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * SwapProbeV4
 *
 * Same purpose and same eth_call usage as SwapProbe.sol / SwapProbeV3.sol,
 * for Uniswap V4 pools. Two jobs:
 *
 *   quote(): price a swap without holding any funds at all. V4's flash
 *   accounting makes this clean - swap() only records debts, so the callback
 *   can run the swap, read the result, and revert with it encoded before
 *   ever settling. The revert unwinds everything; the caller decodes the
 *   answer out of the revert data. This is exactly how Uniswap's own V4
 *   quoter works, done here in-house so the keeper depends on one deployed
 *   address (this probe) instead of hunting down periphery deployments.
 *
 *   probe(): the honeypot check. A REAL buy then a REAL sell through the
 *   pool - hook code and token transfer hooks both execute - funded by
 *   eth_call value with a balance override, so it costs nothing and touches
 *   no real funds. Runs as two separate unlocks on purpose: if the sell leg
 *   were in the same unlock as the buy and reverted (the honeypot
 *   signature), the whole unlock would unwind and take the buy result with
 *   it. Separated, a sell failure leaves a clean "bought fine, cannot sell"
 *   verdict - which is the exact thing this probe exists to detect. A token
 *   that taxes transfers so the pool is shortchanged on settle() also shows
 *   up as a failed sell leg, which is the honest verdict: that token cannot
 *   actually be sold for what the pool quotes.
 *
 * The PONS caveat: launchpad pools carry a hook, and a hook sees this probe
 * coming no differently than a real trade, so what passes here is what a
 * real trade would experience AT THIS MOMENT. A hook that changes behaviour
 * later (time-gated sells, dynamic fees that spike) defeats any
 * point-in-time simulation. Read MultiVenueVaultV4.sol's risk notes.
 */

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IWETH {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IPoolManager {
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    struct SwapParams {
        bool zeroForOne;
        int256 amountSpecified;
        uint160 sqrtPriceLimitX96;
    }

    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData) external returns (int256 swapDelta);
    function sync(address currency) external;
    function settle() external payable returns (uint256 paid);
    function take(address currency, address to, uint256 amount) external;
}

contract SwapProbeV4 {
    IPoolManager public immutable poolManager;
    IWETH public immutable weth;

    uint160 private constant MIN_SQRT_PRICE = 4295128739;
    uint160 private constant MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342;

    // Distinguishes this probe's own quote-result revert from a genuine
    // failure inside the pool (no liquidity, hook rejection), which must
    // bubble to the caller as the failure it is.
    uint256 private constant QUOTE_MAGIC = 0x51554f5445563452; // "QUOTEV4R"

    uint8 private constant ACT_QUOTE = 0;
    uint8 private constant ACT_SWAP = 1;

    struct Result {
        bool buyOk;
        bool sellOk;
        uint256 actualOut;      // tokens received from the buy
        uint256 ethReturned;    // base (ETH-equivalent) recovered from the sell
        uint256 roundTripLossBps;
    }

    constructor(address _poolManager, address _weth) {
        poolManager = IPoolManager(_poolManager);
        weth = IWETH(_weth);
    }

    receive() external payable {}

    // ---- quote ----

    /// Prices an exact-input swap through the pool without funds. Reverts if
    /// the pool itself cannot serve the swap - callers treat any revert as
    /// "no usable venue here".
    function quote(IPoolManager.PoolKey calldata key, bool zeroForOne, uint256 amountIn)
        external returns (uint256 amountOut)
    {
        try poolManager.unlock(abi.encode(ACT_QUOTE, abi.encode(key, zeroForOne, amountIn))) {
            revert("quote must revert");
        } catch (bytes memory reason) {
            if (reason.length == 64) {
                (uint256 magic, uint256 out) = abi.decode(reason, (uint256, uint256));
                if (magic == QUOTE_MAGIC) return out;
            }
            // Not our marker: a real failure inside the pool. Re-raise it.
            assembly { revert(add(reason, 32), mload(reason)) }
        }
    }

    // ---- probe ----

    /// Buys the pool's non-base token with the ETH sent, then sells all of
    /// it back. Never reverts - failures come back as false flags.
    function probe(IPoolManager.PoolKey calldata key) external payable returns (Result memory r) {
        bool c0IsBase = key.currency0 == address(weth) || key.currency0 == address(0);
        bool c1IsBase = key.currency1 == address(weth) || key.currency1 == address(0);
        require(c0IsBase != c1IsBase, "pool must pair token with base");
        address token = c0IsBase ? key.currency1 : key.currency0;
        bool buyZeroForOne = c0IsBase;

        // Buy leg: its own unlock, so a failure leaves nothing half-settled.
        uint256 tokenBefore = IERC20(token).balanceOf(address(this));
        try poolManager.unlock(abi.encode(ACT_SWAP, abi.encode(key, buyZeroForOne, msg.value))) {
            r.buyOk = true;
        } catch {
            return r;
        }
        r.actualOut = IERC20(token).balanceOf(address(this)) - tokenBefore;
        if (r.actualOut == 0) return r;

        // Sell leg. Reverting here IS the honeypot signature.
        uint256 baseBefore = _baseBalance(key, c0IsBase);
        try poolManager.unlock(abi.encode(ACT_SWAP, abi.encode(key, !buyZeroForOne, r.actualOut))) {
            r.sellOk = true;
        } catch {
            return r;
        }
        r.ethReturned = _baseBalance(key, c0IsBase) - baseBefore;

        if (msg.value > r.ethReturned) {
            r.roundTripLossBps = ((msg.value - r.ethReturned) * 10_000) / msg.value;
        }
    }

    function _baseBalance(IPoolManager.PoolKey calldata key, bool c0IsBase) private view returns (uint256) {
        address baseCur = c0IsBase ? key.currency0 : key.currency1;
        return baseCur == address(0) ? address(this).balance : weth.balanceOf(address(this));
    }

    // ---- callback ----

    function unlockCallback(bytes calldata rawData) external returns (bytes memory) {
        require(msg.sender == address(poolManager), "not pool manager");
        (uint8 action, bytes memory payload) = abi.decode(rawData, (uint8, bytes));
        (IPoolManager.PoolKey memory key, bool zeroForOne, uint256 amountIn) =
            abi.decode(payload, (IPoolManager.PoolKey, bool, uint256));

        int256 delta = poolManager.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_PRICE + 1 : MAX_SQRT_PRICE - 1
            }),
            ""
        );

        int128 amount0 = int128(delta >> 128);
        int128 amount1 = int128(delta);
        int128 inDelta = zeroForOne ? amount0 : amount1;
        int128 outDelta = zeroForOne ? amount1 : amount0;
        require(inDelta < 0 && outDelta > 0, "degenerate swap");
        uint256 owed = uint256(uint128(-inDelta));
        uint256 got = uint256(uint128(outDelta));

        if (action == ACT_QUOTE) {
            // Answer found - abort the unlock before anything settles. The
            // revert data carries the result out; see quote() above.
            bytes memory result = abi.encode(QUOTE_MAGIC, got);
            assembly { revert(add(result, 32), mload(result)) }
        }

        // ACT_SWAP: settle for real.
        address inCur = zeroForOne ? key.currency0 : key.currency1;
        address outCur = zeroForOne ? key.currency1 : key.currency0;

        if (inCur == address(0)) {
            poolManager.settle{value: owed}();
        } else if (inCur == address(weth)) {
            // probe() holds native ETH from msg.value; wrap just enough.
            if (weth.balanceOf(address(this)) < owed) weth.deposit{value: owed}();
            poolManager.sync(inCur);
            require(weth.transfer(address(poolManager), owed), "weth transfer failed");
            poolManager.settle();
        } else {
            poolManager.sync(inCur);
            require(IERC20(inCur).transfer(address(poolManager), owed), "token transfer failed");
            poolManager.settle();
        }

        poolManager.take(outCur, address(this), got);
        return abi.encode(got);
    }
}
