// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IReenterHook {
    function onTokenReceived() external;
}

interface BotVaultLike {
    function executeSwap(address[] calldata path, uint256 amountIn, uint256 amountOutMin, uint256 gasFee)
        external
        returns (uint256);
    function withdraw(address token, uint256 amount) external;
}

/**
 * Test-only. Stands in for "the keeper key is compromised and the keeper is
 * itself a contract" - the scenario CLAUDE.md names as the top concern:
 * reentrancy through a hostile token's transfer hook. This contract IS the
 * vault's `executor`, so a nested call it makes from inside a token callback
 * passes onlyExecutor legitimately; only nonReentrant stands between that and
 * a second executeSwap landing inside the first one's still-open state.
 */
contract AttackerExecutor is IReenterHook {
    address public vault;
    address[] public path;
    uint256 public amountIn;
    uint256 public amountOutMin;
    uint256 public gasFee;
    bool public reentered;
    bool public reenterSucceeded;

    function configureSwap(
        address _vault,
        address[] calldata _path,
        uint256 _amountIn,
        uint256 _amountOutMin,
        uint256 _gasFee
    ) external {
        vault = _vault;
        path = _path;
        amountIn = _amountIn;
        amountOutMin = _amountOutMin;
        gasFee = _gasFee;
    }

    function fire() external returns (uint256) {
        return BotVaultLike(vault).executeSwap(path, amountIn, amountOutMin, gasFee);
    }

    /// Called mid-swap by the malicious token's transfer hook, while the
    /// outer executeSwap call is still on the stack and still holding the
    /// nonReentrant lock.
    function onTokenReceived() external {
        reentered = true;
        try BotVaultLike(vault).executeSwap(path, amountIn, amountOutMin, gasFee) {
            reenterSucceeded = true;
        } catch {
            reenterSucceeded = false;
        }
    }
}
