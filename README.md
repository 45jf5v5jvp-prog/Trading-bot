# Icaria Bots

Automated trading bots for PulseChain. Read **HANDOFF.md** first.

    contracts/   BotVault, VaultFactory, SwapProbe (Solidity 0.8.24)
    keeper/      Node service: prices, rules, launches, positions
    web/         React UI and landing page

Nothing here has run against PulseChain. Contracts compile, keeper typechecks,
that is all that has been verified.

    cd keeper && npm install && npm run doctor

Keep DRY_RUN=true until the doctor passes and you have read a week of logs.
