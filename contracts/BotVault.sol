// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * =============================================================================
 * WHY THIS CONTRACT EXISTS
 * =============================================================================
 *
 * Hyperliquid has builder codes: a protocol-level hook that pays a front-end a
 * fee on every routed order. PulseX has no such thing. It is a Uniswap V2 fork
 * and its router has no fee-recipient parameter.
 *
 * So the fee has to come from a contract you deploy in front of the router.
 * The user's capital sits in a vault. Your keeper can tell the vault to swap.
 * The vault skims your fee and forwards the rest to PulseX.
 *
 * The security property that matters, and the one you must never weaken:
 *
 *     THE EXECUTOR CAN SWAP. ONLY THE OWNER CAN WITHDRAW.
 *
 * If your keeper server is compromised, an attacker can churn a user's funds
 * through swaps and burn them on fees and slippage. That is bad. What they
 * cannot do is move a single token to an address the user did not choose.
 * Keep that line intact and this is a tool. Cross it and you are a custodian,
 * with everything that implies legally.
 *
 * NOT AUDITED. Do not deploy this holding other people's money until a firm
 * has reviewed it. Budget $15k to $40k for a vault and router of this size.
 * =============================================================================
 */

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IPulseXRouter {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);

    /// Tolerates tokens that take a cut on transfer. Returns nothing, so the
    /// caller must measure the output by balance difference.
    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external;
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
// BotVault
// ============================================================================

