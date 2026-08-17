// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * =============================================================================
 * WHY THIS CONTRACT EXISTS (separate from BotVault.sol)
 * =============================================================================
 *
 * BotVault.sol only knows how to call a Uniswap V2-shaped router
 * (swapExactTokensForTokens with an address[] path). Uniswap V3 speaks a
 * completely different dialect - exactInputSingle takes a struct with an
 * explicit fee tier and no fee-on-transfer-tolerant variant at all. That is
 * not a detail you can bolt onto the existing function; it needs its own
 * entry point.
 *
 * Existing vaults are EIP-1167 clones locked forever to BotVault's
 * implementation address - they cannot gain V3 support retroactively, and
 * this file does not try to change that. This is a NEW implementation for
 * NEW vaults, deployed behind a new VaultFactory. Same owner/executor split,
 * same "executor can swap, only owner can withdraw" invariant, same
 * balance-diff output measurement - none of that changes. What is new is a
 * second swap entry point that speaks V3's calldata shape and a router
 * pointer for each venue.
 *
 * UNVERIFIED / OPEN QUESTIONS AT THE TIME THIS WAS WRITTEN - resolve before
 * deploying this with real funds:
 *
 *   1. Uniswap V3 pools do not tolerate fee-on-transfer tokens the way V2
 *      does - there is no "SupportingFeeOnTransferTokens" equivalent for
 *      exactInputSingle. A token with a transfer tax may simply be
 *      untradeable through this path, reverting on buy or sell. That is the
 *      exact "buying works, selling reverts, position stuck forever" bug
 *      pattern this project has already hit three times on V2 - do not
 *      assume V3 support closes that gap for hostile/taxed launch tokens.
 *      It may not be able to.
 *   2. The exact ExactInputSingleParams struct shape differs between the
 *      original SwapRouter and SwapRouter02 (SwapRouter02 dropped the
 *      `deadline` field). This file assumes the SwapRouter02 shape - verify
 *      that matches whatever router is actually deployed on Robinhood Chain
 *      before trusting this compiles/works against it.
 *   3. NOT AUDITED, same as BotVault.sol. Budget for a real review before
 *      this holds anyone's money but your own test funds.
 * =============================================================================
 */

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
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

/// SwapRouter02 shape (no `deadline` field - unlike the original SwapRouter).
/// Verify this against the actual deployed router before trusting it - see
/// open question #2 above.
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
// MultiVenueVault
// ============================================================================

