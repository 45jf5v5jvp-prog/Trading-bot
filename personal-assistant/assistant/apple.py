"""Apple Calendar + Reminders via EventKit (macOS only).

The Mac's Calendar and Reminders are synced with iCloud, so anything written
here appears on your iPhone within a few seconds.
"""

from __future__ import annotations

import threading
from datetime import datetime

import EventKit  # pyobjc-framework-EventKit
from Foundation import (
    NSCalendar,
    NSCalendarUnitDay,
    NSCalendarUnitHour,
    NSCalendarUnitMinute,
    NSCalendarUnitMonth,
    NSCalendarUnitYear,
    NSDate,
    NSDateComponentUndefined,
    NSRunLoop,
)

from .models import Event, Reminder

EVENT = EventKit.EKEntityTypeEvent
REMINDER = EventKit.EKEntityTypeReminder
FULL_ACCESS = 3  # EKAuthorizationStatusFullAccess / legacy EKAuthorizationStatusAuthorized
STATUS_NAMES = {0: "not asked yet", 1: "restricted", 2: "denied", 3: "allowed", 4: "write-only"}


class PermissionError_(RuntimeError):
    pass


def _wait_for_callback(start) -> tuple:
    """Run an async EventKit call and block until its completion handler fires."""
    done = threading.Event()
    box: dict = {}

    def handler(*args):
        box["args"] = args
        done.set()

    start(handler)
    while not done.wait(0.02):
        NSRunLoop.currentRunLoop().runUntilDate_(NSDate.dateWithTimeIntervalSinceNow_(0.05))
    return box["args"]


def _check(result, what: str) -> None:
    ok, err = result if isinstance(result, tuple) else (result, None)
    if not ok:
        raise RuntimeError(f"Could not {what}: {err}")


def _to_nsdate(dt: datetime) -> NSDate:
    return NSDate.dateWithTimeIntervalSince1970_(dt.timestamp())


def _from_nsdate(d) -> datetime:
    return datetime.fromtimestamp(d.timeIntervalSince1970()).astimezone()


def _components(dt: datetime, all_day: bool):
    units = NSCalendarUnitYear | NSCalendarUnitMonth | NSCalendarUnitDay
    if not all_day:
        units |= NSCalendarUnitHour | NSCalendarUnitMinute
    return NSCalendar.currentCalendar().components_fromDate_(units, _to_nsdate(dt))


def _from_components(comps) -> tuple[datetime | None, bool]:
    if comps is None:
        return None, False
    d = NSCalendar.currentCalendar().dateFromComponents_(comps)
    if d is None:
        return None, False
    all_day = comps.hour() == NSDateComponentUndefined
    return _from_nsdate(d), all_day


