/**
 * Manual compile step, bypassing Hardhat's own solc downloader.
 *
 * This sandbox's network proxy blocks binaries.soliditylang.org, which is
 * where Hardhat fetches the solc compiler binary from - `npx hardhat compile`
 * fails outright here (HH502). The local `solc` npm package works fine
 * (npm's registry is reachable), so this script drives it directly via
 * standard-json-input and writes artifacts in the exact shape Hardhat's own
 * `ethers.getContractFactory` reads from `artifacts/`, so the rest of the
 * toolchain (hardhat-toolbox, ethers, the test runner) never needs to know
 * compilation didn't go through Hardhat's own pipeline. Run before `npx
 * hardhat test --no-compile` (the `--no-compile` flag stops Hardhat from
 * trying its own download and clobbering these artifacts).
 */
const fs = require("fs");
const path = require("path");
const solc = require("solc");

const ROOT = path.resolve(__dirname, "..");
const SOURCE_FILES = [
  "contracts/BotVault.sol",
  "contracts/test/mocks/MockERC20.sol",
  "contracts/test/mocks/MockFeeOnTransferERC20.sol",
  "contracts/test/mocks/MockRouter.sol",
  "contracts/test/mocks/AttackerExecutor.sol",
  "contracts/test/mocks/MaliciousReentrantToken.sol",
];

function collectSources(entryFiles) {
  const sources = {};
  const queue = [...entryFiles];
  while (queue.length) {
    const rel = queue.pop();
    if (sources[rel]) continue;
    const abs = path.join(ROOT, rel);
    const content = fs.readFileSync(abs, "utf8");
    sources[rel] = { content };
    const importRe = /^\s*import\s+"([^"]+)"\s*;/gm;
    let m;
    while ((m = importRe.exec(content))) {
      if (m[1].startsWith(".")) {
        const resolved = path.normalize(path.join(path.dirname(rel), m[1])).split(path.sep).join("/");
        queue.push(resolved);
      }
    }
  }
  return sources;
}

function main() {
  const sources = collectSources(SOURCE_FILES);
  const input = {
    language: "Solidity",
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: {
        "*": {
          "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object", "evm.bytecode.linkReferences"],
        },
      },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input)));

  const errors = (output.errors || []).filter((e) => e.severity === "error");
  const warnings = (output.errors || []).filter((e) => e.severity !== "error");
  for (const w of warnings) console.warn(w.formattedMessage);
  if (errors.length) {
    for (const e of errors) console.error(e.formattedMessage);
    process.exit(1);
  }

  const artifactsRoot = path.join(ROOT, "artifacts");
  for (const [sourceName, fileOut] of Object.entries(output.contracts || {})) {
    for (const [contractName, c] of Object.entries(fileOut)) {
      const outDir = path.join(artifactsRoot, sourceName);
      fs.mkdirSync(outDir, { recursive: true });
      const artifact = {
        _format: "hh-sol-artifact-1",
        contractName,
        sourceName,
        abi: c.abi,
        bytecode: "0x" + c.evm.bytecode.object,
        deployedBytecode: "0x" + c.evm.deployedBytecode.object,
        linkReferences: c.evm.bytecode.linkReferences || {},
        deployedLinkReferences: {},
      };
      fs.writeFileSync(path.join(outDir, `${contractName}.json`), JSON.stringify(artifact, null, 2));
    }
  }

  // hardhat-toolbox's HRE also needs artifacts/contracts/**/*.dbg.json to
  // exist alongside each artifact (points at build-info); a minimal stub
  // pointing nowhere is fine since we never call the debug APIs in tests.
  for (const [sourceName, fileOut] of Object.entries(output.contracts || {})) {
    for (const contractName of Object.keys(fileOut)) {
      const outDir = path.join(artifactsRoot, sourceName);
      fs.writeFileSync(
        path.join(outDir, `${contractName}.dbg.json`),
        JSON.stringify({ _format: "hh-sol-dbg-1", buildInfo: "" }, null, 2),
      );
    }
  }

  console.log(`Compiled ${Object.keys(output.contracts || {}).length} source file(s) via local solc into artifacts/.`);
}

main();
