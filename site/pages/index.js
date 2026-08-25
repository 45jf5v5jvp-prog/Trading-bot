import { useEffect, useState } from "react";
import Link from "next/link";
import { useVault } from "../lib/useVault";
import { loadConfig, saveConfig } from "../lib/saveConfig";
import { loadHistory } from "../lib/loadHistory";
import { loadPortfolio } from "../lib/loadPortfolio";
import { loadHunterIQ } from "../lib/loadHunterIQ";
import { closePosition, closeAllPositions } from "../lib/closePosition";
import { loadHunterChat, sendHunterChatMessage } from "../lib/talkToHunter";
import { setReferral, loadReferral, loadReferralCode, loadReferralEarnings } from "../lib/setReferral";
import { APP_VERSION } from "../lib/version";
import { numberFieldProps } from "../lib/numberField";
import NumberField from "../components/NumberField";
import { CHAIN } from "../lib/contracts";
import { pnlForWindow } from "../lib/pnl";
import { openPositionsValue, fmtEstimate } from "../lib/accountValue";
import RulesList from "../components/RulesList";
import SnipesList from "../components/SnipesList";
import PortfolioPanel from "../components/PortfolioPanel";
import LimitOrdersList from "../components/LimitOrdersList";
import LaunchSettings from "../components/LaunchSettings";
import HunterSettings from "../components/HunterSettings";
import BotCard from "../components/BotCard";
import InfoButton from "../components/InfoButton";
import { TradingBotsIcon, LaunchIcon, SniperIcon, HunterIcon, LimitOrderIcon } from "../components/BotIcons";
import HunterIQPanel from "../components/HunterIQPanel";
import HistoryPanel from "../components/HistoryPanel";
import PnlSnapshot from "../components/PnlSnapshot";
import Sun from "../components/Sun";
import ManageVaultByAddress from "../components/ManageVaultByAddress";
import CopyAddressButton from "../components/CopyAddressButton";

/** Balance in the chain's wrapped base token. The per-chain decimal budget
 * comes from the chain preset: WPLS balances are millions where fractional
 * dust is noise; ETH-scale balances are tiny and the fraction is the money. */
function fmtBalance(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  // Truncated, never rounded. Rounding up shows a number a hair above the
  // real balance, and typing that number back in makes an exact-balance
  // withdrawal fail - found the hard way. What's displayed must always be
  // withdrawable as typed.
  const scale = 10 ** CHAIN.balanceMaxDecimals;
  const floored = Math.floor(n * scale) / scale;
  return floored.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: CHAIN.balanceMaxDecimals });
}

/** One line of context for a bot's collapsed BotCard header - lifetime P&L
 * and how many round trips it's actually completed, so "how's Hunter doing"
 * is answered before you even tap the card open. Deliberately closedCount,
 * not tradeCount (open + closed): a position that closes just moves from
 * the open side of tradeCount to the closed side, so tradeCount doesn't
 * budge when a real sale happens - closedCount is the number that actually
 * means "round trips completed," and only moves on a real close, not a buy.
 * Null history (still loading, or no keeper.db reachable yet) shows nothing
 * rather than a misleading 0. */
function botStatLine(history, botKey) {
  if (!history) return null;
  const { totalPls, tradeCount, closedCount } = pnlForWindow(history, null, botKey);
  if (tradeCount === 0) return "No trades yet";
  const sign = totalPls > 0 ? "+" : "";
  const amount = `${sign}${totalPls.toLocaleString(undefined, { maximumFractionDigits: CHAIN.valueMaxDecimals })} ${CHAIN.nativeSymbol}`;
  return `${amount} lifetime · ${closedCount} round trip${closedCount === 1 ? "" : "s"} completed`;
}

/** Fuller breakdown shown once a BotCard is actually opened - realized vs
 * unrealized, and how many positions are open right now. `hunterConfig` is
 * only passed for the "hunter" card - it's how the near-limit warning below
 * knows the actual cap to compare against. */
function botPerfDetail(history, botKey, hunterConfig) {
  if (!history) return null;
  const { realizedPls, unrealizedPls, tradeCount } = pnlForWindow(history, null, botKey);
  const openPositions = history.positions.open.filter((p) => p.bot === botKey);
  const openCount = openPositions.length;
  const unit = CHAIN.nativeSymbol;
  const fmt = (v) => `${v > 0 ? "+" : ""}${v.toLocaleString(undefined, { maximumFractionDigits: CHAIN.valueMaxDecimals })} ${unit}`;

  // Hunter-only: warn once its own dedicated budget is close to full, since
  // that's exactly what silently looks like "the bot stopped buying" from
  // the dashboard - see hunter.ts's deployedPls/spentPlsLast24h/
  // executeHunterBuy. Only meaningful when there's still a real cap to run
  // out of. Mirrors whichever mode the vault is actually using: "as
  // positions close" only counts currently-open positions, "every 24 hours"
  // counts anything opened in the last day regardless of status.
  let nearLimit = null;
  if (botKey === "hunter" && hunterConfig && !hunterConfig.allocatedUnlimited && hunterConfig.allocatedPls > 0) {
    const usedPls = hunterConfig.allocatedResetDaily
      ? [...openPositions, ...history.positions.closed.filter((p) => p.bot === botKey)]
          .filter((p) => p.opened_at >= Math.floor(Date.now() / 1000) - 86400)
          .reduce((sum, p) => sum + (p.spent_pls || 0), 0)
      : openPositions.reduce((sum, p) => sum + (p.spent_pls || 0), 0);
    const pctUsed = usedPls / hunterConfig.allocatedPls;
    if (pctUsed >= 0.9) {
      const resetNote = hunterConfig.allocatedResetDaily
        ? "some room frees up as older buys age past 24 hours"
        : 'wait for an open position to close, or turn on "Every 24 hours" so it frees up on its own';
      nearLimit = (
        <p className="hint" style={{ marginBottom: 0, marginTop: 4, color: "var(--amber)" }}>
          {fmt(usedPls)} of its {fmt(hunterConfig.allocatedPls)} allocation used
          ({Math.round(pctUsed * 100)}%) - new buys will be skipped once it's full. Raise "Allocated
          {" "}{CHAIN.nativeSymbol}" below, turn on "No cap," or {resetNote}.
        </p>
      );
    }
  }

  if (tradeCount === 0) return nearLimit;
  return (
    <>
      <p className="hint" style={{ marginBottom: 0 }}>
        {fmt(realizedPls)} realized, {fmt(unrealizedPls)} unrealized &middot; {openCount} open position{openCount === 1 ? "" : "s"}
      </p>
      {nearLimit}
    </>
  );
}

