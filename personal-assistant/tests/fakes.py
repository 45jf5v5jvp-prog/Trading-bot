from __future__ import annotations

import itertools
from datetime import datetime

from assistant.models import Event, Reminder


class FakeBackend:
    """In-memory stand-in for Apple Calendar + Reminders."""

    def __init__(self):
        self.reminders: dict[str, Reminder] = {}
        self.events: dict[str, Event] = {}
        self.calendars: set[str] = set()
        self.lists: set[str] = {"Reminders"}
        self._ids = itertools.count(1)

    def _id(self, prefix: str) -> str:
        return f"{prefix}{next(self._ids)}"

    # reminders
    def add(self, title, list_name="Reminders", due=None, all_day=False, notes="") -> Reminder:
        r = Reminder(self._id("r"), title, list_name, due, all_day, False, notes)
        self.reminders[r.id] = r
        return r

    def open_reminders(self, lists, exclude):
        return [
            r
            for r in self.reminders.values()
            if not r.completed and r.list_name not in exclude and (not lists or r.list_name in lists)
        ]

    def get_reminder(self, reminder_id):
        return self.reminders.get(reminder_id)

    def create_reminder(self, list_name, title, notes, due, all_day):
        return self.add(title, list_name or "Reminders", due, all_day, notes).id

    def set_reminder_due(self, reminder_id, due, all_day):
        r = self.reminders[reminder_id]
        r.due, r.all_day = due, all_day

    def delete_reminder(self, reminder_id):
        self.reminders.pop(reminder_id, None)

    def ensure_reminder_list(self, name):
        self.lists.add(name)

    # calendar
    def ensure_calendar(self, name):
        self.calendars.add(name)

    def get_event(self, event_id):
        return self.events.get(event_id)

    def events_between(self, start: datetime, end: datetime):
        return [e for e in self.events.values() if start <= e.start < end]

    def create_event(self, calendar, title, start, end, all_day, notes="", location=""):
        e = Event(self._id("e"), title, start, end, all_day, notes, location, calendar)
        self.events[e.id] = e
        return e.id

    def update_event(self, event_id, title, start, end, all_day, notes):
        e = self.events[event_id]
        e.title, e.start, e.end, e.all_day, e.notes = title, start, end, all_day, notes

    def delete_event(self, event_id):
        self.events.pop(event_id, None)