contract MultiVenueVault {
    using SafeTransfer for IERC20;

    address public owner;
    address public executor;
    address public treasury;
    address public routerV2;    // Uniswap V2-shaped router
    address public routerV3;    // Uniswap V3 SwapRouter02
    address public baseToken;   // WETH. Charges always settle in this.
    uint16 public feeBps;
    bool public paused;
    bool private locked;

    uint16 public constant MAX_FEE_BPS = 30; // 0.30% hard ceiling, unchangeable

    // Same reasoning as BotVault.sol's gas reimbursement - see that file's
    // comments. Unchanged here, just duplicated since this is a standalone
    // implementation contract, not an inheriting one.
    uint256 public maxGasFee;
    uint16 public maxGasFeeBps;
    uint256 public constant GAS_FEE_HARD_CAP = 500_000 ether;
    uint16 public constant GAS_FEE_HARD_CAP_BPS = 2_000;
    uint256 public maxTradeSize;
    uint256 public minInterval;
    uint256 public lastTradeAt;

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
        baseToken = _baseToken;
        feeBps = _feeBps;
        allowedToken[_baseToken] = true;
        maxTradeSize = type(uint256).max;
        maxGasFee = 50_000 ether;
        maxGasFeeBps = 300;
        for (uint256 i; i < _tokens.length; ++i) allowedToken[_tokens[i]] = true;
    }

    // ---- Owner controls. Identical to BotVault.sol - see that file for the
    // reasoning behind each of these; unchanged here. ----

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

    // ---- Executor. Can move funds through an allowed venue and nowhere
    // else. Same path-permission logic as BotVault.sol's executeSwap,
    // extracted here so both venues share exactly one copy of it instead of
    // two copies that could quietly drift apart. ----

    function _checkPath(address tokenIn, address tokenOut) private view {
        bool spendingApproved = allowedToken[tokenIn];
        bool exitingToBase = tokenOut == baseToken;
        require(spendingApproved || exitingToBase, "path not permitted");
    }

    /// Charges (fee + gas) always settle in baseToken - skimmed from the
    /// input when buying, from the proceeds when selling. Same reasoning as
    /// BotVault.sol's executeSwap; extracted so both venues share it.
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
        // Fee-on-transfer-tolerant variant, same reasoning as BotVault.sol -
        // never the plain one, see that file's comment on why.
        IUniswapV2Router(routerV2).swapExactTokensForTokensSupportingFeeOnTransferTokens(
            swapAmount, amountOutMin, path, address(this), block.timestamp + 300
        );
        amountOut = IERC20(tokenOut).balanceOf(address(this)) - before;
        require(amountOut >= amountOutMin, "slippage");

        if (!payingIn) {
            require(tokenOut == baseToken, "sell must settle in base token");
            require(gasFee <= (amountOut * maxGasFeeBps) / 10_000, "gas above your share limit");
            uint256 outFee = (amountOut * feeBps) / 10_000;
            require(outFee + gasFee < amountOut, "charges exceed proceeds");
            IERC20(tokenOut).safeTransfer(treasury, outFee + gasFee);
            amountOut -= (outFee + gasFee);
            fee = outFee;
        }

        IERC20(tokenIn).safeApprove(routerV2, 0);
        emit Traded(tokenIn, tokenOut, 2, amountIn, amountOut, fee, gasFee);
    }

    /**
     * @param fee_ V3 pool fee tier (500 = 0.05%, 3000 = 0.3%, 10000 = 1%).
     *             The keeper picks whichever tier actually has liquidity -
     *             this contract does not discover that itself.
     *
     * Single-hop only, deliberately. Multi-hop V3 paths (exactInput with an
     * encoded byte path) add real attack surface for what a freshly-launched
     * token needs - it only ever has to reach or leave baseToken directly.
     *
     * See this file's top-level comment (open question #1) before trusting
     * this with a token that has a transfer tax - V3 may simply reject it.
     */
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
        // Measured by balance difference, same discipline as the V2 path -
        // never trust a router's returned amountOut, since a taxed
        // tokenOut could still take a cut on the way to this contract even
        // if the router itself reports a clean figure.
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
            require(gasFee <= (amountOut * maxGasFeeBps) / 10_000, "gas above your share limit");
            uint256 outFee = (amountOut * feeBps) / 10_000;
            require(outFee + gasFee < amountOut, "charges exceed proceeds");
            IERC20(tokenOut).safeTransfer(treasury, outFee + gasFee);
            amountOut -= (outFee + gasFee);
            fee = outFee;
        }

        IERC20(tokenIn).safeApprove(routerV3, 0);
        emit Traded(tokenIn, tokenOut, 3, amountIn, amountOut, fee, gasFee);
    }
}

// ============================================================================
// MultiVenueVaultFactory
// ============================================================================

/// Same EIP-1167 minimal-proxy pattern as VaultFactory in BotVault.sol - see
/// that file for why per-user vaults instead of a shared pool.
contract MultiVenueVaultFactory {
    address public immutable implementation;
    address public owner;
    address public executor;
    address public treasury;
    address public routerV2;
    address public routerV3;
    uint16 public feeBps;

    mapping(address => address) public vaultOf;
    address[] public allVaults;

    event VaultCreated(address indexed user, address vault);

    address public baseToken;

    constructor(
        address _impl, address _executor, address _treasury,
        address _routerV2, address _routerV3, address _baseToken, uint16 _feeBps
    ) {
        require(_feeBps <= 30, "fee above ceiling");
        implementation = _impl;
        owner = msg.sender;
        executor = _executor;
        treasury = _treasury;
        routerV2 = _routerV2;
        routerV3 = _routerV3;
        baseToken = _baseToken;
        feeBps = _feeBps;
    }

    function createVault(address[] calldata tokens) external returns (address vault) {
        require(vaultOf[msg.sender] == address(0), "vault exists");
        vault = _clone(implementation);
        MultiVenueVault(vault).initialize(msg.sender, executor, treasury, routerV2, routerV3, baseToken, feeBps, tokens);
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
