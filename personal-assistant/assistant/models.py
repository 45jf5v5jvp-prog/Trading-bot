"""Plain data types shared by every part of the assistant.

The Apple-specific code converts EventKit objects into these, so the sync and
inbox logic never touches macOS APIs directly (and can be tested anywhere).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime


@dataclass
class Reminder:
    id: str
    title: str
    list_name: str
    due: datetime | None = None  # timezone-aware, local time
    all_day: bool = False  # due has a date but no time
    completed: bool = False
    notes: str = ""


@dataclass
class Event:
    id: str
    title: str
    start: datetime
    end: datetime
    all_day: bool = False
    notes: str = ""
    location: str = ""
    calendar: str = ""


@dataclass
class SourceItem:
    """One email or one text-message conversation chunk to be read by Claude."""

    source: str  # "email" or "text"
    ref: str  # stable id, e.g. "email:INBOX:1234" or "text:chat42:9876"
    sender: str
    received: datetime
    subject: str = ""
    body: str = ""


@dataclass
class Proposal:
    """Something Claude thinks belongs on the calendar or to-do list."""

    source_ref: str
    title: str
    kind: str  # "event" (appointment/meeting) or "task" (something to do)
    start: datetime | None = None
    all_day: bool = False
    duration_minutes: int | None = None
    location: str = ""
    why: str = ""
    confidence: str = "medium"
    source_label: str = ""  # human-readable "Email from Dr. Smith: Appointment reminder"
    extra: dict = field(default_factory=dict)