class AppleBackend:
    def __init__(self, request_access: bool = True):
        self.store = EventKit.EKEventStore.alloc().init()
        if request_access:
            self.request_access()

    # ---------------------------------------------------------------- access
    @staticmethod
    def access_status() -> dict[str, str]:
        cls = EventKit.EKEventStore
        return {
            "Calendars": STATUS_NAMES.get(cls.authorizationStatusForEntityType_(EVENT), "?"),
            "Reminders": STATUS_NAMES.get(cls.authorizationStatusForEntityType_(REMINDER), "?"),
        }

    def request_access(self) -> None:
        cls = EventKit.EKEventStore
        asked = False
        for entity, label in ((EVENT, "Calendars"), (REMINDER, "Reminders")):
            if cls.authorizationStatusForEntityType_(entity) == FULL_ACCESS:
                continue
            asked = True
            if hasattr(self.store, "requestFullAccessToEventsWithCompletion_"):  # macOS 14+
                fn = (
                    self.store.requestFullAccessToEventsWithCompletion_
                    if entity == EVENT
                    else self.store.requestFullAccessToRemindersWithCompletion_
                )
                granted, _err = _wait_for_callback(fn)
            else:
                granted, _err = _wait_for_callback(
                    lambda cb, e=entity: self.store.requestAccessToEntityType_completion_(e, cb)
                )
            if not granted:
                raise PermissionError_(
                    f"macOS denied access to {label}. Open System Settings > Privacy & "
                    f"Security > {label} and switch it on for Terminal / python."
                )
        if asked:
            # A store created before access was granted can't see any data.
            self.store = EventKit.EKEventStore.alloc().init()

    # ------------------------------------------------------------- reminders
    def _reminder_lists(self) -> list:
        return list(self.store.calendarsForEntityType_(REMINDER))

    def _reminder_list(self, name: str):
        if not name:
            return self.store.defaultCalendarForNewReminders()
        for cal in self._reminder_lists():
            if cal.title() == name:
                return cal
        return None

    def ensure_reminder_list(self, name: str) -> None:
        if not name or self._reminder_list(name) is not None:
            return
        cal = EventKit.EKCalendar.calendarForEntityType_eventStore_(REMINDER, self.store)
        cal.setTitle_(name)
        cal.setSource_(self.store.defaultCalendarForNewReminders().source())
        _check(self.store.saveCalendar_commit_error_(cal, True, None), f"create list {name}")

    def _to_reminder(self, r) -> Reminder:
        due, all_day = _from_components(r.dueDateComponents())
        return Reminder(
            id=str(r.calendarItemIdentifier()),
            title=str(r.title() or ""),
            list_name=str(r.calendar().title()),
            due=due,
            all_day=all_day,
            completed=bool(r.isCompleted()),
            notes=str(r.notes() or ""),
        )

    def open_reminders(self, lists: list[str] | None, exclude: list[str]) -> list[Reminder]:
        cals = [
            c
            for c in self._reminder_lists()
            if c.title() not in exclude and (not lists or c.title() in lists)
        ]
        if not cals:
            return []
        pred = self.store.predicateForIncompleteRemindersWithDueDateStarting_ending_calendars_(
            None, None, cals
        )
        (items,) = _wait_for_callback(
            lambda cb: self.store.fetchRemindersMatchingPredicate_completion_(pred, cb)
        )
        return [self._to_reminder(r) for r in (items or [])]

    def _raw_reminder(self, reminder_id: str):
        item = self.store.calendarItemWithIdentifier_(reminder_id)
        return item if isinstance(item, EventKit.EKReminder) else None

    def get_reminder(self, reminder_id: str) -> Reminder | None:
        r = self._raw_reminder(reminder_id)
        return self._to_reminder(r) if r is not None else None

    def create_reminder(
        self, list_name: str, title: str, notes: str, due: datetime | None, all_day: bool
    ) -> str:
        cal = self._reminder_list(list_name)
        if cal is None:
            self.ensure_reminder_list(list_name)
            cal = self._reminder_list(list_name)
        r = EventKit.EKReminder.reminderWithEventStore_(self.store)
        r.setTitle_(title)
        r.setNotes_(notes)
        r.setCalendar_(cal)
        if due is not None:
            r.setDueDateComponents_(_components(due, all_day))
        _check(self.store.saveReminder_commit_error_(r, True, None), f"save reminder {title!r}")
        return str(r.calendarItemIdentifier())

    def set_reminder_due(self, reminder_id: str, due: datetime | None, all_day: bool) -> None:
        r = self._raw_reminder(reminder_id)
        if r is None:
            return
        r.setDueDateComponents_(_components(due, all_day) if due else None)
        _check(self.store.saveReminder_commit_error_(r, True, None), "update reminder date")

    def delete_reminder(self, reminder_id: str) -> None:
        r = self._raw_reminder(reminder_id)
        if r is not None:
            _check(self.store.removeReminder_commit_error_(r, True, None), "delete reminder")

    # -------------------------------------------------------------- calendar
    def _calendar(self, name: str):
        if not name:
            return self.store.defaultCalendarForNewEvents()
        for cal in self.store.calendarsForEntityType_(EVENT):
            if cal.title() == name and cal.allowsContentModifications():
                return cal
        return None

    def _icloud_source(self):
        for src in self.store.sources():
            if src.sourceType() == EventKit.EKSourceTypeCalDAV and src.title() == "iCloud":
                return src
        return self.store.defaultCalendarForNewEvents().source()

    def ensure_calendar(self, name: str) -> None:
        if not name or self._calendar(name) is not None:
            return
        cal = EventKit.EKCalendar.calendarForEntityType_eventStore_(EVENT, self.store)
        cal.setTitle_(name)
        cal.setSource_(self._icloud_source())
        _check(self.store.saveCalendar_commit_error_(cal, True, None), f"create calendar {name}")

    def _to_event(self, e) -> Event:
        return Event(
            id=str(e.eventIdentifier()),
            title=str(e.title() or ""),
            start=_from_nsdate(e.startDate()),
            end=_from_nsdate(e.endDate()),
            all_day=bool(e.isAllDay()),
            notes=str(e.notes() or ""),
            location=str(e.location() or ""),
            calendar=str(e.calendar().title()),
        )

    def get_event(self, event_id: str) -> Event | None:
        e = self.store.eventWithIdentifier_(event_id)
        return self._to_event(e) if e is not None else None

    def events_between(self, start: datetime, end: datetime) -> list[Event]:
        pred = self.store.predicateForEventsWithStartDate_endDate_calendars_(
            _to_nsdate(start), _to_nsdate(end), None
        )
        return [self._to_event(e) for e in (self.store.eventsMatchingPredicate_(pred) or [])]

    def _save_event(self, e, what: str) -> None:
        _check(
            self.store.saveEvent_span_commit_error_(e, EventKit.EKSpanThisEvent, True, None), what
        )

    def create_event(
        self,
        calendar: str,
        title: str,
        start: datetime,
        end: datetime,
        all_day: bool,
        notes: str = "",
        location: str = "",
    ) -> str:
        cal = self._calendar(calendar)
        if cal is None:
            self.ensure_calendar(calendar)
            cal = self._calendar(calendar)
        e = EventKit.EKEvent.eventWithEventStore_(self.store)
        e.setCalendar_(cal)
        e.setTitle_(title)
        e.setStartDate_(_to_nsdate(start))
        e.setEndDate_(_to_nsdate(end))
        e.setAllDay_(all_day)
        e.setNotes_(notes)
        if location:
            e.setLocation_(location)
        self._save_event(e, f"create event {title!r}")
        return str(e.eventIdentifier())

    def update_event(
        self, event_id: str, title: str, start: datetime, end: datetime, all_day: bool, notes: str
    ) -> None:
        e = self.store.eventWithIdentifier_(event_id)
        if e is None:
            return
        e.setTitle_(title)
        e.setStartDate_(_to_nsdate(start))
        e.setEndDate_(_to_nsdate(end))
        e.setAllDay_(all_day)
        e.setNotes_(notes)
        self._save_event(e, f"update event {title!r}")

    def delete_event(self, event_id: str) -> None:
        e = self.store.eventWithIdentifier_(event_id)
        if e is not None:
            _check(
                self.store.removeEvent_span_commit_error_(e, EventKit.EKSpanThisEvent, True, None),
                "delete event",
            )
