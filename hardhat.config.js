require("@nomicfoundation/hardhat-toolbox");

/**
 * No live PulseChain fork here: this sandbox's network proxy has no route to
 * rpc.pulsechain.com, so `hardhat_network.forking` isn't an option in this
 * environment. Tests instead run against MockRouter (test/mocks/MockRouter.sol),
 * a hand-written, PulseX/Uniswap-V2-shaped router+pool that reproduces the two
 * behaviours BotVault actually depends on: constant-product pricing, and the
 * fee-on-transfer variant measuring real output by balance difference instead
 * of trusting amountIn. That is a same-shape stand-in, not a fork of real
 * PulseChain state or real PulseX liquidity - say so before calling any of
 * this "tested against PulseChain".
 */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    hardhat: {},
  },
};