contract BotVault {
    using SafeTransfer for IERC20;

    address public owner;
    address public executor;   // your keeper. Swap only.
    address public treasury;   // where your fee lands
    address public router;     // PulseX router
    address public baseToken;  // WPLS. The token charges are always settled in.
    uint16 public feeBps;      // your cut, capped at construction
    bool public paused;
    bool private locked;

    uint16 public constant MAX_FEE_BPS = 30; // 0.30% hard ceiling, unchangeable

    /**
     * GAS REIMBURSEMENT
     *
     * The keeper sends the transaction, so by default the keeper pays the gas.
     * On PulseChain a vault swap costs roughly 300 to 500 PLS. A 0.15% platform
     * fee on a 25,000 PLS trade earns 38 PLS. Left as-is the operator loses
     * money on every small trade and the loss grows with adoption, which is
     * exactly backwards.
     *
     * So the trade reimburses its own gas, in WPLS, out of the vault. Two caps
     * apply and both must hold, so a compromised keeper cannot bleed a vault by
     * claiming enormous gas:
     *   - an absolute ceiling the owner sets
     *   - never more than 1% of the trade
     */
    /**
     * Gas on PulseChain is not stable. During a launch or heavy volume the
     * price spikes and a transaction that does not bid up simply sits in the
     * mempool, which for a sniper is the same as not trading at all. Spikes of
     * 20,000 PLS and beyond happen.
     *
     * So both ceilings belong to the owner, not to us. They set what they are
     * willing to pay to get a transaction through, and the contract enforces it.
     * The constants below only stop a compromised keeper draining a vault
     * through absurd gas claims. They are not a view on what gas should cost.
     */
    // Set in initialize(), NOT as inline defaults. Vaults are EIP-1167 clones
    // and a clone never runs this contract's constructor, so an inline field
    // initializer would leave these at 0 on every real vault. At 0 the gas
    // ceiling rejects every reimbursement and the keeper's trades all revert
    // with "gas above your ceiling", so the bot would silently never fire.
    uint256 public maxGasFee;      // owner's ceiling per trade
    uint16 public maxGasFeeBps;    // and never more than this share of a trade
    uint256 public constant GAS_FEE_HARD_CAP = 500_000 ether; // absolute backstop
    uint16 public constant GAS_FEE_HARD_CAP_BPS = 2_000;      // 20%, absolute backstop
    uint256 public maxTradeSize;             // owner's per-trade limit
    uint256 public minInterval;              // owner's cooldown, seconds
    uint256 public lastTradeAt;

    mapping(address => bool) public allowedToken;

    event Deposited(address indexed token, uint256 amount);
    event Withdrawn(address indexed token, uint256 amount);
    event Traded(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut, uint256 fee, uint256 gasFee);
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
        address _router,
        address _baseToken,
        uint16 _feeBps,
        address[] calldata _tokens
    ) external {
        require(owner == address(0), "already initialized");
        require(_feeBps <= MAX_FEE_BPS, "fee above ceiling");
        owner = _owner;
        executor = _executor;
        treasury = _treasury;
        router = _router;
        baseToken = _baseToken;
        feeBps = _feeBps;
        allowedToken[_baseToken] = true;
        maxTradeSize = type(uint256).max;
        maxGasFee = 50_000 ether;   // owner's ceiling per trade, bounded by GAS_FEE_HARD_CAP
        maxGasFeeBps = 300;         // 3% of a trade, bounded by GAS_FEE_HARD_CAP_BPS
        for (uint256 i; i < _tokens.length; ++i) allowedToken[_tokens[i]] = true;
    }

    // ---- Owner controls. The user is always in charge of their own money. ----

    function deposit(address token, uint256 amount) external {
        require(allowedToken[token], "token not allowed");
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(token, amount);
    }

    /// The only exit. Funds can go nowhere except to the owner.
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

    /// Kills the bot instantly. Deliberately has no timelock.
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

    /**
     * The owner decides how hard to bid for inclusion. Raise it before a launch
     * you care about, lower it for patient rule trading. Both settings are
     * still bounded by the hard caps above.
     */
    function setGasPolicy(uint256 absolute, uint16 bps) external onlyOwner {
        require(absolute <= GAS_FEE_HARD_CAP, "above hard cap");
        require(bps <= GAS_FEE_HARD_CAP_BPS, "above hard cap bps");
        maxGasFee = absolute;
        maxGasFeeBps = bps;
    }

    /// The owner can lower your fee to zero but never raise it. One-way ratchet
    /// in the user's favour, so a compromised factory cannot inflate fees.
    function lowerFee(uint16 newFeeBps) external onlyOwner {
        require(newFeeBps < feeBps, "can only lower");
        feeBps = newFeeBps;
    }

    // ---- Executor. Can move funds through PulseX and nowhere else. ----

    /**
     * @param path      Swap route. Every hop must be an allowed token.
     * @param amountIn  Input amount, bounded by the owner's maxTradeSize.
     * @param amountOutMin Slippage floor. The keeper computes this; the owner's
     *                     configured tolerance should already be baked in.
     */
    /**
     * @param gasFee Reimbursement for the keeper's gas, denominated in the
     *               input token. Capped absolutely and as a share of the trade.
     */
    function executeSwap(
        address[] calldata path,
        uint256 amountIn,
        uint256 amountOutMin,
        uint256 gasFee
    ) external onlyExecutor live nonReentrant returns (uint256 amountOut) {
        require(path.length >= 2, "bad path");
        require(amountIn > 0, "zero amount");
        require(block.timestamp >= lastTradeAt + minInterval, "cooldown");
        // Constrain what can be SPENT, not what can be RECEIVED. A token that
        // launched thirty seconds ago cannot be on an allowlist written earlier,
        // and receiving something worthless is already an accepted outcome of
        // sniping. Spending is where the risk lives.
        // Two ways a path is legitimate:
        //   spending approved money  -> path[0] is on the allowlist
        //   getting back to base     -> the path ends at baseToken
        //
        // The second clause matters more than it looks. A Launch Bot token was
        // created minutes ago and is on nobody's allowlist, so without it the
        // vault could buy that token and never sell it. Exiting to base is
        // never the risky direction, so it is always permitted.
        // Scoped so these locals are released. Without the braces the function
        // trips Solidity's stack depth limit.
        {
            bool spendingApproved = allowedToken[path[0]];
            bool exitingToBase = path[path.length - 1] == baseToken;
            require(spendingApproved || exitingToBase, "path not permitted");
            for (uint256 i = 1; i + 1 < path.length; ++i)
                require(allowedToken[path[i]], "hop token not allowed");
        }

        lastTradeAt = block.timestamp;

        address tokenIn = path[0];
        address tokenOut = path[path.length - 1];

        require(gasFee <= maxGasFee, "gas above your ceiling");

        // Charges settle on whichever side of the trade is WPLS, so the treasury
        // is never left holding a random token it cannot use to refill gas.
        // Buying: skim from the input. Selling: skim from the proceeds.
        //
        // The share-of-trade cap can only be applied to the WPLS side. On a sell,
        // amountIn is denominated in the token being sold, so comparing it to a
        // gas figure in WPLS compares two different units and means nothing. That
        // check therefore moves below, against the actual proceeds.
        // maxTradeSize is the owner's risk ceiling, meant in WPLS terms. On a
        // buy amountIn already IS WPLS, so it is checked here, up front. On a
        // sell amountIn is denominated in whatever token is being sold, which
        // can be worth wildly more or less than WPLS per unit, so checking it
        // here would bound the wrong quantity. The sell-side check instead
        // runs below against amountOut, once the trade's actual WPLS value is
        // known.
        bool payingIn = tokenIn == baseToken;
        if (payingIn) {
            require(amountIn <= maxTradeSize, "size out of bounds");
            require(gasFee <= (amountIn * maxGasFeeBps) / 10_000, "gas above your share limit");
        }
        uint256 fee = (amountIn * feeBps) / 10_000;
        uint256 swapAmount = amountIn;

        if (payingIn) {
            swapAmount = amountIn - fee - gasFee;
            require(swapAmount > 0, "charges exceed trade size");
            if (fee + gasFee > 0) IERC20(tokenIn).safeTransfer(treasury, fee + gasFee);
        }

        IERC20(tokenIn).safeApprove(router, 0);
        IERC20(tokenIn).safeApprove(router, swapAmount);

        uint256 before = IERC20(tokenOut).balanceOf(address(this));

        // ALWAYS the fee-on-transfer variant, never the plain one.
        //
        // swapExactTokensForTokens sends `amountIn` to the pair and then asks
        // the pair for an output computed from that figure. If the token takes
        // a cut on transfer, the pair receives less than assumed and its K
        // invariant check fails, so the whole call reverts.
        //
        // That means the plain variant CAN buy a tax token (the router never
        // verifies what arrived) but can NEVER sell one. A Launch Bot position
        // in a tax token would be permanently stuck, take-profit and stop-loss
        // both silently dead.
        //
        // The supporting variant sends the input, then derives the output from
        // what the pair actually received. It works for clean tokens too, so
        // there is no case for ever calling the other one.
        //
        // It returns nothing, which is why amountOut is measured by balance
        // difference and checked here rather than trusted from a return value.
        IPulseXRouter(router).swapExactTokensForTokensSupportingFeeOnTransferTokens(
            swapAmount, amountOutMin, path, address(this), block.timestamp + 300
        );

        // `to` was this vault, so output can never be routed to a third party.
        amountOut = IERC20(tokenOut).balanceOf(address(this)) - before;

        // The router's own floor check is unreliable for taxed tokens, so this
        // is the real slippage guard. amountOutMin must already be discounted
        // by the measured transfer tax before it reaches this function.
        require(amountOut >= amountOutMin, "slippage");

        if (!payingIn) {
            // Selling. Charges come out of the WPLS that just arrived.
            require(tokenOut == baseToken, "sell must settle in base token");
            // Same risk ceiling as the buy-side check above, applied to the
            // WPLS actually received instead of the (differently-denominated)
            // token that was sold.
            require(amountOut <= maxTradeSize, "size out of bounds");
            require(gasFee <= (amountOut * maxGasFeeBps) / 10_000, "gas above your share limit");
            uint256 outFee = (amountOut * feeBps) / 10_000;
            require(outFee + gasFee < amountOut, "charges exceed proceeds");
            IERC20(tokenOut).safeTransfer(treasury, outFee + gasFee);
            amountOut -= (outFee + gasFee);
            fee = outFee;
        }

        IERC20(tokenIn).safeApprove(router, 0);
        emit Traded(tokenIn, tokenOut, amountIn, amountOut, fee, gasFee);
    }
}

