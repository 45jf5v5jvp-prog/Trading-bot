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
import time
from datetime import datetime
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
def _step(n: int, title: str) -> None:
    print(f"\n\u2500\u2500 Step {n} of 6: {title} " + "\u2500" * max(0, 40 - len(title)))


def _pause(msg: str = "Press Return when you're done") -> None:
    input(f"   {msg}... ")


def _ask_secret(label: str, existing: str | None, check) -> str | None:
    """Ask for a password/key until `check(value)` passes (3 tries). Returns the working value."""
    for attempt in range(3):
        hint = " (already saved - just press Return to keep it)" if existing else ""
        value = getpass.getpass(f"   Paste your {label}{hint}\n   (it stays hidden as you paste): ").strip()
        value = value.replace(" ", "") or existing or ""
        if not value:
            print("   Nothing was pasted. Try again.")
            continue
        try:
            check(value)
            return value
        except Exception as e:
            print(f"   \u2717 That didn't work ({e}).")
            if attempt < 2:
                print("   Check it and paste it again.")
    return None


def _open_url(url: str) -> None:
    subprocess.run(["open", url], capture_output=True)


def cmd_setup(_args) -> None:
    from .runner import FORCE_SCAN, health
    from .store import Store

    cfg = config.load()
    print("Welcome! This sets up your assistant. It takes about 10 minutes.")
    print("Anything in [brackets] is already filled in: just press Return to keep it.")

    _step(1, "Your email")
    cfg.email.enabled = _yes("   Should the assistant read your iCloud email?", cfg.email.enabled)
    if cfg.email.enabled:
        cfg.email.username = _ask("   Your iCloud email address", cfg.email.username)
        print(
            "\n   Apple needs a special password just for this (NOT your normal Apple password).\n"
            "   I'll open the Apple website now. Sign in, then choose:\n"
            "     Sign-In and Security \u2192 App-Specific Passwords \u2192 + \n"
            "   Name it \"Assistant\", then copy the password it shows you (xxxx-xxxx-xxxx-xxxx)."
        )
        _pause("Press Return to open the Apple website")
        _open_url("https://account.apple.com/account/manage")
        from .sources import email_imap

        pw = _ask_secret(
            "app-specific password",
            keychain.get(keychain.ICLOUD_APP_PASSWORD),
            lambda v: email_imap.test_login(cfg.email, v),
        )
        if pw:
            keychain.put(keychain.ICLOUD_APP_PASSWORD, pw)
            print("   \u2713 Connected to your email")
        else:
            print("   Skipping email for now. Run setup again later to add it.")
            cfg.email.enabled = False

    _step(2, "Your texts")
    cfg.messages.enabled = _yes("   Should the assistant read your text messages?", cfg.messages.enabled)

    _step(3, "The AI key")
    print(
        "   The assistant uses Claude (an AI) to read your messages and spot plans and to-dos.\n"
        "   You need a key for it: a long code starting with sk-ant-.\n"
        "   If someone set this up for you, they will have sent it to you."
    )
    import anthropic

    key = _ask_secret(
        "AI key",
        keychain.get(keychain.ANTHROPIC_API_KEY),
        lambda v: anthropic.Anthropic(api_key=v).models.retrieve(cfg.ai.model),
    )
    if key:
        keychain.put(keychain.ANTHROPIC_API_KEY, key)
        print("   \u2713 AI key works")
    else:
        print("   Without the key, email and text suggestions are off. Your to-dos still sync.")

    _step(4, "How you'll approve things")
    print(
        f"   New suggestions will wait in a Reminders list called \u201c{cfg.reminders.inbox_list}\u201d.\n"
        "   Tick one to add it to your calendar. Delete it if you don't want it.\n"
        "   The assistant can text you when new ones arrive."
    )
    cfg.notify.imessage_to = _ask(
        "   Your mobile number for those texts (or press Return to skip)", cfg.notify.imessage_to
    )
    times = _ask(
        "   Times to check email and texts (24-hour clock)", ", ".join(cfg.schedule.scan_times)
    )
    cfg.schedule.scan_times = [t.strip() for t in times.split(",") if t.strip()]
    cfg.calendar.todo_calendar = _ask(
        "   Name of the calendar your to-dos will appear on", cfg.calendar.todo_calendar
    )
    config.save(cfg)

    _step(5, "Calendar and Reminders permission")
    print("   Your Mac will ask whether Terminal can use Calendars and Reminders. Click Allow.")
    from .apple import AppleBackend

    backend = AppleBackend()
    backend.ensure_calendar(cfg.calendar.todo_calendar)
    backend.ensure_reminder_list(cfg.reminders.inbox_list)
    print("   \u2713 Calendar and Reminders connected")

    _step(6, "Start the assistant")
    if cfg.messages.enabled:
        _guide_full_disk_access()
    store = Store(config.DB_PATH)
    store.set(FORCE_SCAN, "1")
    store.commit()
    started = time.time()
    cmd_install(None)
    print(
        "\n   The assistant is starting. If your Mac asks whether \"python\" can use\n"
        "   Calendars, Reminders or Messages, click Allow (or OK)."
    )
    print("   Checking that everything works (up to 2 minutes)", end="", flush=True)
    wanted = [p for p, on in (("email", cfg.email.enabled), ("messages", cfg.messages.enabled)) if on]
    results: dict = {}
    while time.time() - started < 120 and len(results) < len(wanted):
        time.sleep(3)
        print(".", end="", flush=True)
        for part in wanted:
            h = health(Store(config.DB_PATH), part)
            if h and datetime.fromisoformat(h["at"]).timestamp() >= started:
                results[part] = h
    print()
    labels = {"email": "Reading your email", "messages": "Reading your texts"}
    all_ok = True
    for part in wanted:
        h = results.get(part)
        if h and h["ok"]:
            print(f"   \u2713 {labels[part]}")
        else:
            all_ok = False
            print(f"   \u2717 {labels[part]}: {h['detail'] if h else 'no answer yet'}")
    if "messages" in wanted and not (results.get("messages") or {}).get("ok"):
        print(
            "     Texts need the Full Disk Access switch from this step. Turn it on, then\n"
            "     open Terminal and type:  assistant setup"
        )
    if all_ok:
        print("\nAll done! Add a reminder with a date and it will appear on your calendar shortly.")
    print("You can close this window. The assistant keeps running in the background.")


