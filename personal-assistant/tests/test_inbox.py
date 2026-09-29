from datetime import datetime, timedelta

import pytest

from assistant import inbox, reminders_sync
from assistant.config import Config
from assistant.models import Proposal
from assistant.store import Store
from tests.fakes import FakeBackend

NOW = datetime(2026, 9, 29, 9, 0).astimezone()


@pytest.fixture
def env():
    return FakeBackend(), Store(":memory:"), Config()


def dentist():
    return Proposal(
        source_ref="email:INBOX:1",
        title="Dentist - Dr. Patel",
        kind="event",
        start=datetime(2026, 10, 2, 15, 0).astimezone(),
        duration_minutes=60,
        location="12 Main St",
        why="Confirmed for Thursday at 3pm",
        source_label="Email from Dr. Patel",
    )


def call_mom():
    return Proposal(
        source_ref="text:+15551234567:9",
        title="Call Mom back",
        kind="task",
        why="Mom asked you to call",
        source_label="Text from Mom",
    )


def inbox_items(backend, cfg):
    return [r for r in backend.reminders.values() if r.list_name == cfg.reminders.inbox_list]


def test_publish_puts_suggestions_in_inbox_list(env):
    backend, store, cfg = env
    added = inbox.publish(backend, store, cfg, [dentist(), call_mom()])
    assert len(added) == 2
    items = inbox_items(backend, cfg)
    assert {r.title for r in items} == {"Dentist - Dr. Patel", "Call Mom back"}
    assert backend.events == {}  # nothing on the calendar until approved


def test_same_suggestion_is_not_repeated(env):
    backend, store, cfg = env
    inbox.publish(backend, store, cfg, [dentist()])
    again = inbox.publish(backend, store, cfg, [dentist()])
    assert again == []
    assert len(inbox_items(backend, cfg)) == 1


def test_checking_off_event_adds_it_to_calendar(env):
    backend, store, cfg = env
    inbox.publish(backend, store, cfg, [dentist()])
    r = inbox_items(backend, cfg)[0]
    r.completed = True
    stats = inbox.process_decisions(backend, store, cfg, NOW)
    assert stats["approved"] == 1
    ev = next(iter(backend.events.values()))
    assert ev.title == "Dentist - Dr. Patel"
    assert ev.end - ev.start == timedelta(minutes=60)
    assert ev.location == "12 Main St"
    assert inbox_items(backend, cfg) == []  # cleaned out of the inbox


def test_user_edits_before_approving_are_used(env):
    backend, store, cfg = env
    inbox.publish(backend, store, cfg, [dentist()])
    r = inbox_items(backend, cfg)[0]
    r.title = "Dentist (bring insurance card)"
    r.due = datetime(2026, 10, 2, 16, 30).astimezone()
    r.completed = True
    inbox.process_decisions(backend, store, cfg, NOW)
    ev = next(iter(backend.events.values()))
    assert ev.title == "Dentist (bring insurance card)"
    assert ev.start.hour == 16 and ev.start.minute == 30


def test_approved_task_goes_to_todo_list(env):
    backend, store, cfg = env
    inbox.publish(backend, store, cfg, [call_mom()])
    inbox_items(backend, cfg)[0].completed = True
    inbox.process_decisions(backend, store, cfg, NOW)
    todos = [r for r in backend.reminders.values() if r.list_name == "Reminders"]
    assert [r.title for r in todos] == ["Call Mom back"]
    assert backend.events == {}


def test_approved_dated_task_reaches_calendar_via_sync(env):
    backend, store, cfg = env
    task = call_mom()
    task.start = datetime(2026, 9, 30, 18, 0).astimezone()
    inbox.publish(backend, store, cfg, [task])
    inbox_items(backend, cfg)[0].completed = True
    inbox.process_decisions(backend, store, cfg, NOW)
    reminders_sync.sync(backend, store, cfg, NOW)
    ev = next(iter(backend.events.values()))
    assert ev.title == "Call Mom back" and ev.calendar == "To-Do"


def test_deleting_suggestion_dismisses_it(env):
    backend, store, cfg = env
    inbox.publish(backend, store, cfg, [dentist()])
    backend.delete_reminder(inbox_items(backend, cfg)[0].id)
    stats = inbox.process_decisions(backend, store, cfg, NOW)
    assert stats["dismissed"] == 1
    assert backend.events == {}
    assert store.suggestions("pending") == []


def test_old_undecided_suggestions_expire(env):
    backend, store, cfg = env
    inbox.publish(backend, store, cfg, [dentist()])
    later = datetime(2026, 10, 5, 9, 0).astimezone()
    stats = inbox.process_decisions(backend, store, cfg, later)
    assert stats["expired"] == 1
    assert inbox_items(backend, cfg) == []
