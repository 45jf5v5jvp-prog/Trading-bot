"""Small SQLite database remembering what has already been synced and suggested."""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS reminder_events (
    reminder_id  TEXT PRIMARY KEY,
    event_id     TEXT,            -- NULL once you delete the event yourself
    reminder_sig TEXT NOT NULL,   -- what the reminder looked like at last sync
    event_start  TEXT             -- where the event was at last sync
);
CREATE TABLE IF NOT EXISTS suggestions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    fingerprint  TEXT UNIQUE NOT NULL,
    reminder_id  TEXT,
    kind         TEXT NOT NULL,
    title        TEXT NOT NULL,
    start        TEXT,
    all_day      INTEGER NOT NULL DEFAULT 0,
    duration_minutes INTEGER,
    location     TEXT NOT NULL DEFAULT '',
    source_ref   TEXT NOT NULL,
    source_label TEXT NOT NULL DEFAULT '',
    status       TEXT NOT NULL DEFAULT 'pending',  -- pending/approved/dismissed/expired
    created_at   TEXT NOT NULL,
    resolved_at  TEXT
);
CREATE TABLE IF NOT EXISTS kv (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


@dataclass
class Mapping:
    reminder_id: str
    event_id: str | None
    reminder_sig: str
    event_start: str | None


@dataclass
class Suggestion:
    id: int
    fingerprint: str
    reminder_id: str | None
    kind: str
    title: str
    start: datetime | None
    all_day: bool
    duration_minutes: int | None
    location: str
    source_ref: str
    source_label: str
    status: str
    created_at: datetime


class Store:
    def __init__(self, path: Path | str):
        if isinstance(path, Path):
            path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(path))
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)

    def commit(self) -> None:
        self.db.commit()

    # ---- key/value (cursors, last scan time) ----
    def get(self, key: str, default: str | None = None) -> str | None:
        row = self.db.execute("SELECT value FROM kv WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else default

    def set(self, key: str, value: str) -> None:
        self.db.execute(
            "INSERT INTO kv(key, value) VALUES(?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )

    # ---- reminder <-> calendar event mapping ----
    def mappings(self) -> dict[str, Mapping]:
        rows = self.db.execute("SELECT * FROM reminder_events").fetchall()
        return {r["reminder_id"]: Mapping(**dict(r)) for r in rows}

    def put_mapping(self, m: Mapping) -> None:
        self.db.execute(
            "INSERT INTO reminder_events(reminder_id, event_id, reminder_sig, event_start) "
            "VALUES(?, ?, ?, ?) ON CONFLICT(reminder_id) DO UPDATE SET "
            "event_id = excluded.event_id, reminder_sig = excluded.reminder_sig, "
            "event_start = excluded.event_start",
            (m.reminder_id, m.event_id, m.reminder_sig, m.event_start),
        )

    def delete_mapping(self, reminder_id: str) -> None:
        self.db.execute("DELETE FROM reminder_events WHERE reminder_id = ?", (reminder_id,))

    # ---- suggestions ----
    def has_fingerprint(self, fingerprint: str) -> bool:
        row = self.db.execute(
            "SELECT 1 FROM suggestions WHERE fingerprint = ?", (fingerprint,)
        ).fetchone()
        return row is not None

    def add_suggestion(self, **fields) -> int:
        fields.setdefault("created_at", datetime.now().astimezone().isoformat())
        if isinstance(fields.get("start"), datetime):
            fields["start"] = fields["start"].isoformat()
        cols = ", ".join(fields)
        marks = ", ".join("?" for _ in fields)
        cur = self.db.execute(
            f"INSERT INTO suggestions({cols}) VALUES({marks})", tuple(fields.values())
        )
        return int(cur.lastrowid)

    def suggestions(self, status: str | None = "pending") -> list[Suggestion]:
        if status:
            rows = self.db.execute(
                "SELECT * FROM suggestions WHERE status = ? ORDER BY id", (status,)
            ).fetchall()
        else:
            rows = self.db.execute("SELECT * FROM suggestions ORDER BY id").fetchall()
        out = []
        for r in rows:
            out.append(
                Suggestion(
                    id=r["id"],
                    fingerprint=r["fingerprint"],
                    reminder_id=r["reminder_id"],
                    kind=r["kind"],
                    title=r["title"],
                    start=datetime.fromisoformat(r["start"]) if r["start"] else None,
                    all_day=bool(r["all_day"]),
                    duration_minutes=r["duration_minutes"],
                    location=r["location"],
                    source_ref=r["source_ref"],
                    source_label=r["source_label"],
                    status=r["status"],
                    created_at=datetime.fromisoformat(r["created_at"]),
                )
            )
        return out

    def resolve_suggestion(self, suggestion_id: int, status: str) -> None:
        self.db.execute(
            "UPDATE suggestions SET status = ?, resolved_at = ? WHERE id = ?",
            (status, datetime.now().astimezone().isoformat(), suggestion_id),
        )
