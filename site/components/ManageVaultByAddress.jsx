import { useState } from "react";
import { Contract, ZeroAddress } from "ethers";
import { VAULT_ABI, CHAIN } from "../lib/contracts";
import { waitForReceipt, boostedGasOverrides } from "../lib/useVault";

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * A vault the dashboard's normal "find my vault" lookup can't see - one made
 * on a factory that's since been redeployed and replaced, for instance -
 * still exists on chain and can still be managed directly by address. The
 * main flow only ever calls vaultOf() against the CURRENT factory (and
 * multi-venue, if configured); it has no way to discover a vault from an
 * older one. Without this, the only way to reach that vault at all is a raw
 * tool like Remix - the exact thing this whole dashboard exists to replace.
 *
 * Deliberately minimal: read owner/executor/paused, and offer Revoke
 * Executor only when the connected wallet actually is that vault's owner
 * (a defense-in-depth check on top of the contract's own onlyOwner - avoids
 * sending a transaction that's certain to revert). No deposit/withdraw/pause
 * here; those already work fine once a vault is found the normal way, and
 * the actual use case for this box is "the executor on an old vault I can't
 * otherwise reach needs to be cut off," not day-to-day management.
 */
export default function ManageVaultByAddress({ getProvider, account }) {
  const [open, setOpen] = useState(false);
  const [addr, setAddr] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [vault, setVault] = useState(null); // { owner, executor, paused }
  const [txBusy, setTxBusy] = useState(false);
  const [status, setStatus] = useState("");

  async function handleLoad() {
    setLoadError("");
    setStatus("");
    setVault(null);
    if (!ADDR_RE.test(addr)) {
      setLoadError("Enter a valid 0x vault address.");
      return;
    }
    setLoading(true);
    try {
      const provider = getProvider();
      const v = new Contract(addr, VAULT_ABI, provider);
      const [owner, executor, paused] = await Promise.all([v.owner(), v.executor(), v.paused()]);
      setVault({ owner, executor, paused });
    } catch (e) {
      setLoadError(`Couldn't read that as a vault: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }

  const isOwner = vault && account && vault.owner.toLowerCase() === account.toLowerCase();
  const executorAlreadyRevoked = vault && vault.executor === ZeroAddress;

  async function handleRevoke() {
    setTxBusy(true);
    setStatus("");
    try {
      const provider = getProvider();
      const signer = await provider.getSigner();
      const v = new Contract(addr, VAULT_ABI, signer);
      const overrides = await boostedGasOverrides(provider);
      setStatus("Confirm the transaction in your wallet...");
      const tx = await v.revokeExecutor(overrides);
      setStatus("Waiting for it to confirm on-chain...");
      await waitForReceipt(tx.hash);
      setStatus("Executor revoked. The keeper can no longer trade this vault, regardless of whether it's running.");
      await handleLoad();
    } catch (e) {
      setStatus(`Revoke executor failed: ${e.message}`);
    } finally {
      setTxBusy(false);
    }
  }

  return (
    <div className="panel">
      <button type="button" className="btn btn-small" onClick={() => setOpen((o) => !o)}>
        {open ? "Hide" : "Manage a vault by address"}
      </button>
      {open && (
        <div style={{ marginTop: 14 }}>
          <p className="hint" style={{ marginBottom: 12 }}>
            For a vault this page can't find on its own - usually one made on a factory that's
            since been replaced. Paste its address to check its status and, if this wallet owns
            it, revoke its executor directly, without needing Remix or any other outside tool.
          </p>
          <div className="field-inline">
            <input
              type="text"
              placeholder="0x..."
              value={addr}
              onChange={(e) => { setAddr(e.target.value); setVault(null); setLoadError(""); }}
              style={{ width: 380 }}
            />
            <button type="button" className="btn btn-small" onClick={handleLoad} disabled={loading}>
              {loading ? "Loading..." : "Load"}
            </button>
          </div>
          {loadError && <p className="hint" style={{ color: "var(--bad)" }}>{loadError}</p>}
          {vault && (
            <div style={{ marginTop: 10 }}>
              <p className="mono-addr" style={{ margin: "2px 0" }}>Owner: {vault.owner}</p>
              <p className="mono-addr" style={{ margin: "2px 0" }}>Executor: {vault.executor}</p>
              <p className="hint" style={{ margin: "6px 0" }}>{vault.paused ? "Paused." : "Not paused."}</p>
              {!isOwner && (
                <p className="hint" style={{ color: "var(--bad)" }}>
                  Connected wallet ({account}) is not this vault's owner - only the owner can revoke
                  its executor. Connect the wallet shown above as Owner instead.
                </p>
              )}
              {isOwner && executorAlreadyRevoked && (
                <p className="hint">Executor is already revoked on this vault - nothing to do.</p>
              )}
              {isOwner && !executorAlreadyRevoked && (
                <button type="button" className="btn btn-small btn-danger" onClick={handleRevoke} disabled={txBusy}>
                  {txBusy ? "Working..." : "Revoke Executor"}
                </button>
              )}
              {status && <p className="hint" style={{ marginTop: 8 }}>{status}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
