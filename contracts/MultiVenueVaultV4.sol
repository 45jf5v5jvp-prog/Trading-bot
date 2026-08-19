// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * =============================================================================
 * WHY THIS CONTRACT EXISTS (separate from MultiVenueVault.sol)
 * =============================================================================
 *
 * MultiVenueVault speaks V2 and V3. Uniswap V4 is a different animal again:
 * there are no per-pool contracts and no router requirement - everything is
 * one singleton PoolManager using flash accounting. A swap is: call
 * unlock(), get called back, call swap() (which only records debts), pay
 * what you owe with settle(), collect what you're owed with take(). Nothing
 * moves until settle/take. There is no way to bolt that onto the existing
 * vault - the vault itself must implement the unlock callback, so it needs
 * a new implementation and (because EIP-1167 clones are locked to their
 * implementation forever) a new factory. V2 and V3 entry points are carried
 * over unchanged so one vault can trade all three venues.
 *
 * WHY V4 MATTERS HERE: PONS - the launchpad where most of Robinhood Chain's
 * new tokens actually launch - creates V4 pools (with its own hook contract
 * attached). No V4 support means no PONS launches, which is most of the
 * chain's volume.
 *
 * V4-SPECIFIC RISKS, READ BEFORE TRUSTING THIS:
 *
 *   1. HOOKS. Every V4 pool carries a hook contract that runs arbitrary code
 *      before/after every swap. A hook can take fees, block one direction,
 *      or change behaviour over time. The keeper's probe simulates a full
 *      buy+sell round trip through the actual pool (hook included) before
 *      any buy, but a hook that behaves now and misbehaves later defeats
 *      that - same risk class as a token that enables a transfer tax after
 *      launch. Nothing on-chain here can prevent it; position sizing is the
 *      only real defence.
 *   2. NATIVE ETH POOLS. V4 pools commonly pair a token against native ETH
 *      (currency address 0x0), not WETH. This vault still accounts
 *      everything in WETH (baseToken): buys unwrap just-in-time inside the
 *      callback, sells wrap the ETH received before charges are taken. The
 *      vault therefore holds native ETH only transiently inside a swap.
 *   3. CUSTOM-CURVE HOOKS can legally consume a different input amount than
 *      asked. The callback settles only what the swap actually recorded and
 *      hard-caps it at the authorized amount, so a hook can never pull more
 *      out of the vault than the executor authorized for that trade.
 *   4. NOT AUDITED, same as every other contract in this repo.
 * =============================================================================
 */

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IWETH {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

interface IUniswapV2Router {
    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external;
}

/// SwapRouter02 shape - same as MultiVenueVault.sol, already live on chain.
interface IUniswapV3Router {
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

/// Uniswap V4 PoolManager, reduced to exactly what this vault calls.
/// Currency and BalanceDelta are user-defined value types over address and
/// int256 in v4-core, so plain address/int256 here ABI-encode identically.
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
        int256 amountSpecified; // negative = exact input (v4 convention)
        uint160 sqrtPriceLimitX96;
    }

    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData) external returns (int256 swapDelta);
    function sync(address currency) external;
    function settle() external payable returns (uint256 paid);
    function take(address currency, address to, uint256 amount) external;
}

library SafeTransfer {
    function safeTransfer(IERC20 t, address to, uint256 v) internal {
        (bool ok, bytes memory d) = address(t).call(abi.encodeWithSelector(t.transfer.selector, to, v));
        require(ok && (d.length == 0 || abi.decode(d, (bool))), "transfer failed");
    }
    function safeTransferFrom(IERC20 t, address f, address to, uint256 v) internal {
        (bool ok, bytes memory d) = address(t).call(abi.encodeWithSelector(t.transferFrom.selector, f, to, v));
        require(ok && (d.length == 0 || abi.decode(d, (bool))), "transferFrom failed");
    }
    function safeApprove(IERC20 t, address s, uint256 v) internal {
        (bool ok, bytes memory d) = address(t).call(abi.encodeWithSelector(t.approve.selector, s, v));
        require(ok && (d.length == 0 || abi.decode(d, (bool))), "approve failed");
    }
}

