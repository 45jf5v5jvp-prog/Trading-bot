"""Command line: `assistant setup | run | scan | sync | status | doctor | install | uninstall`."""

from __future__ import annotations

import argparse
import getpass
import logging
import logging.handlers
import os
import plistlib
import subprocess
import sys
from pathlib import Path

from . import config, keychain

AGENT_LABEL = "com.personal-assistant"
AGENT_PLIST = Path.home() / "Library" / "LaunchAgents" / f"{AGENT_LABEL}.plist"
RUN_EVERY_SECONDS = 300


def _setup_logging(verbose: bool) -> None:
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    handlers: list[logging.Handler] = [
        logging.handlers.RotatingFileHandler(config.LOG_PATH, maxBytes=1_000_000, backupCount=3)
    ]
    if verbose or sys.stdout.isatty():
        handlers.append(logging.StreamHandler())
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        handlers=handlers,
    )


def _open():
    from .apple import AppleBackend
    from .store import Store

    cfg = config.load()
    return AppleBackend(), Store(config.DB_PATH), cfg


def _ask(prompt: str, default: str = "") -> str:
    suffix = f" [{default}]" if default else ""
    answer = input(f"{prompt}{suffix}: ").strip()
    return answer or default


def _yes(prompt: str, default: bool = True) -> bool:
    answer = input(f"{prompt} [{'Y/n' if default else 'y/N'}]: ").strip().lower()
    return default if not answer else answer.startswith("y")


# --------------------------------------------------------------------- commands
def cmd_setup(_args) -> None:
    cfg = config.load()
    print("\nPersonal Assistant setup. Press Enter to keep the value in [brackets].\n")

    print("1) iCloud Mail")
    cfg.email.enabled = _yes("   Read your iCloud email for things to add?", cfg.email.enabled)
    if cfg.email.enabled:
        cfg.email.username = _ask("   iCloud email address", cfg.email.username)
        print(
            "   You need an app-specific password (not your Apple ID password):\n"
            "   appleid.apple.com > Sign-In and Security > App-Specific Passwords > +"
        )
        existing = keychain.get(keychain.ICLOUD_APP_PASSWORD)
        pw = getpass.getpass(
            "   App-specific password" + (" [saved, Enter to keep]" if existing else "") + ": "
        ).strip()
        if pw:
            keychain.put(keychain.ICLOUD_APP_PASSWORD, pw)
        from .sources import email_imap

        try:
            email_imap.test_login(cfg.email, pw or existing or "")
            print("   ✓ Signed in to iCloud Mail")
        except Exception as e:
            print(f"   ✗ Couldn't sign in ({e}). Re-run setup to try again.")

    print("\n2) Text messages")
    cfg.messages.enabled = _yes("   Read your texts for things to add?", cfg.messages.enabled)

    print("\n3) Claude (reads the emails/texts and picks out what matters)")
    print("   Create an API key at console.anthropic.com > API Keys.")
    existing = keychain.get(keychain.ANTHROPIC_API_KEY)
    key = getpass.getpass(
        "   Anthropic API key" + (" [saved, Enter to keep]" if existing else "") + ": "
    ).strip()
    if key:
        keychain.put(keychain.ANTHROPIC_API_KEY, key)
    try:
        import anthropic

        anthropic.Anthropic(api_key=key or existing).models.retrieve(cfg.ai.model)
        print("   ✓ API key works")
    except Exception as e:
        print(f"   ✗ API key check failed ({e})")

    print("\n4) Approvals")
    print(
        f"   Suggestions wait in a Reminders list called “{cfg.reminders.inbox_list}”.\n"
        "   Check one off to approve it, delete it to dismiss it."
    )
    cfg.notify.imessage_to = _ask(
        "   Your phone number or Apple ID email to iMessage you when new ones arrive "
        "(blank = Mac notification only)",
        cfg.notify.imessage_to,
    )
    times = _ask("   When should it check email/texts? (24h times)", ", ".join(cfg.schedule.scan_times))
    cfg.schedule.scan_times = [t.strip() for t in times.split(",") if t.strip()]

    print("\n5) To-do list → calendar")
    cfg.reminders.sync_to_calendar = _yes(
        "   Put dated Reminders on your calendar automatically?", cfg.reminders.sync_to_calendar
    )
    cfg.calendar.todo_calendar = _ask("   Calendar name for to-dos", cfg.calendar.todo_calendar)

    config.save(cfg)
    print(f"\nSaved settings to {config.CONFIG_PATH}")

    print("\nAsking macOS for Calendar and Reminders access (click Allow)...")
    from .apple import AppleBackend

    backend = AppleBackend()
    backend.ensure_calendar(cfg.calendar.todo_calendar)
    backend.ensure_reminder_list(cfg.reminders.inbox_list)
    print("✓ Calendar and Reminders ready")

    if cfg.messages.enabled:
        _check_messages_access(cfg)

    if _yes("\nStart running in the background now?"):
        cmd_install(None)
    print("\nAll set. Run `assistant doctor` any time to check on things.")


def _check_messages_access(cfg) -> bool:
    from .sources import messages

    try:
        db = messages.open_db(cfg.messages.chat_db)
        db.execute("SELECT 1 FROM message LIMIT 1").fetchall()
        db.close()
        print("✓ Can read Messages")
        return True
    except Exception as e:
        print(
            f"✗ Can't read Messages yet ({e}).\n"
            "  Open System Settings > Privacy & Security > Full Disk Access, click +,\n"
            "  press Cmd+Shift+G and paste this path, then turn it on:\n"
            f"    {os.path.realpath(sys.executable)}\n"
            "  (Also add Terminal if you run commands from Terminal.)"
        )
        return False


