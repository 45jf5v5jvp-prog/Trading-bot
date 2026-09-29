"""The approval step: suggestions wait in a Reminders list until you decide.

Each suggestion is a reminder in the "Assistant Inbox" list (on your iPhone and
Mac). Check it off to approve it, delete it to dismiss it. You can edit the
title or date first; the assistant uses whatever the reminder says when you
check it off.

Approved appointments go straight onto your calendar. Approved tasks go into
your normal to-do list (and from there onto the calendar if they have a date).
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timedelta

from .backend import Backend
from .config import Config
from .models import Proposal
from .store import Store

log = logging.getLogger(__name__)

EXPIRE_AFTER_DAYS = 1  # clear out suggestions whose date passed without a decision


def fingerprint(title: str, start: datetime | None) -> str:
    words = re.sub(r"[^a-z0-9]+", " ", title.lower()).strip()
    return f"{words}|{start.date().isoformat() if start else ''}"


def describe_when(start: datetime | None, all_day: bool, minutes: int | None) -> str:
    if start is None:
        return "No date"
    if all_day:
        return start.strftime("%a %b %-d")
    text = start.strftime("%a %b %-d, %-I:%M %p")
    return f"{text} ({minutes} min)" if minutes else text


def _notes(p: Proposal, default_minutes: int) -> str:
    kind = "Calendar event" if p.kind == "event" else "To-do"
    when = describe_when(p.start, p.all_day, (p.duration_minutes or default_minutes) if p.kind == "event" else None)
    first = f"{kind} · {when}" + (f" · {p.location}" if p.location else "")
    return (
        f"{first}\n"
        f"From: {p.source_label}\n"
        f"Why: {p.why}\n\n"
        "✔ Check off to approve · Delete to dismiss · Edit the title or date first if needed"
    )


def publish(backend: Backend, store: Store, cfg: Config, proposals: list[Proposal]) -> list[Proposal]:
    """Put new suggestions in the inbox list. Returns the ones actually added."""
    inbox = cfg.reminders.inbox_list
    backend.ensure_reminder_list(inbox)
    added = []
    for p in proposals:
        fp = fingerprint(p.title, p.start)
        if store.has_fingerprint(fp):
            continue
        reminder_id = backend.create_reminder(
            inbox, p.title, _notes(p, cfg.calendar.default_duration_minutes), p.start, p.all_day
        )
        store.add_suggestion(
            fingerprint=fp,
            reminder_id=reminder_id,
            kind=p.kind,
            title=p.title,
            start=p.start,
            all_day=int(p.all_day),
            duration_minutes=p.duration_minutes,
            location=p.location,
            source_ref=p.source_ref,
            source_label=p.source_label,
        )
        store.commit()  # commit per item so a crash can't create duplicates
        added.append(p)
    return added


def process_decisions(backend: Backend, store: Store, cfg: Config, now: datetime | None = None) -> dict:
    """Act on suggestions you've checked off or deleted since the last run."""
    now = now or datetime.now().astimezone()
    stats = {"approved": 0, "dismissed": 0, "expired": 0}
    for s in store.suggestions("pending"):
        r = backend.get_reminder(s.reminder_id) if s.reminder_id else None
        if r is None:
            store.resolve_suggestion(s.id, "dismissed")
            stats["dismissed"] += 1
            continue

        if r.completed:
            title = r.title.strip() or s.title
            note = f"Added by Personal Assistant — {s.source_label}"
            if s.kind == "event" and r.due is not None:
                if r.all_day:
                    start = r.due.replace(hour=0, minute=0, second=0, microsecond=0)
                    end = start + timedelta(days=1)
                else:
                    start = r.due
                    minutes = s.duration_minutes or cfg.calendar.default_duration_minutes
                    end = start + timedelta(minutes=minutes)
                backend.create_event(
                    cfg.calendar.events_calendar, title, start, end, r.all_day, note, s.location
                )
            else:
                backend.create_reminder(cfg.reminders.todo_list, title, note, r.due, r.all_day)
            backend.delete_reminder(r.id)
            store.resolve_suggestion(s.id, "approved")
            stats["approved"] += 1
            log.info("Approved: %s", title)
            continue

        if r.due is not None and r.due.date() < (now - timedelta(days=EXPIRE_AFTER_DAYS)).date():
            backend.delete_reminder(r.id)
            store.resolve_suggestion(s.id, "expired")
            stats["expired"] += 1

    store.commit()
    return stats