// ============================================================================
// MultiVenueVaultV4
// ============================================================================

contract MultiVenueVaultV4 {
    using SafeTransfer for IERC20;

    address public owner;
    address public executor;
    address public treasury;
    address public routerV2;      // Uniswap V2-shaped router
    address public routerV3;      // Uniswap V3 SwapRouter02
    address public poolManager;   // Uniswap V4 singleton
    address public baseToken;     // WETH. Charges always settle in this.
    uint16 public feeBps;
    bool public paused;
    bool private locked;

    // Armed only for the duration of one executeSwapV4 call. unlockCallback
    // refuses to run unless this is set AND the caller is the PoolManager -
    // belt and braces against anything else ever driving the callback.
    bool private inV4Swap;

    uint16 public constant MAX_FEE_BPS = 30; // 0.30% hard ceiling, unchangeable

    uint256 public maxGasFee;
    uint16 public maxGasFeeBps;
    uint256 public constant GAS_FEE_HARD_CAP = 500_000 ether;
    uint16 public constant GAS_FEE_HARD_CAP_BPS = 2_000;
    uint256 public maxTradeSize;
    uint256 public minInterval;
    uint256 public lastTradeAt;

    // TickMath bounds from v4-core (identical values to V3). The swap always
    // passes the widest possible limit - the amountOutMin check is the real
    // slippage guard, same discipline as the V2/V3 paths.
    uint160 private constant MIN_SQRT_PRICE = 4295128739;
    uint160 private constant MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342;

    mapping(address => bool) public allowedToken;

    event Deposited(address indexed token, uint256 amount);
    event Withdrawn(address indexed token, uint256 amount);
    event Traded(address indexed tokenIn, address indexed tokenOut, uint8 venue, uint256 amountIn, uint256 amountOut, uint256 fee, uint256 gasFee);
    event ExecutorChanged(address indexed from, address indexed to);
    event Paused(bool state);

    error NotOwner();
    error NotExecutor();
    error IsPaused();
    error Reentrant();
    error NotPoolManager();

    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }
    modifier onlyExecutor() { if (msg.sender != executor) revert NotExecutor(); _; }
    modifier live() { if (paused) revert IsPaused(); _; }
    modifier nonReentrant() { if (locked) revert Reentrant(); locked = true; _; locked = false; }

    function initialize(
        address _owner,
        address _executor,
        address _treasury,
        address _routerV2,
        address _routerV3,
        address _poolManager,
        address _baseToken,
        uint16 _feeBps,
        address[] calldata _tokens
    ) external {
        require(owner == address(0), "already initialized");
        require(_feeBps <= MAX_FEE_BPS, "fee above ceiling");
        owner = _owner;
        executor = _executor;
        treasury = _treasury;
        routerV2 = _routerV2;
        routerV3 = _routerV3;
        poolManager = _poolManager;
        baseToken = _baseToken;
        feeBps = _feeBps;
        allowedToken[_baseToken] = true;
        maxTradeSize = type(uint256).max;
        maxGasFee = 50_000 ether;
        maxGasFeeBps = 300;
        for (uint256 i; i < _tokens.length; ++i) allowedToken[_tokens[i]] = true;
    }

    // Native ETH passes through this vault in exactly two legitimate ways:
    // WETH.withdraw() paying out during a V4 buy against a native pool, and
    // PoolManager.take() delivering sell proceeds. Both wrap/consume it in
    // the same transaction. Anything else that lands here is recoverable by
    // the owner via sweepNative, never stranded.
    receive() external payable {}

    // ---- Owner controls. Identical to MultiVenueVault.sol. ----

    function deposit(address token, uint256 amount) external {
        require(allowedToken[token], "token not allowed");
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(token, amount);
    }

    function withdraw(address token, uint256 amount) external onlyOwner nonReentrant {
        IERC20(token).safeTransfer(owner, amount);
        emit Withdrawn(token, amount);
    }

    function withdrawAll(address[] calldata tokens) external onlyOwner nonReentrant {
        for (uint256 i; i < tokens.length; ++i) {
            uint256 bal = IERC20(tokens[i]).balanceOf(address(this));
            if (bal > 0) {
                IERC20(tokens[i]).safeTransfer(owner, bal);
                emit Withdrawn(tokens[i], bal);
            }
        }
    }

    /// Rescues native ETH that somehow got stranded (a partial V4 flow, a
    /// selfdestruct donation). Normal operation never leaves any here.
    function sweepNative() external onlyOwner nonReentrant {
        uint256 bal = address(this).balance;
        if (bal > 0) {
            (bool ok, ) = owner.call{value: bal}("");
            require(ok, "native transfer failed");
            emit Withdrawn(address(0), bal);
        }
    }

    function revokeExecutor() external onlyOwner {
        emit ExecutorChanged(executor, address(0));
        executor = address(0);
    }

    function setExecutor(address e) external onlyOwner {
        emit ExecutorChanged(executor, e);
        executor = e;
    }

    function setPaused(bool p) external onlyOwner {
        paused = p;
        emit Paused(p);
    }

    function setLimits(uint256 _maxTradeSize, uint256 _minInterval) external onlyOwner {
        maxTradeSize = _maxTradeSize;
        minInterval = _minInterval;
    }

    function setGasPolicy(uint256 absolute, uint16 bps) external onlyOwner {
        require(absolute <= GAS_FEE_HARD_CAP, "above hard cap");
        require(bps <= GAS_FEE_HARD_CAP_BPS, "above hard cap bps");
        maxGasFee = absolute;
        maxGasFeeBps = bps;
    }

    function lowerFee(uint16 newFeeBps) external onlyOwner {
        require(newFeeBps < feeBps, "can only lower");
        feeBps = newFeeBps;
    }

    // ---- Shared path/charge logic, identical to MultiVenueVault.sol. ----

    function _checkPath(address tokenIn, address tokenOut) private view {
        bool spendingApproved = allowedToken[tokenIn];
        bool exitingToBase = tokenOut == baseToken;
        require(spendingApproved || exitingToBase, "path not permitted");
    }

    function _settleCharges(address tokenIn, uint256 amountIn, uint256 gasFee)
        private returns (bool payingIn, uint256 swapAmount, uint256 fee)
    {
        require(gasFee <= maxGasFee, "gas above your ceiling");
        payingIn = tokenIn == baseToken;
        if (payingIn) require(gasFee <= (amountIn * maxGasFeeBps) / 10_000, "gas above your share limit");
        fee = (amountIn * feeBps) / 10_000;
        swapAmount = amountIn;
        if (payingIn) {
            swapAmount = amountIn - fee - gasFee;
            require(swapAmount > 0, "charges exceed trade size");
            if (fee + gasFee > 0) IERC20(tokenIn).safeTransfer(treasury, fee + gasFee);
        }
    }

    function _settleSellCharges(uint256 amountOut, uint256 gasFee) private returns (uint256 netOut, uint256 fee) {
        require(gasFee <= (amountOut * maxGasFeeBps) / 10_000, "gas above your share limit");
        fee = (amountOut * feeBps) / 10_000;
        require(fee + gasFee < amountOut, "charges exceed proceeds");
        IERC20(baseToken).safeTransfer(treasury, fee + gasFee);
        netOut = amountOut - fee - gasFee;
    }

    // ---- V2 and V3 entry points, carried over verbatim from
    // MultiVenueVault.sol so one vault can trade every venue. ----

    function executeSwapV2(
        address[] calldata path,
        uint256 amountIn,
        uint256 amountOutMin,
        uint256 gasFee
    ) external onlyExecutor live nonReentrant returns (uint256 amountOut) {
        require(path.length >= 2, "bad path");
        require(amountIn > 0 && amountIn <= maxTradeSize, "size out of bounds");
        require(block.timestamp >= lastTradeAt + minInterval, "cooldown");
        _checkPath(path[0], path[path.length - 1]);
        for (uint256 i = 1; i + 1 < path.length; ++i)
            require(allowedToken[path[i]], "hop token not allowed");

        lastTradeAt = block.timestamp;
        address tokenIn = path[0];
        address tokenOut = path[path.length - 1];

        (bool payingIn, uint256 swapAmount, uint256 fee) = _settleCharges(tokenIn, amountIn, gasFee);

        IERC20(tokenIn).safeApprove(routerV2, 0);
        IERC20(tokenIn).safeApprove(routerV2, swapAmount);

        uint256 before = IERC20(tokenOut).balanceOf(address(this));
        IUniswapV2Router(routerV2).swapExactTokensForTokensSupportingFeeOnTransferTokens(
            swapAmount, amountOutMin, path, address(this), block.timestamp + 300
        );
        amountOut = IERC20(tokenOut).balanceOf(address(this)) - before;
        require(amountOut >= amountOutMin, "slippage");

        if (!payingIn) {
            require(tokenOut == baseToken, "sell must settle in base token");
            (amountOut, fee) = _settleSellCharges(amountOut, gasFee);
        }

        IERC20(tokenIn).safeApprove(routerV2, 0);
        emit Traded(tokenIn, tokenOut, 2, amountIn, amountOut, fee, gasFee);
    }

    function executeSwapV3(
        address tokenIn,
        address tokenOut,
        uint24 fee_,
        uint256 amountIn,
        uint256 amountOutMin,
        uint256 gasFee
    ) external onlyExecutor live nonReentrant returns (uint256 amountOut) {
        require(amountIn > 0 && amountIn <= maxTradeSize, "size out of bounds");
        require(block.timestamp >= lastTradeAt + minInterval, "cooldown");
        _checkPath(tokenIn, tokenOut);

        lastTradeAt = block.timestamp;

        (bool payingIn, uint256 swapAmount, uint256 fee) = _settleCharges(tokenIn, amountIn, gasFee);

        IERC20(tokenIn).safeApprove(routerV3, 0);
        IERC20(tokenIn).safeApprove(routerV3, swapAmount);

        uint256 before = IERC20(tokenOut).balanceOf(address(this));
        IUniswapV3Router(routerV3).exactInputSingle(IUniswapV3Router.ExactInputSingleParams({
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            fee: fee_,
            recipient: address(this),
            amountIn: swapAmount,
            amountOutMinimum: amountOutMin,
            sqrtPriceLimitX96: 0
        }));
        amountOut = IERC20(tokenOut).balanceOf(address(this)) - before;
        require(amountOut >= amountOutMin, "slippage");

        if (!payingIn) {
            require(tokenOut == baseToken, "sell must settle in base token");
            (amountOut, fee) = _settleSellCharges(amountOut, gasFee);
        }

        IERC20(tokenIn).safeApprove(routerV3, 0);
        emit Traded(tokenIn, tokenOut, 3, amountIn, amountOut, fee, gasFee);
    }

    // ---- V4 ----

    struct V4CallbackData {
        IPoolManager.PoolKey key;
        bool zeroForOne;
        uint256 swapAmount;
        address inCurrency;   // address(0) = native ETH
        address outCurrency;  // address(0) = native ETH
    }

    /**
     * @param key  The exact PoolKey the pool was initialized with (both
     *             currencies, fee, tickSpacing, hooks). The keeper records it
     *             from the pool's Initialize event - there is no on-chain
     *             discovery here, same division of labour as the V3 fee tier.
     * @param buy  true = spend baseToken for the pool's other token,
     *             false = sell that token back into baseToken.
     *
     * The pool must pair the token against baseToken or native ETH. Either
     * way every amount entering or leaving this function is denominated in
     * WETH: a native-pool buy unwraps just-in-time inside the callback, a
     * native-pool sell wraps what take() delivered before charges are taken.
     */
    function executeSwapV4(
        IPoolManager.PoolKey calldata key,
        bool buy,
        uint256 amountIn,
        uint256 amountOutMin,
        uint256 gasFee
    ) external onlyExecutor live nonReentrant returns (uint256 amountOut) {
        require(amountIn > 0 && amountIn <= maxTradeSize, "size out of bounds");
        require(block.timestamp >= lastTradeAt + minInterval, "cooldown");

        (address baseCur, address token) = _poolSides(key);
        _checkPath(buy ? baseToken : token, buy ? token : baseToken);

        lastTradeAt = block.timestamp;

        (bool payingIn, uint256 swapAmount, uint256 fee) =
            _settleCharges(buy ? baseToken : token, amountIn, gasFee);

        amountOut = _runV4Swap(key, buy, baseCur, token, swapAmount);
        require(amountOut >= amountOutMin, "slippage");

        if (!payingIn) {
            (amountOut, fee) = _settleSellCharges(amountOut, gasFee);
        }

        emit Traded(buy ? baseToken : token, buy ? token : baseToken, 4, amountIn, amountOut, fee, gasFee);
    }

    /// The pool must pair one currency this vault can account in (baseToken
    /// or native ETH, which the swap flow wraps/unwraps) against the token
    /// being traded. A WETH/native pool has no token side and is rejected.
    function _poolSides(IPoolManager.PoolKey calldata key) private view returns (address baseCur, address token) {
        bool c0IsBase = key.currency0 == baseToken || key.currency0 == address(0);
        bool c1IsBase = key.currency1 == baseToken || key.currency1 == address(0);
        require(c0IsBase != c1IsBase, "pool must pair token with base");
        baseCur = c0IsBase ? key.currency0 : key.currency1;
        token = c0IsBase ? key.currency1 : key.currency0;
    }

    /// Output measured by balance difference, never by what the pool
    /// reports - a taxed token can shave the take() transfer. For a
    /// native-pool sell the callback wraps before returning, so the
    /// difference is always visible on an ERC20 balance.
    function _runV4Swap(
        IPoolManager.PoolKey calldata key,
        bool buy,
        address baseCur,
        address token,
        uint256 swapAmount
    ) private returns (uint256 amountOut) {
        V4CallbackData memory cb = V4CallbackData({
            key: key,
            zeroForOne: buy ? (baseCur == key.currency0) : (token == key.currency0),
            swapAmount: swapAmount,
            inCurrency: buy ? baseCur : token,
            outCurrency: buy ? token : baseCur
        });

        address measured = buy ? token : baseToken;
        uint256 before = IERC20(measured).balanceOf(address(this));

        inV4Swap = true;
        IPoolManager(poolManager).unlock(abi.encode(cb));
        inV4Swap = false;

        amountOut = IERC20(measured).balanceOf(address(this)) - before;
    }

    /// PoolManager calls back into the unlock() caller, and nothing else can:
    /// the manager only ever calls the address that called unlock, and this
    /// only runs while executeSwapV4 has armed it.
    function unlockCallback(bytes calldata rawData) external returns (bytes memory) {
        if (msg.sender != poolManager) revert NotPoolManager();
        require(inV4Swap, "not in a swap");

        V4CallbackData memory d = abi.decode(rawData, (V4CallbackData));

        int256 delta = IPoolManager(poolManager).swap(
            d.key,
            IPoolManager.SwapParams({
                zeroForOne: d.zeroForOne,
                amountSpecified: -int256(d.swapAmount), // negative = exact input
                sqrtPriceLimitX96: d.zeroForOne ? MIN_SQRT_PRICE + 1 : MAX_SQRT_PRICE - 1
            }),
            ""
        );

        // BalanceDelta packs amount0 in the high 128 bits, amount1 in the
        // low 128. Negative = this vault owes the pool, positive = the pool
        // owes this vault.
        int128 amount0 = int128(delta >> 128);
        int128 amount1 = int128(delta);
        int128 inDelta = d.zeroForOne ? amount0 : amount1;
        int128 outDelta = d.zeroForOne ? amount1 : amount0;

        require(inDelta < 0, "swap consumed nothing");
        uint256 owed = uint256(uint128(-inDelta));
        // A custom-curve hook may legally consume less than asked, never
        // more - more would mean the hook is reaching deeper into this vault
        // than the executor authorized. Refuse.
        require(owed <= d.swapAmount, "hook demanded more than authorized");
        require(outDelta > 0, "swap produced nothing");
        uint256 got = uint256(uint128(outDelta));

        // Pay what the swap recorded.
        if (d.inCurrency == address(0)) {
            IWETH(baseToken).withdraw(owed);
            IPoolManager(poolManager).settle{value: owed}();
        } else {
            IPoolManager(poolManager).sync(d.inCurrency);
            IERC20(d.inCurrency).safeTransfer(poolManager, owed);
            IPoolManager(poolManager).settle();
        }

        // Collect what the swap owes, always to this vault and nowhere else.
        IPoolManager(poolManager).take(d.outCurrency, address(this), got);
        if (d.outCurrency == address(0)) {
            IWETH(baseToken).deposit{value: got}();
        }

        return abi.encode(got);
    }
}

