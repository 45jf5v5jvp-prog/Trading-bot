"""One pass of the assistant. The background job runs this every few minutes."""

from __future__ import annotations

import json
import logging
import sqlite3
from datetime import datetime, timedelta

from . import inbox, keychain, notify, reminders_sync
from .backend import Backend
from .config import Config
from .models import SourceItem
from .sources import email_imap, messages
from .store import Store

log = logging.getLogger(__name__)

LAST_SCAN = "last_scan"
EMAIL_CURSORS = "email_cursors"
TEXT_CURSOR = "text_cursor"
FORCE_SCAN = "force_scan"


def record_health(store: Store, part: str, ok: bool, detail: str = "") -> None:
    """Remember whether the background job could reach email/texts/calendar (shown by doctor/setup)."""
    store.set(
        f"health.{part}",
        json.dumps({"ok": ok, "detail": detail, "at": datetime.now().astimezone().isoformat()}),
    )
    store.commit()


def health(store: Store, part: str) -> dict | None:
    raw = store.get(f"health.{part}")
    return json.loads(raw) if raw else None


def latest_slot(now: datetime, scan_times: list[str]) -> datetime | None:
    """The most recent scheduled scan time at or before `now`."""
    candidates = []
    for day_offset in (0, -1):
        day = (now + timedelta(days=day_offset)).date()
        for t in scan_times:
            hh, mm = (int(x) for x in t.split(":"))
            slot = datetime(day.year, day.month, day.day, hh, mm).astimezone()
            if slot <= now:
                candidates.append(slot)
    return max(candidates) if candidates else None


def scan_due(now: datetime, scan_times: list[str], last_scan: datetime | None) -> bool:
    if last_scan is None:
        return True
    slot = latest_slot(now, scan_times)
    return slot is not None and last_scan < slot


def collect(cfg: Config, store: Store) -> tuple[list[SourceItem], dict]:
    """Gather new emails and texts. Returns items plus cursor updates to save on success."""
    items: list[SourceItem] = []
    updates: dict = {}

    if cfg.email.enabled and cfg.email.username:
        password = keychain.get(keychain.ICLOUD_APP_PASSWORD)
        if not password:
            log.warning("No iCloud app-specific password saved; run `assistant setup`.")
        else:
            try:
                cursors = json.loads(store.get(EMAIL_CURSORS, "{}"))
                found, new_cursors = email_imap.fetch_new(cfg.email, password, cursors)
                items += found
                updates[EMAIL_CURSORS] = json.dumps(new_cursors)
                log.info("Email: %d new message(s)", len(found))
                record_health(store, "email", True)
            except Exception as e:  # keep going with texts if mail is down
                log.error("Reading email failed: %s", e)
                record_health(store, "email", False, str(e))

    if cfg.messages.enabled:
        try:
            saved = store.get(TEXT_CURSOR)
            found, cursor = messages.fetch_new(cfg.messages, int(saved) if saved else None)
            items += found
            updates[TEXT_CURSOR] = str(cursor)
            log.info("Texts: %d conversation(s) with new messages", len(found))
            record_health(store, "messages", True)
        except sqlite3.OperationalError as e:
            record_health(store, "messages", False, str(e))
            log.error(
                "Can't read Messages (%s). Give Full Disk Access to the python program "
                "shown by `assistant doctor` in System Settings > Privacy & Security.",
                e,
            )
    return items, updates


def scan(backend: Backend, store: Store, cfg: Config, now: datetime | None = None) -> list:
    from .extract import Extractor  # imported lazily so sync-only runs don't need the SDK

    now = now or datetime.now().astimezone()
    items, updates = collect(cfg, store)
    added = []
    if items:
        api_key = keychain.get(keychain.ANTHROPIC_API_KEY)
        if not api_key:
            log.error("No Anthropic API key saved; run `assistant setup`.")
            return []
        calendar = backend.events_between(now, now + timedelta(days=30))
        pending = [s.title for s in store.suggestions("pending")]
        extractor = Extractor(api_key, cfg.ai.model, cfg.ai.min_confidence)
        proposals = extractor.extract(items, now, calendar, pending)
        added = inbox.publish(backend, store, cfg, proposals)
        log.info("Scan: %d suggestion(s), %d new", len(proposals), len(added))

    # Only move the cursors forward once everything above succeeded.
    for key, value in updates.items():
        store.set(key, value)
    store.set(LAST_SCAN, now.isoformat())
    store.commit()

    if added:
        notify.send(cfg.notify, notify.digest(added, cfg.reminders.inbox_list))
    return added


def run_once(backend: Backend, store: Store, cfg: Config, force_scan: bool = False) -> None:
    now = datetime.now().astimezone()
    decisions = inbox.process_decisions(backend, store, cfg, now)
    if any(decisions.values()):
        log.info("Inbox decisions: %s", decisions)

    if cfg.reminders.sync_to_calendar:
        reminders_sync.sync(backend, store, cfg, now)

    if store.get(FORCE_SCAN):  # set by `assistant setup` to test the background job
        force_scan = True
        store.set(FORCE_SCAN, "")
        store.commit()
    last = store.get(LAST_SCAN)
    if force_scan or scan_due(now, cfg.schedule.scan_times, datetime.fromisoformat(last) if last else None):
        scan(backend, store, cfg, now)
