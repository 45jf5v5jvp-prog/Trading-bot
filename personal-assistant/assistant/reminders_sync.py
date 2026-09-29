"""Keeps a calendar mirror of your Apple Reminders to-do list.

* A reminder with a date and time becomes a calendar event at that time.
* A reminder with just a date becomes an all-day event.
* Completing or deleting the reminder removes the event.
* Editing the reminder updates the event.
* Dragging the event to a new time on your calendar moves the reminder's due date.
* Deleting the event yourself is respected: it won't come back unless you
  change the reminder.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta

from .backend import Backend
from .config import Config
from .models import Event, Reminder
from .store import Mapping, Store

log = logging.getLogger(__name__)


def _minute(dt: datetime) -> str:
    return dt.astimezone().strftime("%Y-%m-%dT%H:%M")


def _midnight(dt: datetime) -> datetime:
    return dt.astimezone().replace(hour=0, minute=0, second=0, microsecond=0)


def schedule_for(r: Reminder, cfg: Config, now: datetime) -> tuple[datetime, datetime, bool] | None:
    """Where on the calendar a reminder belongs, or None to leave it off."""
    if r.due is not None and not r.all_day:
        start = r.due
        return start, start + timedelta(minutes=cfg.calendar.default_duration_minutes), False
    if r.due is not None:
        day = _midnight(r.due)
        return day, day + timedelta(days=1), True
    if cfg.reminders.undated == "today":
        day = _midnight(now)
        return day, day + timedelta(days=1), True
    return None


def _signature(r: Reminder, start: datetime, all_day: bool) -> str:
    return "\x1f".join([r.title, r.list_name, _minute(start), str(all_day), r.notes])


def _notes(r: Reminder) -> str:
    text = f"From your “{r.list_name}” to-do list (synced by Personal Assistant)."
    return f"{text}\n\n{r.notes}" if r.notes else text


def _event_key(ev: Event) -> str:
    return f"{_minute(ev.start)}|{ev.all_day}"


def sync(backend: Backend, store: Store, cfg: Config, now: datetime | None = None) -> dict:
    now = now or datetime.now().astimezone()
    stats = {"created": 0, "updated": 0, "removed": 0, "moved_reminder": 0}
    calendar = cfg.calendar.todo_calendar
    backend.ensure_calendar(calendar)

    reminders = backend.open_reminders(
        cfg.reminders.lists or None, exclude=[cfg.reminders.inbox_list]
    )
    mappings = store.mappings()
    on_calendar: set[str] = set()

    for r in reminders:
        slot = schedule_for(r, cfg, now)
        if slot is None:
            continue
        start, end, all_day = slot
        on_calendar.add(r.id)
        sig = _signature(r, start, all_day)
        m = mappings.get(r.id)

        if m is None:
            event_id = backend.create_event(calendar, r.title, start, end, all_day, _notes(r))
            ev_key = f"{_minute(start)}|{all_day}"
            store.put_mapping(Mapping(r.id, event_id, sig, ev_key))
            stats["created"] += 1
            continue

        ev = backend.get_event(m.event_id) if m.event_id else None
        if ev is None:
            if sig != m.reminder_sig:
                # You changed the reminder after deleting its event: put it back.
                event_id = backend.create_event(calendar, r.title, start, end, all_day, _notes(r))
                store.put_mapping(Mapping(r.id, event_id, sig, f"{_minute(start)}|{all_day}"))
                stats["created"] += 1
            elif m.event_id:
                # You deleted the event on purpose; remember that.
                store.put_mapping(Mapping(r.id, None, sig, None))
            continue

        if sig != m.reminder_sig:
            backend.update_event(ev.id, r.title, start, end, all_day, _notes(r))
            store.put_mapping(Mapping(r.id, ev.id, sig, f"{_minute(start)}|{all_day}"))
            stats["updated"] += 1
        elif _event_key(ev) != m.event_start:
            # The event was moved on the calendar: carry the new time to the reminder.
            backend.set_reminder_due(r.id, ev.start, ev.all_day)
            moved = Reminder(**{**vars(r), "due": ev.start, "all_day": ev.all_day})
            store.put_mapping(
                Mapping(r.id, ev.id, _signature(moved, ev.start, ev.all_day), _event_key(ev))
            )
            stats["moved_reminder"] += 1

    # Anything we mirrored earlier that is no longer an open, dated reminder.
    for reminder_id, m in mappings.items():
        if reminder_id in on_calendar:
            continue
        # Double-check before deleting, so a hiccup fetching the list can't wipe events.
        r = backend.get_reminder(reminder_id)
        if (
            r is not None
            and not r.completed
            and r.list_name != cfg.reminders.inbox_list
            and (not cfg.reminders.lists or r.list_name in cfg.reminders.lists)
            and schedule_for(r, cfg, now) is not None
        ):
            continue
        if m.event_id:
            backend.delete_event(m.event_id)
            stats["removed"] += 1
        store.delete_mapping(reminder_id)

    store.commit()
    if any(stats.values()):
        log.info("Reminders -> calendar: %s", stats)
    return stats
