"""The calendar/reminders operations the assistant needs.

`apple.AppleBackend` implements this with EventKit on your Mac (which writes
to iCloud, so everything shows up on your iPhone too). Tests use a fake.
"""

from __future__ import annotations

from datetime import datetime
from typing import Protocol

from .models import Event, Reminder


class Backend(Protocol):
    # Reminders
    def open_reminders(self, lists: list[str] | None, exclude: list[str]) -> list[Reminder]: ...
    def get_reminder(self, reminder_id: str) -> Reminder | None: ...
    def create_reminder(
        self, list_name: str, title: str, notes: str, due: datetime | None, all_day: bool
    ) -> str: ...
    def set_reminder_due(self, reminder_id: str, due: datetime | None, all_day: bool) -> None: ...
    def delete_reminder(self, reminder_id: str) -> None: ...
    def ensure_reminder_list(self, name: str) -> None: ...

    # Calendar
    def ensure_calendar(self, name: str) -> None: ...
    def get_event(self, event_id: str) -> Event | None: ...
    def events_between(self, start: datetime, end: datetime) -> list[Event]: ...
    def create_event(
        self,
        calendar: str,
        title: str,
        start: datetime,
        end: datetime,
        all_day: bool,
        notes: str = "",
        location: str = "",
    ) -> str: ...
    def update_event(
        self, event_id: str, title: str, start: datetime, end: datetime, all_day: bool, notes: str
    ) -> None: ...
    def delete_event(self, event_id: str) -> None: ...
