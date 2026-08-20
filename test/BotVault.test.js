/**
 * Runs against MockRouter (contracts/test/mocks/MockRouter.sol), a
 * hand-written PulseX/Uniswap-V2-shaped router+pool - NOT a fork of live
 * PulseChain. This sandbox's network proxy has no route to a PulseChain RPC
 * endpoint, so a literal forked-chain test wasn't possible here; MockRouter
 * reproduces the two specific behaviours BotVault depends on (constant-
 * product pricing, and the fee-on-transfer variant measuring real output by
 * balance difference) so the scenarios below exercise real logic, not a
 * stub. Say so plainly - this is "tested against a same-shape mock," not
 * "tested against PulseChain."
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const FEE_BPS = 15; // 0.15%, the platform fee described in CLAUDE.md

async function deployBase() {
  const [deployer, owner, treasury, executor, stranger] = await ethers.getSigners();

  const Token = await ethers.getContractFactory("MockERC20");
  const wpls = await Token.deploy("Wrapped PLS", "WPLS");
  await wpls.waitForDeployment();

  const Router = await ethers.getContractFactory("MockRouter");
  const router = await Router.deploy();
  await router.waitForDeployment();

  const Vault = await ethers.getContractFactory("BotVault");
  const vault = await Vault.deploy();
  await vault.waitForDeployment();

  await vault.initialize(
    owner.address,
    executor.address,
    treasury.address,
    await router.getAddress(),
    await wpls.getAddress(),
    FEE_BPS,
    [],
  );

  return { deployer, owner, treasury, executor, stranger, wpls, router, vault };
}

async function addLiquidity(router, tokenA, tokenB, amountA, amountB, funder) {
  await tokenA.mint(funder.address, amountA);
  await tokenB.mint(funder.address, amountB);
  await tokenA.connect(funder).approve(await router.getAddress(), amountA);
  await tokenB.connect(funder).approve(await router.getAddress(), amountB);
  await router
    .connect(funder)
    .addLiquidity(await tokenA.getAddress(), amountA, await tokenB.getAddress(), amountB);
}

async function depositWpls(vault, wpls, owner, amount) {
  await wpls.mint(owner.address, amount);
  await wpls.connect(owner).approve(await vault.getAddress(), amount);
  await vault.connect(owner).deposit(await wpls.getAddress(), amount);
}

describe("BotVault", function () {
  describe("fee-on-transfer tokens", function () {
    it("plain swapExactTokensForTokens reverts selling a taxed token; the vault's supporting variant does not", async function () {
      const { deployer, owner, executor, wpls, router, vault } = await deployBase();

      const Tax = await ethers.getContractFactory("MockFeeOnTransferERC20");
      const sink = ethers.Wallet.createRandom().address;
      const tax = await Tax.deploy("Tax Token", "TAX", 500, sink); // 5% tax
      await tax.waitForDeployment();

      await addLiquidity(
        router,
        wpls,
        tax,
        ethers.parseEther("1000000"),
        ethers.parseEther("1000000"),
        deployer,
      );

      const wplsAddr = await wpls.getAddress();
      const taxAddr = await tax.getAddress();

      // Demonstrate the historical bug directly: selling TAX via the plain
      // variant reverts, because the pool receives less than the router
      // priced the swap against once the input-side tax bites.
      await tax.mint(deployer.address, ethers.parseEther("100"));
      await tax.connect(deployer).approve(await router.getAddress(), ethers.parseEther("100"));
      await expect(
        router
          .connect(deployer)
          .swapExactTokensForTokens(ethers.parseEther("100"), 0, [taxAddr, wplsAddr], deployer.address, 9999999999),
      ).to.be.revertedWith("K");

      // Fund the vault and prove the real path: buy TAX with WPLS, then sell
      // the TAX back to WPLS, exiting to base even though TAX was never
      // allowlisted - the fix for "buys but can never sell."
      await depositWpls(vault, wpls, owner, ethers.parseEther("10000"));

      await vault.connect(executor).executeSwap([wplsAddr, taxAddr], ethers.parseEther("1000"), 0, 0);
      const taxBalance = await tax.balanceOf(await vault.getAddress());
      expect(taxBalance).to.be.gt(0);

      const wplsBefore = await wpls.balanceOf(await vault.getAddress());
      await vault.connect(executor).executeSwap([taxAddr, wplsAddr], taxBalance, 0, 0);
      const wplsAfter = await wpls.balanceOf(await vault.getAddress());
      expect(wplsAfter).to.be.gt(wplsBefore);
    });
  });

  describe("a swap that reverts mid-flow", function () {
    it("leaves no state changes behind, so a keeper retry behaves as if the failed attempt never happened", async function () {
      const { deployer, owner, executor, wpls, router, vault } = await deployBase();

      const Token = await ethers.getContractFactory("MockERC20");
      const other = await Token.deploy("Other", "OTH");
      await other.waitForDeployment();

      await addLiquidity(
        router,
        wpls,
        other,
        ethers.parseEther("100000"),
        ethers.parseEther("100000"),
        deployer,
      );

      await depositWpls(vault, wpls, owner, ethers.parseEther("1000"));

      const wplsAddr = await wpls.getAddress();
      const otherAddr = await other.getAddress();
      const lastTradeBefore = await vault.lastTradeAt();

      // An amountOutMin no honest quote would produce - the router's own
      // slippage check trips and the whole call reverts.
      const impossibleMin = ethers.parseEther("999999999");
      await expect(
        vault.connect(executor).executeSwap([wplsAddr, otherAddr], ethers.parseEther("100"), impossibleMin, 0),
      ).to.be.reverted;

      expect(await vault.lastTradeAt()).to.equal(lastTradeBefore);
      expect(await other.balanceOf(await vault.getAddress())).to.equal(0);
      expect(await wpls.balanceOf(await vault.getAddress())).to.equal(ethers.parseEther("1000"));

      // A correctly-parameterized retry (what a restarted keeper would send)
      // succeeds cleanly - nothing from the failed attempt lingered.
      await expect(vault.connect(executor).executeSwap([wplsAddr, otherAddr], ethers.parseEther("100"), 0, 0)).to.not
        .be.reverted;
      expect(await vault.lastTradeAt()).to.be.gt(lastTradeBefore);
    });
  });

  describe("cooldown", function () {
    it("rejects a second fire before minInterval has elapsed, and allows it after", async function () {
      const { deployer, owner, executor, wpls, router, vault } = await deployBase();

      const Token = await ethers.getContractFactory("MockERC20");
      const other = await Token.deploy("Other", "OTH");
      await other.waitForDeployment();

      await addLiquidity(
        router,
        wpls,
        other,
        ethers.parseEther("100000"),
        ethers.parseEther("100000"),
        deployer,
      );
      await depositWpls(vault, wpls, owner, ethers.parseEther("1000"));
      await vault.connect(owner).setLimits(ethers.MaxUint256, 60); // 60s cooldown, no size cap

      const wplsAddr = await wpls.getAddress();
      const otherAddr = await other.getAddress();

      await vault.connect(executor).executeSwap([wplsAddr, otherAddr], ethers.parseEther("10"), 0, 0);

      await expect(
        vault.connect(executor).executeSwap([wplsAddr, otherAddr], ethers.parseEther("10"), 0, 0),
      ).to.be.revertedWith("cooldown");

      await time.increase(61);

      await expect(vault.connect(executor).executeSwap([wplsAddr, otherAddr], ethers.parseEther("10"), 0, 0)).to.not
        .be.reverted;
    });
  });

  describe("maxTradeSize (WPLS-denominated on both sides)", function () {
    it("bounds a buy against amountIn (already WPLS)", async function () {
      const { deployer, owner, executor, wpls, router, vault } = await deployBase();

      const Token = await ethers.getContractFactory("MockERC20");
      const other = await Token.deploy("Other", "OTH");
      await other.waitForDeployment();

      await addLiquidity(
        router,
        wpls,
        other,
        ethers.parseEther("100000"),
        ethers.parseEther("100000"),
        deployer,
      );
      await depositWpls(vault, wpls, owner, ethers.parseEther("1000"));
      await vault.connect(owner).setLimits(ethers.parseEther("50"), 0);

      const wplsAddr = await wpls.getAddress();
      const otherAddr = await other.getAddress();

      await expect(
        vault.connect(executor).executeSwap([wplsAddr, otherAddr], ethers.parseEther("100"), 0, 0),
      ).to.be.revertedWith("size out of bounds");

      await expect(vault.connect(executor).executeSwap([wplsAddr, otherAddr], ethers.parseEther("50"), 0, 0)).to.not
        .be.reverted;
    });

    it("bounds a sell against amountOut (WPLS received), not the raw amount of the token sold", async function () {
      const { deployer, owner, executor, wpls, router, vault } = await deployBase();

      // A "cheap" token priced far below WPLS: 1 WPLS buys 1,000,000 CHEAP.
      // A compromised executor selling a huge *raw* amount of CHEAP is only
      // a small WPLS-equivalent trade - the cap should track that, not the
      // raw CHEAP unit count.
      const Token = await ethers.getContractFactory("MockERC20");
      const cheap = await Token.deploy("Cheap", "CHEAP");
      await cheap.waitForDeployment();

      await addLiquidity(
        router,
        wpls,
        cheap,
        ethers.parseEther("1000"),
        ethers.parseEther("1000000000"),
        deployer,
      );

      // Give the vault a CHEAP position directly (bypassing a buy leg, to
      // isolate the sell-side cap in this test).
      const cheapAddr = await cheap.getAddress();
      const wplsAddr = await wpls.getAddress();
      await cheap.mint(await vault.getAddress(), ethers.parseEther("500000000")); // huge raw amount

      // Cap set to 10 WPLS. Selling all 500,000,000 CHEAP is worth roughly
      // ~330 WPLS at this pool's price - well over the cap - and must revert.
      await vault.connect(owner).setLimits(ethers.parseEther("10"), 0);
      await expect(
        vault.connect(executor).executeSwap([cheapAddr, wplsAddr], ethers.parseEther("500000000"), 0, 0),
      ).to.be.revertedWith("size out of bounds");

      // A small enough CHEAP amount, worth well under 10 WPLS, still sells fine.
      await expect(
        vault.connect(executor).executeSwap([cheapAddr, wplsAddr], ethers.parseEther("1000000"), 0, 0),
      ).to.not.be.reverted;
    });
  });

  describe("allowlist", function () {
    it("lets an unlisted token exit to base, but never spend an unlisted token to buy something else", async function () {
      const { deployer, owner, executor, wpls, router, vault } = await deployBase();

      const Token = await ethers.getContractFactory("MockERC20");
      const unlisted = await Token.deploy("Unlisted", "UNL");
      await unlisted.waitForDeployment();
      const other = await Token.deploy("Other", "OTH");
      await other.waitForDeployment();

      await addLiquidity(
        router,
        wpls,
        unlisted,
        ethers.parseEther("100000"),
        ethers.parseEther("100000"),
        deployer,
      );
      await addLiquidity(
        router,
        unlisted,
        other,
        ethers.parseEther("100000"),
        ethers.parseEther("100000"),
        deployer,
      );

      const wplsAddr = await wpls.getAddress();
      const unlistedAddr = await unlisted.getAddress();
      const otherAddr = await other.getAddress();

      await unlisted.mint(await vault.getAddress(), ethers.parseEther("100"));

      // UNL -> OTH: spending an unlisted token to buy something that is not
      // base and not on the allowlist either. Must be rejected.
      await expect(
        vault.connect(executor).executeSwap([unlistedAddr, otherAddr], ethers.parseEther("10"), 0, 0),
      ).to.be.revertedWith("path not permitted");

      // UNL -> WPLS: exiting an unlisted position to base is always allowed.
      await expect(vault.connect(executor).executeSwap([unlistedAddr, wplsAddr], ethers.parseEther("10"), 0, 0)).to
        .not.be.reverted;
    });
  });

  describe("reentrancy", function () {
    it("blocks a hostile token's transfer hook from reentering executeSwap, even when the reentrant call comes from the real executor", async function () {
      // CLAUDE.md's stated top concern: "assume the keeper key is
      // compromised... reentrancy through a hostile token's transfer hook."
      // A third-party token's hook can never itself pass onlyExecutor (its
      // msg.sender inside the callback is the token contract, not the
      // executor), so the only scenario where reentrancy is a live risk at
      // all is a compromised executor that is itself a contract wired to a
      // hostile token's hook. AttackerExecutor models exactly that: it IS
      // the vault's executor, so its nested call legitimately passes
      // onlyExecutor, and only nonReentrant stands between that and a
      // second executeSwap landing inside the first one's still-open state.
      const [deployer, owner, treasury] = await ethers.getSigners();

      const Token = await ethers.getContractFactory("MockERC20");
      const wpls = await Token.deploy("Wrapped PLS", "WPLS");
      await wpls.waitForDeployment();

      const Router = await ethers.getContractFactory("MockRouter");
      const router = await Router.deploy();
      await router.waitForDeployment();

      const Evil = await ethers.getContractFactory("MaliciousReentrantToken");
      const evil = await Evil.deploy();
      await evil.waitForDeployment();

      const Attacker = await ethers.getContractFactory("AttackerExecutor");
      const attackerExecutor = await Attacker.deploy();
      await attackerExecutor.waitForDeployment();

      const Vault = await ethers.getContractFactory("BotVault");
      const vault = await Vault.deploy();
      await vault.waitForDeployment();

      await vault.initialize(
        owner.address,
        await attackerExecutor.getAddress(),
        treasury.address,
        await router.getAddress(),
        await wpls.getAddress(),
        FEE_BPS,
        [],
      );

      await addLiquidity(
        router,
        wpls,
        evil,
        ethers.parseEther("100000"),
        ethers.parseEther("100000"),
        deployer,
      );

      await depositWpls(vault, wpls, owner, ethers.parseEther("1000"));

      const wplsAddr = await wpls.getAddress();
      const evilAddr = await evil.getAddress();
      const vaultAddr = await vault.getAddress();

      // Arm EVIL to call the attacker-controlled executor's callback the
      // instant EVIL lands in the vault - i.e., mid-swap, while executeSwap
      // is still on the stack and the nonReentrant lock is still held.
      await evil.setHook(vaultAddr, await attackerExecutor.getAddress());
      await attackerExecutor.configureSwap(
        vaultAddr,
        [wplsAddr, evilAddr],
        ethers.parseEther("10"),
        0,
        0,
      );

      await expect(attackerExecutor.fire()).to.not.be.reverted;

      expect(await attackerExecutor.reentered()).to.equal(true);
      expect(await attackerExecutor.reenterSucceeded()).to.equal(false);

      // Only one swap's worth of EVIL landed - the nested attempt did not
      // double-spend the vault's WPLS or re-run the trade a second time.
      const lastTradeAt = await vault.lastTradeAt();
      expect(lastTradeAt).to.be.gt(0);
      const wplsLeft = await wpls.balanceOf(vaultAddr);
      expect(wplsLeft).to.equal(ethers.parseEther("990")); // 1000 - 10, not 1000 - 20
    });
  });
});