// ============================================================================
// MultiVenueVaultV4Factory
// ============================================================================

/// Same EIP-1167 minimal-proxy pattern as the earlier factories.
contract MultiVenueVaultV4Factory {
    address public immutable implementation;
    address public owner;
    address public executor;
    address public treasury;
    address public routerV2;
    address public routerV3;
    address public poolManager;
    address public baseToken;
    uint16 public feeBps;

    mapping(address => address) public vaultOf;
    address[] public allVaults;

    event VaultCreated(address indexed user, address vault);

    constructor(
        address _impl, address _executor, address _treasury,
        address _routerV2, address _routerV3, address _poolManager,
        address _baseToken, uint16 _feeBps
    ) {
        require(_feeBps <= 30, "fee above ceiling");
        implementation = _impl;
        owner = msg.sender;
        executor = _executor;
        treasury = _treasury;
        routerV2 = _routerV2;
        routerV3 = _routerV3;
        poolManager = _poolManager;
        baseToken = _baseToken;
        feeBps = _feeBps;
    }

    function createVault(address[] calldata tokens) external returns (address vault) {
        require(vaultOf[msg.sender] == address(0), "vault exists");
        vault = _clone(implementation);
        MultiVenueVaultV4(payable(vault)).initialize(
            msg.sender, executor, treasury, routerV2, routerV3, poolManager, baseToken, feeBps, tokens
        );
        vaultOf[msg.sender] = vault;
        allVaults.push(vault);
        emit VaultCreated(msg.sender, vault);
    }

    function vaultCount() external view returns (uint256) { return allVaults.length; }

    function _clone(address impl) private returns (address instance) {
        bytes20 target = bytes20(impl);
        assembly {
            let ptr := mload(0x40)
            mstore(ptr, 0x3d602d80600a3d3981f3363d3d373d3d3d363d73000000000000000000000000)
            mstore(add(ptr, 0x14), target)
            mstore(add(ptr, 0x28), 0x5af43d82803e903d91602b57fd5bf30000000000000000000000000000000000)
            instance := create(0, ptr, 0x37)
        }
        require(instance != address(0), "clone failed");
    }
}