// ============================================================================
// VaultFactory
// ============================================================================

/// Deploys one vault per user as a minimal proxy. Cheap enough that per-user
/// vaults are practical, which keeps each user's funds isolated. A single
/// shared pool would be one bug away from losing everyone's money at once.
contract VaultFactory {
    address public immutable implementation;
    address public owner;
    address public executor;
    address public treasury;
    address public router;
    uint16 public feeBps;

    mapping(address => address) public vaultOf;
    address[] public allVaults;

    event VaultCreated(address indexed user, address vault);

    address public baseToken;

    constructor(address _impl, address _executor, address _treasury, address _router, address _baseToken, uint16 _feeBps) {
        require(_feeBps <= 30, "fee above ceiling");
        implementation = _impl;
        owner = msg.sender;
        executor = _executor;
        treasury = _treasury;
        router = _router;
        baseToken = _baseToken;
        feeBps = _feeBps;
    }

    function createVault(address[] calldata tokens) external returns (address vault) {
        require(vaultOf[msg.sender] == address(0), "vault exists");
        vault = _clone(implementation);
        BotVault(vault).initialize(msg.sender, executor, treasury, router, baseToken, feeBps, tokens);
        vaultOf[msg.sender] = vault;
        allVaults.push(vault);
        emit VaultCreated(msg.sender, vault);
    }

    function vaultCount() external view returns (uint256) { return allVaults.length; }

    /// EIP-1167 minimal proxy.
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