def _guide_full_disk_access() -> None:
    python = os.path.realpath(sys.executable)
    print(
        "   To read your texts, the assistant needs one permission that you switch on by hand.\n"
        "   I'll open two windows:\n"
        "     \u2022 System Settings, on the \"Full Disk Access\" page\n"
        f"     \u2022 a Finder window with a file called \"{os.path.basename(python)}\" selected\n"
        "   Drag that file from Finder into the list in System Settings, and make sure its\n"
        "   switch is on. (Your Mac may ask for your password or Touch ID. That's normal.)"
    )
    _pause("Press Return to open them")
    _open_url("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")
    subprocess.run(["open", "-R", python], capture_output=True)
    _pause()


def cmd_run(args) -> None:
    from .apple import AppleBackend
    from .runner import record_health, run_once
    from .store import Store

    cfg = config.load()
    store = Store(config.DB_PATH)
    try:
        backend = AppleBackend()
        backend.store.calendarsForEntityType_(0)  # touch EventKit so access problems show up
    except Exception as e:
        record_health(store, "calendar", False, str(e))
        raise
    record_health(store, "calendar", True)
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
    from .runner import health
    from .store import Store

    print(f"Settings:        {config.CONFIG_PATH} ({'found' if config.CONFIG_PATH.exists() else 'missing - run setup'})")
    print(f"Python:          {os.path.realpath(sys.executable)}")
    print(f"Background job:  {'installed' if AGENT_PLIST.exists() else 'not installed'}")
    print(f"Email password:  {'saved' if keychain.get(keychain.ICLOUD_APP_PASSWORD) else 'missing'}")
    print(f"AI key:          {'saved' if keychain.get(keychain.ANTHROPIC_API_KEY) else 'missing'}")
    try:
        from .apple import AppleBackend

        for k, v in AppleBackend.access_status().items():
            print(f"{k + ' (Terminal):':17}{v}")
    except ImportError:
        print("EventKit not available (is this a Mac?)")
    store = Store(config.DB_PATH)
    print("\nWhat the background job saw last time:")
    for part, label in (("calendar", "Calendar/Reminders"), ("email", "Email"), ("messages", "Texts")):
        h = health(store, part)
        if h is None:
            print(f"  {label:20}not checked yet")
        else:
            state = "\u2713 ok" if h["ok"] else f"\u2717 {h['detail']}"
            print(f"  {label:20}{state}  ({h['at'][:16].replace('T', ' ')})")
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
