from datetime import datetime, timedelta

import pytest

from assistant.config import Config
from assistant.reminders_sync import sync
from assistant.store import Store
from tests.fakes import FakeBackend

NOW = datetime(2026, 9, 29, 9, 0).astimezone()


@pytest.fixture
def env():
    return FakeBackend(), Store(":memory:"), Config()


def only_event(backend):
    assert len(backend.events) == 1
    return next(iter(backend.events.values()))


def test_timed_reminder_becomes_event(env):
    backend, store, cfg = env
    backend.add("Call plumber", due=NOW + timedelta(hours=3))
    stats = sync(backend, store, cfg, NOW)
    ev = only_event(backend)
    assert stats["created"] == 1
    assert ev.title == "Call plumber"
    assert ev.calendar == "To-Do"
    assert ev.end - ev.start == timedelta(minutes=30)
    assert not ev.all_day


def test_date_only_reminder_is_all_day(env):
    backend, store, cfg = env
    backend.add("Renew registration", due=datetime(2026, 10, 3, 0, 0).astimezone(), all_day=True)
    sync(backend, store, cfg, NOW)
    ev = only_event(backend)
    assert ev.all_day
    assert ev.end - ev.start == timedelta(days=1)


def test_undated_skipped_by_default_and_optional_today(env):
    backend, store, cfg = env
    backend.add("Someday: clean garage")
    sync(backend, store, cfg, NOW)
    assert backend.events == {}
    cfg.reminders.undated = "today"
    sync(backend, store, cfg, NOW)
    assert only_event(backend).all_day


def test_second_sync_is_a_no_op(env):
    backend, store, cfg = env
    backend.add("Call plumber", due=NOW + timedelta(hours=3))
    sync(backend, store, cfg, NOW)
    stats = sync(backend, store, cfg, NOW)
    assert not any(stats.values())
    assert len(backend.events) == 1


def test_editing_reminder_updates_event(env):
    backend, store, cfg = env
    r = backend.add("Call plumber", due=NOW + timedelta(hours=3))
    sync(backend, store, cfg, NOW)
    r.title = "Call plumber about leak"
    r.due = NOW + timedelta(days=1)
    stats = sync(backend, store, cfg, NOW)
    ev = only_event(backend)
    assert stats["updated"] == 1
    assert ev.title == "Call plumber about leak"
    assert ev.start == r.due


def test_completing_reminder_removes_event(env):
    backend, store, cfg = env
    r = backend.add("Call plumber", due=NOW + timedelta(hours=3))
    sync(backend, store, cfg, NOW)
    r.completed = True
    stats = sync(backend, store, cfg, NOW)
    assert stats["removed"] == 1
    assert backend.events == {}


def test_deleting_reminder_removes_event(env):
    backend, store, cfg = env
    r = backend.add("Call plumber", due=NOW + timedelta(hours=3))
    sync(backend, store, cfg, NOW)
    backend.delete_reminder(r.id)
    sync(backend, store, cfg, NOW)
    assert backend.events == {}


def test_moving_event_moves_reminder(env):
    backend, store, cfg = env
    r = backend.add("Call plumber", due=NOW + timedelta(hours=3))
    sync(backend, store, cfg, NOW)
    ev = only_event(backend)
    new_start = NOW + timedelta(days=2, hours=1)
    ev.start, ev.end = new_start, new_start + timedelta(minutes=30)
    stats = sync(backend, store, cfg, NOW)
    assert stats["moved_reminder"] == 1
    assert r.due == new_start
    # and it settles
    assert not any(sync(backend, store, cfg, NOW).values())


def test_deleted_event_stays_deleted_until_reminder_changes(env):
    backend, store, cfg = env
    r = backend.add("Call plumber", due=NOW + timedelta(hours=3))
    sync(backend, store, cfg, NOW)
    backend.events.clear()
    sync(backend, store, cfg, NOW)
    assert backend.events == {}
    r.due = NOW + timedelta(days=1)
    sync(backend, store, cfg, NOW)
    assert len(backend.events) == 1


def test_inbox_list_is_never_mirrored(env):
    backend, store, cfg = env
    backend.add("Suggested thing", list_name="Assistant Inbox", due=NOW + timedelta(hours=1))
    sync(backend, store, cfg, NOW)
    assert backend.events == {}


def test_fetch_hiccup_does_not_wipe_events(env):
    backend, store, cfg = env
    backend.add("Call plumber", due=NOW + timedelta(hours=3))
    sync(backend, store, cfg, NOW)
    backend.open_reminders = lambda lists, exclude: []  # simulate a failed fetch
    sync(backend, store, cfg, NOW)
    assert len(backend.events) == 1