export default function Dashboard() {
  const {
    account, vaultAddress, vaultKind, vaultInfo, connecting, initializing, error,
    connectInjected, connectWalletConnect, createVault, depositBase, depositToken, getTokenWalletInfo,
    withdrawBase, withdrawToken, setPaused, revokeExecutor, refreshVaultInfo, getProvider,
  } = useVault();
  const [config, setConfig] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [saveError, setSaveError] = useState(""); // shown IN the fixed unsaved-bar itself - see handleSave
  const [history, setHistory] = useState(null);
  const [historyError, setHistoryError] = useState(false);
  const [portfolio, setPortfolio] = useState(null);
  const [hunterIQ, setHunterIQ] = useState(null);
  const [chatMessages, setChatMessages] = useState([]);
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);
  const [amount, setAmount] = useState("");
  const [txBusy, setTxBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [closeStates, setCloseStates] = useState({}); // { [positionId]: "pending" | "requested" | "error" }
  const [closeAllState, setCloseAllState] = useState(null); // null | "pending" | "requested" | "error"
  const [stuckWithdrawStates, setStuckWithdrawStates] = useState({}); // { [positionId]: "pending" | "done" | "error" }
  const [tokenWithdrawAddr, setTokenWithdrawAddr] = useState("");
  const [tokenWithdrawBusy, setTokenWithdrawBusy] = useState(false);
  const [depositTokenAddr, setDepositTokenAddr] = useState("");
  // null = nothing resolved yet, "loading" mid-lookup, "notfound" resolved
  // and failed, otherwise { symbol, decimals, balance } for the CONNECTED
  // WALLET's holding of that token - see useVault's getTokenWalletInfo.
  const [depositTokenInfo, setDepositTokenInfo] = useState(null);
  const [depositTokenAmount, setDepositTokenAmount] = useState("");
  const [depositTokenBusy, setDepositTokenBusy] = useState(false);
  const [referralCode, setReferralCode] = useState(""); // captured from ?ref=, or pasted in manually
  const [referred, setReferred] = useState(false); // whether THIS vault has a referrer bound, once known
  const [myReferralCode, setMyReferralCode] = useState(""); // this wallet's own referral link code
  const [referralEarnings, setReferralEarnings] = useState(null); // what THIS wallet has earned referring others
  const [referralCopied, setReferralCopied] = useState(false);

  // Referral codes are opaque, not addresses - see lib/store.js's
  // getOrCreateReferralCode (16 lowercase hex chars) - deliberately NOT a
  // wallet address, so a shared link never exposes which address is yours.
  const CODE_RE = /^[a-f0-9]{16}$/i;

  // Captures a referral code the moment someone arrives via ?ref=... - kept
  // in localStorage (not just component state) so it survives the page
  // reload that happens partway through connecting a wallet. Whichever link
  // was clicked most recently wins if more than one ever gets clicked before
  // a vault exists; once a vault is created the binding is permanent and this
  // stops mattering. A manually pasted code (someone read it off a screenshot
  // rather than clicking a link) works exactly the same way.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const ref = params.get("ref");
    if (ref && CODE_RE.test(ref)) {
      window.localStorage.setItem("icaria_pending_referrer", ref.toLowerCase());
    }
    const pending = window.localStorage.getItem("icaria_pending_referrer");
    if (pending) setReferralCode(pending);
  }, []);

  // Whether this vault has a referrer bound, if any - read once a vault
  // exists, purely informational (the binding itself happens at
  // vault-creation time, see handleCreateVault). Never learns WHICH wallet
  // referred it - that address is never returned by this endpoint.
  useEffect(() => {
    if (!vaultAddress) return;
    loadReferral(vaultAddress).then((r) => setReferred(r.referred)).catch(() => {});
  }, [vaultAddress]);

  // This wallet's own referral link code - created on the server the first
  // time it's requested, then stable forever after.
  useEffect(() => {
    if (!account) return;
    loadReferralCode(account).then((r) => setMyReferralCode(r.code)).catch(() => {});
  }, [account]);

  // What this wallet has earned referring OTHER people's vaults - doesn't
  // require this wallet to have a vault of its own, just to have referred
  // someone who does. Polled the same way history/portfolio are, so it stays
  // current as referred vaults keep trading.
  useEffect(() => {
    if (!account) return;
    let cancelled = false;
    const refresh = () => loadReferralEarnings(account).then((e) => { if (!cancelled) setReferralEarnings(e); }).catch(() => {});
    refresh();
    const id = setInterval(refresh, 20_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [account]);

  // Resolves the "Deposit a Token" address field as soon as it looks like a
  // real address - debounced so it doesn't fire an RPC call on every
  // keystroke while someone's still typing or pasting. Shows the wallet's
  // own balance and symbol before they type an amount, same reasoning as
  // vaultInfo.walletBaseBalance - no guessing how much they actually hold.
  useEffect(() => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(depositTokenAddr)) { setDepositTokenInfo(null); return; }
    let cancelled = false;
    setDepositTokenInfo("loading");
    const id = setTimeout(() => {
      getTokenWalletInfo(depositTokenAddr).then((info) => {
        if (!cancelled) setDepositTokenInfo(info ?? "notfound");
      });
    }, 400);
    return () => { cancelled = true; clearTimeout(id); };
  }, [depositTokenAddr, getTokenWalletInfo]);

  /** Every edit to config goes through here so "unsaved changes" stays accurate -
   * nothing takes effect for the keeper until Save All Settings actually signs
   * and persists it, and that's easy to forget without a visible reminder. */
  function updateConfig(next) {
    setConfig(next);
    setDirty(true);
    setSaveError(""); // a fresh edit supersedes whatever the last save attempt reported
  }

  useEffect(() => {
    if (!vaultAddress) return;
    loadConfig(vaultAddress)
      .then((loaded) => { setConfig(loaded); setDirty(false); })
      .catch((e) => setStatus(`Could not load saved settings: ${e.message}`));
  }, [vaultAddress]);

  // Backstop for the case where someone edits settings and closes the tab
  // instead of scrolling down to Save All Settings.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // Polled independently of config (which only needs to load once) so open
  // positions' live P/L keeps updating without the user refreshing the page.
  useEffect(() => {
    if (!vaultAddress) return;
    let cancelled = false;
    const refresh = () => loadHistory(vaultAddress)
      .then((h) => { if (!cancelled) { setHistory(h); setHistoryError(false); } })
      .catch(() => { if (!cancelled) setHistoryError(true); });
    refresh();
    const id = setInterval(refresh, 20_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [vaultAddress]);

  // Same polling idea for the Portfolio panel - live balances/values for
  // whatever tokens the saved limit orders reference.
  useEffect(() => {
    if (!vaultAddress) return;
    let cancelled = false;
    const refresh = () => loadPortfolio(vaultAddress).then((p) => { if (!cancelled) setPortfolio(p.portfolio); }).catch(() => {});
    refresh();
    const id = setInterval(refresh, 20_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [vaultAddress]);

  // Same polling idea for Hunter IQ - the trade-rationale feed and lessons
  // list refresh on their own so a self-written lesson from a just-closed
  // position shows up without a manual refresh.
  useEffect(() => {
    if (!vaultAddress) return;
    let cancelled = false;
    const refresh = () => loadHunterIQ(vaultAddress).then((h) => { if (!cancelled) setHunterIQ(h); }).catch(() => {});
    refresh();
    const id = setInterval(refresh, 20_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [vaultAddress]);

  // Same polling idea for the Talk to Your Hunter thread - so a reply that
  // came in async (or a lesson the bot wrote to itself) shows up without a
  // manual refresh, same as Hunter IQ's trade/lessons feed above.
  useEffect(() => {
    if (!vaultAddress) return;
    let cancelled = false;
    const refresh = () => loadHunterChat(vaultAddress).then((c) => { if (!cancelled) setChatMessages(c.messages); }).catch(() => {});
    refresh();
    const id = setInterval(refresh, 20_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [vaultAddress]);

  // Same idea for the vault's balance/paused state - previously this only
  // updated right after a deposit/withdraw/pause, so the balance would sit
  // stale until the user did something. Silent failures here (e.g. the
  // wallet was disconnected in the background) just skip a tick rather than
  // surfacing an error every 20 seconds.
  useEffect(() => {
    if (!vaultAddress) return;
    let cancelled = false;
    const id = setInterval(() => { if (!cancelled) refreshVaultInfo(vaultAddress).catch(() => {}); }, 20_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [vaultAddress, refreshVaultInfo]);

  /** Manual "Refresh" button - updates balance and holdings immediately
   * instead of waiting for the next 20s poll, without reloading the page
   * (which would otherwise mean reconnecting the wallet). */
  async function handleRefresh() {
    setRefreshing(true);
    try {
      const [, h, p, hiq] = await Promise.all([
        refreshVaultInfo(vaultAddress), loadHistory(vaultAddress), loadPortfolio(vaultAddress), loadHunterIQ(vaultAddress),
      ]);
      setHistory(h);
      setPortfolio(p.portfolio);
      setHunterIQ(hiq);
    } catch (e) {
      setStatus(`Refresh failed: ${e.message}`);
    } finally {
      setRefreshing(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    setStatus("");
    setSaveError("");
    try {
      const saved = await saveConfig(getProvider, vaultAddress, config);
      setConfig(saved);
      setDirty(false);
      setStatus("Saved. The keeper picks this up on its next refresh cycle.");
    } catch (e) {
      // Shown INSIDE the fixed unsaved-bar (see below), not just the
      // page-bottom status line - that line sits right where the fixed bar
      // pins itself, so a failure there was invisible: dirty stayed true,
      // the bar kept showing its generic reminder, and the actual reason
      // was hidden underneath it the whole time.
      setSaveError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleCreateVault() {
    setTxBusy(true);
    setStatus("");
    try {
      const addr = await createVault(setStatus);
      setStatus("Vault created.");
      // Bind the referral, if a valid one was captured or pasted in. Best
      // effort: the vault itself already exists at this point regardless of
      // whether this succeeds, so a referral failure is reported but doesn't
      // look like the vault creation itself failed.
      const code = referralCode.trim().toLowerCase();
      if (code && CODE_RE.test(code)) {
        try {
          await setReferral(getProvider, addr, code);
          setReferred(true);
          if (typeof window !== "undefined") window.localStorage.removeItem("icaria_pending_referrer");
          setStatus("Vault created. Referral recorded.");
        } catch (e) {
          setStatus(`Vault created, but the referral could not be recorded: ${e.message}`);
        }
      }
    } catch (e) {
      setStatus(`Create vault failed: ${e.message}`);
    } finally {
      setTxBusy(false);
    }
  }

  async function handleDeposit() {
    if (!amount) return;
    setTxBusy(true);
    setStatus("");
    try {
      await depositBase(amount, setStatus);
      setStatus(`Deposited ${amount} ${CHAIN.baseSymbol}.`);
      setAmount("");
    } catch (e) {
      setStatus(`Deposit failed: ${e.message}`);
    } finally {
      setTxBusy(false);
    }
  }

  /** Sends a token OTHER than the base currency straight into the vault,
   * then tells the keeper to start tracking it as a position - see
   * useVault's depositToken. Distinct from handleDeposit (WPLS only,
   * through the vault's own deposit() function). */
  async function handleDepositToken() {
    if (!depositTokenAddr || !depositTokenAmount) return;
    setDepositTokenBusy(true);
    setStatus("");
    try {
      await depositToken(depositTokenAddr, depositTokenAmount, setStatus);
      setStatus(`Deposited ${depositTokenAmount} ${typeof depositTokenInfo === "object" && depositTokenInfo ? depositTokenInfo.symbol : "tokens"}. It'll show up on Current Holdings once the bot notices it.`);
      setDepositTokenAddr("");
      setDepositTokenAmount("");
      setDepositTokenInfo(null);
    } catch (e) {
      setStatus(`Token deposit failed: ${e.message}`);
    } finally {
      setDepositTokenBusy(false);
    }
  }

  async function handleWithdraw() {
    if (!amount) return;
    setTxBusy(true);
    setStatus("");
    try {
      await withdrawBase(amount, setStatus);
      setStatus(`Withdrew ${amount} ${CHAIN.baseSymbol}.`);
      setAmount("");
    } catch (e) {
      setStatus(`Withdraw failed: ${e.message}`);
    } finally {
      setTxBusy(false);
    }
  }

  async function handleTogglePause() {
    setTxBusy(true);
    setStatus("");
    try {
      const next = !vaultInfo.paused;
      await setPaused(next, setStatus);
      setStatus(next ? "Bot paused. The keeper cannot trade this vault until you resume it." : "Bot resumed.");
    } catch (e) {
      setStatus(`Pause/resume failed: ${e.message}`);
    } finally {
      setTxBusy(false);
    }
  }

  /** Unlike Pause (a toggle you can flip back yourself from this same page),
   * getting the keeper trading again after this requires setExecutor() from
   * outside this UI - so this is the "something is actually wrong, cut it
   * off now" button, not the everyday one. */
  async function handleRevokeExecutor() {
    setTxBusy(true);
    setStatus("");
    try {
      await revokeExecutor(setStatus);
      setStatus("Executor revoked. The keeper can no longer trade this vault, regardless of whether it's running.");
    } catch (e) {
      setStatus(`Revoke executor failed: ${e.message}`);
    } finally {
      setTxBusy(false);
    }
  }

  /** Pulls the vault's entire balance of one token directly to the owner's
   * wallet. The escape hatch for a position the keeper isn't exiting on its
   * own - doesn't sell anything, just gets it out of the vault so it can be
   * sold manually. Separate from Close Position, which asks the keeper to
   * sell; this bypasses the keeper entirely. */
  async function handleWithdrawToken() {
    if (!tokenWithdrawAddr) return;
    setTokenWithdrawBusy(true);
    setStatus("");
    try {
      await withdrawToken(tokenWithdrawAddr, setStatus);
      setStatus(`Withdrew all of ${tokenWithdrawAddr} to your wallet.`);
      setTokenWithdrawAddr("");
    } catch (e) {
      setStatus(`Token withdraw failed: ${e.message}`);
    } finally {
      setTokenWithdrawBusy(false);
    }
  }

  /** Direct escape hatch for a "stuck" position - one the keeper gave up
   * retrying and will never revisit on its own (see keeper/src/positions.ts's
   * MAX_STRUCTURAL_EXIT_FAILURES). Pulls that token straight to the owner's
   * wallet, same underlying call as the manual withdraw field below, just
   * pre-targeted at the specific token this row already knows about so
   * there's no address to hunt down and copy in by hand. */
  async function handleWithdrawStuckToken(positionId, tokenAddress) {
    setStuckWithdrawStates((s) => ({ ...s, [positionId]: "pending" }));
    setStatus("");
    try {
      await withdrawToken(tokenAddress, setStatus);
      setStuckWithdrawStates((s) => ({ ...s, [positionId]: "done" }));
      setStatus(`Withdrew all of ${tokenAddress} to your wallet.`);
    } catch (e) {
      setStuckWithdrawStates((s) => ({ ...s, [positionId]: "error" }));
      setStatus(`Token withdraw failed: ${e.message}`);
    }
  }

  /** Signs and submits a close request for one open position. Doesn't sell
   * anything itself - the keeper does that on its next pass, see
   * lib/closePosition.js. */
  async function handleClosePosition(positionId) {
    setCloseStates((s) => ({ ...s, [positionId]: "pending" }));
    try {
      await closePosition(getProvider, vaultAddress, positionId);
      setCloseStates((s) => ({ ...s, [positionId]: "requested" }));
    } catch (e) {
      setCloseStates((s) => ({ ...s, [positionId]: "error" }));
      setStatus(`Close request failed: ${e.message}`);
    }
  }

  /** One signature, every currently-open position requested closed - see
   * lib/closePosition.js's closeAllPositions. Exists because closing dozens
   * of positions one at a time needs that many separate wallet signatures,
   * which isn't realistic to actually get through (confirmed live
   * 2026-08-24). A native confirm() first since this touches every open
   * position at once - cheap insurance against a stray tap. */
  async function handleCloseAllPositions() {
    const openCount = history?.positions?.open?.length ?? 0;
    if (openCount === 0) return;
    if (!window.confirm(`Close all ${openCount} open position${openCount === 1 ? "" : "s"}? The bot will sell each one at whatever the market gives, not wait for a good exit.`)) return;
    setCloseAllState("pending");
    try {
      await closeAllPositions(getProvider, vaultAddress);
      setCloseAllState("requested");
      setStatus(`Requested close on all ${openCount} open positions - the bot will work through them over the next few minutes.`);
    } catch (e) {
      setCloseAllState("error");
      setStatus(`Close-all request failed: ${e.message}`);
    }
  }

  /** Copies this wallet's own referral link. Falls back to selecting the text
   * for manual copy on a browser that blocks the clipboard API (some in-app
   * wallet browsers do), rather than failing silently. */
  async function handleCopyReferralLink() {
    if (!myReferralCode) return;
    const link = `${window.location.origin}/?ref=${myReferralCode}`;
    try {
      await navigator.clipboard.writeText(link);
      setReferralCopied(true);
      setTimeout(() => setReferralCopied(false), 2000);
    } catch {
      setStatus(`Copy this link manually: ${link}`);
    }
  }

  /** Signs and sends one chat message to this vault's Hunter Bot, appends the
   * owner's own message immediately (no round-trip needed to show it), then
   * the live reply once it comes back. The same message is also queued as
   * Hunter IQ feedback server-side (see hunter-chat.js), so it still becomes
   * a lesson even though the reply itself is generated synchronously here. */
  async function handleSendChat(text) {
    setChatMessages((prev) => [...prev, { id: `local-${Date.now()}`, role: "owner", text }]);
    const { reply } = await sendHunterChatMessage(getProvider, vaultAddress, text);
    loadHunterChat(vaultAddress).then((c) => setChatMessages(c.messages)).catch(() => {
      if (reply) setChatMessages((prev) => [...prev, { id: `local-reply-${Date.now()}`, role: "hunter", text: reply }]);
    });
    loadHunterIQ(vaultAddress).then(setHunterIQ).catch(() => {});
  }

  return (
    <div className="page">
      <div className={dirty ? "container has-unsaved-changes" : "container"}>
        <div className="header">
          <Sun size={26} />
          <span className="brand wordmark">ICARIA</span>
          <span className="wordmark-sub">Bots</span>
          <span className="beta-badge">BETA</span>
          <span className="version-tag">v{APP_VERSION}</span>
          <Link href="/faq" style={{ marginLeft: "auto" }} className="btn btn-small">FAQ</Link>
        </div>

        {account && (
          <div className="panel">
            <div className="row" style={{ gap: 6, marginBottom: 14 }}>
              <div className="section-label" style={{ margin: 0 }}>Referral Link</div>
              <InfoButton title="How the referral link works">
                Share this link. Anyone who creates a vault after visiting it is permanently credited
                to you - you earn 0.05% of everything their vault ever trades (the platform keeps
                0.20% instead of its usual 0.25%; they never pay more for having been referred). The
                link carries an opaque code, not your wallet address, so sharing it never lets anyone
                trace it back to which address is yours. Earnings are tracked below and paid into
                your own vault in batches, not automatically on every trade.
              </InfoButton>
            </div>
            <div className="field-inline">
              <input
                type="text"
                readOnly
                value={myReferralCode && typeof window !== "undefined" ? `${window.location.origin}/?ref=${myReferralCode}` : "Loading..."}
                onFocus={(e) => e.target.select()}
                style={{ width: 420 }}
              />
              <button className="btn btn-small" onClick={handleCopyReferralLink} disabled={!myReferralCode}>
                {referralCopied ? "Copied!" : "Copy"}
              </button>
            </div>
            {referralEarnings && (
              <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--edge-soft)" }}>
                <div className="hero-balance" style={{ margin: "0 0 2px" }}>
                  <span className="n num" style={{ fontSize: 28 }}>{fmtBalance(referralEarnings.totalEarnedPls)}</span>
                  <span className="u">{CHAIN.baseSymbol} earned</span>
                </div>
                <p className="hint" style={{ margin: 0 }}>
                  {referralEarnings.referredVaultCount} vault{referralEarnings.referredVaultCount === 1 ? "" : "s"} referred
                  &middot; {fmtBalance(referralEarnings.pendingPls)} {CHAIN.baseSymbol} not yet paid out
                </p>
              </div>
            )}
          </div>
        )}

        {initializing && !account && (
          <div className="panel">
            <p className="lede" style={{ marginBottom: 0 }}>Reconnecting your wallet...</p>
          </div>
        )}

        {!initializing && !account && (
          <div className="panel">
            <p className="lede" style={{ marginBottom: 20 }}>
              Connect the wallet that owns your vault to view its balance, adjust trading rules,
              or deposit and withdraw.
            </p>
            <div className="row">
              <button className="btn btn-primary" onClick={connectInjected} disabled={connecting}>
                {connecting ? "Connecting..." : "Connect Wallet"}
              </button>
              <button className="btn" onClick={connectWalletConnect} disabled={connecting}>
                {connecting ? "Connecting..." : "Connect via WalletConnect"}
              </button>
            </div>
            <p className="hint">
              On desktop with a wallet extension installed, use "Connect Wallet." On a phone, or with
              a wallet like Internet Money that isn't a browser extension, use "Connect via WalletConnect."
            </p>
          </div>
        )}

        {account && !vaultAddress && (
          <div className="panel">
            <p className="mono-addr" style={{ marginBottom: 14 }}>Connected: {account}</p>
            <p className="lede" style={{ marginBottom: 16 }}>No vault found for this wallet yet.</p>
            <div className="field-inline">
              <label>Referral code (optional)</label>
              <input
                type="text"
                placeholder="referral code"
                value={referralCode}
                onChange={(e) => setReferralCode(e.target.value)}
                style={{ width: 340 }}
              />
            </div>
            <p className="hint" style={{ marginTop: -6, marginBottom: 16 }}>
              Filled in automatically if you arrived via someone's referral link. This is set once,
              permanently, when your vault is created - there's no way to add or change it later.
            </p>
            <button className="btn btn-primary" onClick={handleCreateVault} disabled={txBusy}>
              {txBusy ? "Working..." : "Create My Vault"}
            </button>
          </div>
        )}

        {account && <ManageVaultByAddress getProvider={getProvider} account={account} />}

        {account && vaultAddress && vaultInfo && (
          <div>
            <p className="mono-addr" style={{ marginBottom: 4 }}>Connected: {account}</p>

            <div className="hero">
              <div className="hero-top">
                <span className="hero-label">
                  Your Vault &middot; {vaultKind === "multiVenueV4" ? "Trades on V2, V3, and V4" : vaultKind === "multiVenue" ? "Trades on V2 and V3" : "Trades on V2 only"}
                </span>
                <span className={vaultInfo.paused ? "status-pill is-paused" : "status-pill"}>
                  <span className={vaultInfo.paused ? "dot" : "dot pulse"} />
                  {vaultInfo.paused ? "Paused" : "Active"}
                </span>
              </div>
              <span className="hero-balance-label">Liquid {CHAIN.baseSymbol} &middot; available to trade</span>
              <div className="hero-balance">
                <span className="n num">{fmtBalance(vaultInfo.baseBalance)}</span>
                <span className="u">{CHAIN.baseSymbol}</span>
              </div>
              {(() => {
                const openVal = openPositionsValue(history);
                if (!openVal || openVal.count === 0) return null;
                const totalPls = Number(vaultInfo.baseBalance) + openVal.valuePls;
                return (
                  <p className="hero-sub" style={{ marginBottom: 10, lineHeight: 1.6 }}>
                    + {fmtEstimate(openVal.valuePls, CHAIN.valueMaxDecimals)} {CHAIN.nativeSymbol} working in {openVal.count} open position{openVal.count === 1 ? "" : "s"}
                    {openVal.unpriced > 0 ? ` (${openVal.unpriced} couldn't be priced just now)` : ""}
                    <br />
                    <strong style={{ color: "var(--text)" }}>
                      &asymp; {fmtEstimate(totalPls, CHAIN.valueMaxDecimals)} {CHAIN.nativeSymbol} total account value
                    </strong>
                    {" "}<span style={{ fontWeight: 400 }}>(estimate - not a guaranteed sale price)</span>
                  </p>
                );
              })()}
              <p className="hero-sub mono-addr" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                {vaultAddress}
                <CopyAddressButton address={vaultAddress} />
              </p>
              <div className="hero-actions">
                <button className="btn btn-small" onClick={handleRefresh} disabled={refreshing}>
                  {refreshing ? "Refreshing..." : "Refresh"}
                </button>
                <button className="btn btn-small" onClick={handleTogglePause} disabled={txBusy}>
                  {txBusy ? "Working..." : vaultInfo.paused ? "Resume Bot" : "Pause Bot"}
                </button>
              </div>
              <p className="hint" style={{ marginTop: 14, marginBottom: 0 }}>
                Balance and holdings update automatically every 20 seconds - use Refresh to update
                immediately instead of waiting. Pausing stops the keeper from trading immediately;
                you can resume it yourself right here. Neither one affects deposits or withdrawals,
                which always stay available to you as the owner.
              </p>
              {referred && (
                <p className="hint" style={{ marginBottom: 0 }}>
                  This vault was created via a referral link.
                </p>
              )}
            </div>

            <div className="panel">
              <div className="section-label">Deposit / Withdraw</div>
              <p className="hint" style={{ marginTop: 0 }}>
                Wallet balance: {fmtBalance(vaultInfo.walletBaseBalance)} {CHAIN.baseSymbol}
              </p>
              <div className="field-inline">
                <label>Amount ({CHAIN.baseSymbol})</label>
                <NumberField value={amount} onChange={setAmount} asString style={{ width: 160 }} />
              </div>
              <div className="row">
                <button className="btn btn-primary" onClick={handleDeposit} disabled={txBusy || !amount}>
                  {txBusy ? "Working..." : "Deposit"}
                </button>
                {/* The exact on-chain balance to full precision - the displayed
                    balance is truncated for reading and typing it back in
                    could otherwise leave a dust amount unsendable. Wallet
                    balance for deposit, vault balance for withdraw - they're
                    two different pools of WPLS and mixing them up is exactly
                    what left people depositing blind before this existed. */}
                <button type="button" className="btn btn-small" onClick={() => setAmount(vaultInfo.walletBaseBalance)}>
                  Max
                </button>
                <button className="btn" onClick={handleWithdraw} disabled={txBusy || !amount}>
                  {txBusy ? "Working..." : "Withdraw"}
                </button>
                <button type="button" className="btn btn-small" onClick={() => setAmount(vaultInfo.baseBalance)}>
                  Max
                </button>
              </div>
            </div>

            <div className="panel">
              <div className="row" style={{ gap: 6, marginBottom: 14 }}>
                <div className="section-label" style={{ margin: 0 }}>Deposit a Token</div>
                <InfoButton title="Deposit a Token">
                  Already holding a token and want the bot watching it for a take-profit target? Paste
                  its contract address below - this sends it straight from your wallet into the vault
                  (not through the {CHAIN.baseSymbol} Deposit above, which only handles {CHAIN.baseSymbol}
                  itself). Once it lands, it shows up on Current Holdings with a Close Position and
                  Withdraw to Wallet button, same as anything the bot bought itself - add a Limit Order
                  below for your actual target price.
                </InfoButton>
              </div>
              <div className="field-inline">
                <label>Token address</label>
                <input
                  type="text" placeholder="0x..." value={depositTokenAddr}
                  onChange={(e) => setDepositTokenAddr(e.target.value.trim())}
                  style={{ width: 320, fontFamily: "monospace" }}
                />
              </div>
              {depositTokenAddr && (
                <p className="hint" style={{ marginTop: -6 }}>
                  {depositTokenInfo === "loading" && "Looking it up..."}
                  {depositTokenInfo === "notfound" && "Couldn't find that token - check the address."}
                  {depositTokenInfo && typeof depositTokenInfo === "object" &&
                    `${depositTokenInfo.symbol}: wallet balance ${fmtBalance(depositTokenInfo.balance)}`}
                </p>
              )}
              <div className="field-inline">
                <label>Amount</label>
                <NumberField value={depositTokenAmount} onChange={setDepositTokenAmount} asString style={{ width: 160 }} />
                {depositTokenInfo && typeof depositTokenInfo === "object" && (
                  <button type="button" className="btn btn-small" onClick={() => setDepositTokenAmount(depositTokenInfo.balance)}>
                    Max
                  </button>
                )}
              </div>
              <div className="row">
                <button
                  className="btn btn-primary" onClick={handleDepositToken}
                  disabled={depositTokenBusy || !depositTokenAmount || typeof depositTokenInfo !== "object" || !depositTokenInfo}
                >
                  {depositTokenBusy ? "Working..." : "Deposit Token"}
                </button>
              </div>
            </div>

            {history ? (
              <>
                <div className="hero">
                  <PnlSnapshot history={history} />
                </div>

                <div className="panel">
                  <HistoryPanel
                    history={history} onClosePosition={handleClosePosition} closeStates={closeStates}
                    onWithdrawStuckToken={handleWithdrawStuckToken} withdrawStuckStates={stuckWithdrawStates}
                    onCloseAll={handleCloseAllPositions} closeAllState={closeAllState}
                  />
                </div>
              </>
            ) : (
              <div className="panel">
                <div className="row" style={{ gap: 10, flexWrap: "nowrap", alignItems: "flex-start" }}>
                  <span className="spinner" aria-hidden="true" style={{ marginTop: 3 }} />
                  <p className="hint" style={{ margin: 0, flex: 1, minWidth: 0 }}>
                    {historyError
                      ? "Couldn't load your positions right now - most likely the PulseChain RPC is congested. Retrying automatically every 20 seconds, no action needed."
                      : "Loading your positions..."}
                  </p>
                </div>
              </div>
            )}

            <div className="panel">
              <PortfolioPanel portfolio={portfolio} />
            </div>

            {config && (
              <>
                {dirty && (
                  <div className="status-msg" style={{ marginBottom: 20, borderColor: "var(--amber)", color: "var(--amber)" }}>
                    You have unsaved changes. Nothing below takes effect for the bot until you click
                    "Save All Settings" at the bottom of this page.
                  </div>
                )}

                <BotCard
                  title="Trading Bots"
                  icon={<TradingBotsIcon />}
                  active={(config.rules ?? []).some((r) => r.enabled)}
                  statLine={botStatLine(history, "trading")}
                  perfDetail={botPerfDetail(history, "trading")}
                  info={
                    <>
                      Each one watches a single token you pick and buys the dip (or the top) on
                      its own, independently of every other bot. Add as many as you want - one
                      per token you want to run a rule against.
                    </>
                  }
                >
                  <RulesList
                    rules={config.rules}
                    onChange={(rules) => updateConfig({ ...config, rules })}
                  />
                </BotCard>

                <BotCard
                  title="Launch Bot"
                  icon={<LaunchIcon />}
                  active={config.launch.enabled}
                  statLine={botStatLine(history, "launch")}
                  perfDetail={botPerfDetail(history, "launch")}
                  info={
                    <>
                      Watches {CHAIN.dexName} for brand-new pairs the moment they're created and can
                      buy automatically the instant one clears your safety screen - buy/sell tax, LP
                      lock, how much supply the deployer holds, and a minimum liquidity floor. Built
                      for speed: a launch is judged and acted on within its first few blocks of
                      existing, before most people even see it.
                    </>
                  }
                >
                  <LaunchSettings
                    launch={config.launch}
                    onChange={(launch) => updateConfig({ ...config, launch })}
                  />
                </BotCard>

                <BotCard
                  title="Sniper Bot"
                  icon={<SniperIcon />}
                  active={(config.snipes ?? []).some((s) => s.enabled)}
                  statLine={botStatLine(history, "snipe")}
                  perfDetail={botPerfDetail(history, "snipe")}
                  info={
                    <>
                      Have a specific contract address you want to buy the second it's tradeable?
                      Add it here and this bot watches that one address, independently of Launch
                      Bot's own discovery - for a token you spotted before its pool even exists.
                    </>
                  }
                >
                  <SnipesList
                    snipes={config.snipes ?? []}
                    onChange={(snipes) => updateConfig({ ...config, snipes })}
                  />
                </BotCard>

                <BotCard
                  title={<>Hunter<span className="iq-accent">IQ</span> Bot</>}
                  titleText="HunterIQ Bot"
                  icon={<HunterIcon />}
                  active={config.hunter.enabled}
                  statLine={botStatLine(history, "hunter")}
                  perfDetail={botPerfDetail(history, "hunter", config.hunter)}
                  info={
                    <>
                      Watches tokens already trading for technical dips - RSI oversold, a bullish MACD
                      cross, or price riding the lower Bollinger band. A setup still has to clear the
                      same honeypot/tax/LP-lock screen Launch Bot uses, and can optionally require an
                      AI sanity check before it's allowed to auto-buy.
                    </>
                  }
                >
                  <HunterSettings
                    hunter={config.hunter}
                    onChange={(hunter) => updateConfig({ ...config, hunter })}
                  />
                </BotCard>

                <BotCard
                  title="Limit Order Bot"
                  icon={<LimitOrderIcon />}
                  active={(config.limitOrders ?? []).some((o) => o.enabled)}
                  statLine={botStatLine(history, "limit")}
                  perfDetail={botPerfDetail(history, "limit")}
                  info={
                    <>
                      A resting buy or sell order on a token you already hold or already trust -
                      you set the price, it fires the instant the market reaches it. No honeypot
                      or tax screening runs on these, since the assumption is you already know
                      the token. Have as many outstanding at once as you want.
                    </>
                  }
                >
                  <LimitOrdersList
                    orders={config.limitOrders ?? []}
                    onChange={(limitOrders) => updateConfig({ ...config, limitOrders })}
                  />
                </BotCard>

                <div className="panel">
                  <HunterIQPanel hunterIQ={hunterIQ} chatMessages={chatMessages} onSendChat={handleSendChat} />
                </div>

                <div className="panel">
                  <div className="section-label">Safety</div>
                  <div className="field-inline">
                    <label>Never let one token exceed</label>
                    <NumberField {...numberFieldProps(config.maxHoldingPct, (v) => updateConfig({ ...config, maxHoldingPct: v }))}
                      min="0" max="100" style={{ width: 70 }} />
                    <span style={{ color: "var(--ash)", fontSize: 13 }}>% of the vault</span>
                  </div>
                  <p className="hint">
                    The most important safety setting. Stops one bad bot from putting the whole
                    vault into one falling token.
                  </p>
                </div>

                <button className={dirty ? "btn btn-primary" : "btn"} onClick={handleSave} disabled={saving}>
                  {saving ? "Saving..." : dirty ? "Save All Settings (unsaved changes)" : "Save All Settings"}
                </button>

                {/* Pinned to the viewport while anything is unsaved - the top-of-page
                    warning scrolls away, and an unsaved launch bot someone believes
                    is live is the single most confusing failure this UI can produce. */}
                {dirty && (
                  <div className={saveError ? "unsaved-bar unsaved-bar-error" : "unsaved-bar"}>
                    <span>
                      {saveError
                        ? `Save failed: ${saveError}`
                        : "Your changes are NOT live yet - the bot is still running the old settings."}
                    </span>
                    <button className="btn btn-primary btn-small" onClick={handleSave} disabled={saving}>
                      {saving ? "Saving..." : "Save now"}
                    </button>
                  </div>
                )}
              </>
            )}

            <div className="panel">
              <div className="section-label">Emergency: Withdraw a Token Directly</div>
              <p className="hint" style={{ marginBottom: 14 }}>
                If a position won't close through the normal Close Position button, this pulls the
                vault's entire balance of that token straight to your own wallet - it doesn't sell it,
                just gets it out so you can sell it yourself.
              </p>
              <div className="field-inline">
                <label>Token address</label>
                <input type="text" placeholder="0x..." value={tokenWithdrawAddr}
                  onChange={(e) => setTokenWithdrawAddr(e.target.value)} style={{ width: 340 }} />
              </div>
              <button className="btn btn-danger" onClick={handleWithdrawToken} disabled={tokenWithdrawBusy || !tokenWithdrawAddr}>
                {tokenWithdrawBusy ? "Working..." : "Withdraw This Token"}
              </button>
            </div>

            <div className="panel">
              <div className="section-label">Emergency: Revoke Executor</div>
              <p className="hint" style={{ marginBottom: 14 }}>
                Strips the keeper's ability to trade this vault at all, permanently, whether or not
                the keeper server is even running - the strongest stop there is. Getting it trading
                again afterward requires a separate action outside this page. This never affects
                deposits or withdrawals, which always stay available to you as the owner.
              </p>
              <button className="btn btn-danger" onClick={handleRevokeExecutor} disabled={txBusy}>
                {txBusy ? "Working..." : "Revoke Executor"}
              </button>
            </div>
          </div>
        )}

        {status && <p className="status-msg" style={{ marginTop: 20 }}>{status}</p>}
        {error && <p className="error-msg" style={{ marginTop: 20 }}>{error}</p>}
      </div>
    </div>
  );
}