def cmd_run(args) -> None:
    from .runner import run_once

    backend, store, cfg = _open()
    run_once(backend, store, cfg, force_scan=getattr(args, "scan", False))


def cmd_scan(_args) -> None:
    from .runner import scan

    backend, store, cfg = _open()
    added = scan(backend, store, cfg)
    print(f"{len(added)} new suggestion(s) added to “{cfg.reminders.inbox_list}”.")


def cmd_sync(_args) -> None:
    from . import inbox, reminders_sync

    backend, store, cfg = _open()
    print("Inbox:", inbox.process_decisions(backend, store, cfg))
    print("Reminders → calendar:", reminders_sync.sync(backend, store, cfg))


def cmd_status(_args) -> None:
    from .inbox import describe_when
    from .store import Store

    store = Store(config.DB_PATH)
    pending = store.suggestions("pending")
    print(f"{len(pending)} suggestion(s) waiting for you:")
    for s in pending:
        print(f"  • {s.title} — {describe_when(s.start, s.all_day, None)}  ({s.source_label})")
    print(f"Last email/text scan: {store.get('last_scan', 'never')}")
    print(f"Log file: {config.LOG_PATH}")


def cmd_doctor(_args) -> None:
    cfg = config.load()
    print(f"Settings:      {config.CONFIG_PATH} ({'found' if config.CONFIG_PATH.exists() else 'missing - run setup'})")
    print(f"Python:        {os.path.realpath(sys.executable)}")
    print(f"Background job: {'installed' if AGENT_PLIST.exists() else 'not installed'}")
    print(f"iCloud password saved:  {'yes' if keychain.get(keychain.ICLOUD_APP_PASSWORD) else 'no'}")
    print(f"Anthropic key saved:    {'yes' if keychain.get(keychain.ANTHROPIC_API_KEY) else 'no'}")
    try:
        from .apple import AppleBackend

        for k, v in AppleBackend.access_status().items():
            print(f"{k + ' access:':24}{v}")
    except ImportError:
        print("EventKit not available (are you on a Mac with requirements installed?)")
    if cfg.messages.enabled:
        _check_messages_access(cfg)
    if config.LOG_PATH.exists():
        print("\nLast log lines:")
        print("".join(config.LOG_PATH.read_text().splitlines(keepends=True)[-15:]))


def cmd_install(_args) -> None:
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    AGENT_PLIST.parent.mkdir(parents=True, exist_ok=True)
    plist = {
        "Label": AGENT_LABEL,
        "ProgramArguments": [sys.executable, "-m", "assistant", "run"],
        "StartInterval": RUN_EVERY_SECONDS,
        "RunAtLoad": True,
        "StandardOutPath": str(config.DATA_DIR / "launchd.out.log"),
        "StandardErrorPath": str(config.DATA_DIR / "launchd.err.log"),
        "EnvironmentVariables": {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin"},
    }
    with open(AGENT_PLIST, "wb") as f:
        plistlib.dump(plist, f)
    uid = os.getuid()
    subprocess.run(["launchctl", "bootout", f"gui/{uid}", str(AGENT_PLIST)], capture_output=True)
    subprocess.run(["launchctl", "bootstrap", f"gui/{uid}", str(AGENT_PLIST)], check=True)
    print(f"✓ Running in the background every {RUN_EVERY_SECONDS // 60} minutes.")
    print("  If macOS asks whether python may access Calendars, Reminders or Messages, click Allow.")


def cmd_uninstall(_args) -> None:
    if AGENT_PLIST.exists():
        subprocess.run(
            ["launchctl", "bootout", f"gui/{os.getuid()}", str(AGENT_PLIST)], capture_output=True
        )
        AGENT_PLIST.unlink()
    print("Background job removed. Your settings and calendar events were left as they are.")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="assistant", description="Your personal calendar assistant")
    parser.add_argument("-v", "--verbose", action="store_true")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("setup", help="Interactive first-time setup").set_defaults(func=cmd_setup)
    p = sub.add_parser("run", help="One pass (what the background job runs)")
    p.add_argument("--scan", action="store_true", help="Scan email/texts even if not scheduled")
    p.set_defaults(func=cmd_run)
    sub.add_parser("scan", help="Scan email and texts right now").set_defaults(func=cmd_scan)
    sub.add_parser("sync", help="Sync Reminders and approvals right now").set_defaults(func=cmd_sync)
    sub.add_parser("status", help="Show suggestions waiting for approval").set_defaults(func=cmd_status)
    sub.add_parser("doctor", help="Check permissions and settings").set_defaults(func=cmd_doctor)
    sub.add_parser("install", help="Start the background job").set_defaults(func=cmd_install)
    sub.add_parser("uninstall", help="Stop the background job").set_defaults(func=cmd_uninstall)
    args = parser.parse_args(argv)
    _setup_logging(args.verbose)
    try:
        args.func(args)
    except KeyboardInterrupt:
        print()
    except Exception:
        logging.getLogger(__name__).exception("assistant %s failed", args.command)
        sys.exit(1)
