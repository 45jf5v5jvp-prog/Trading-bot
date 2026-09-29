"""Reads new iMessages/SMS from the Mac's Messages database (read-only).

Requires Full Disk Access for the program running the assistant, because
macOS protects ~/Library/Messages. Texts synced from your iPhone via
"Messages in iCloud" / Text Message Forwarding all land in this database.
"""

from __future__ import annotations

import glob
import logging
import re
import sqlite3
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

from ..config import MessagesConfig
from ..models import SourceItem

log = logging.getLogger(__name__)

APPLE_EPOCH = datetime(2001, 1, 1, tzinfo=timezone.utc)
# Digests the assistant texts to you start with this, so it never reads its own messages.
DIGEST_MARKER = "\U0001F4E5 Assistant"
CONTEXT_MESSAGES = 6  # earlier messages shown per conversation so replies make sense


def apple_time(value: int | None) -> datetime:
    if not value:
        return APPLE_EPOCH.astimezone()
    seconds = value / 1e9 if value > 1e11 else value  # newer macOS stores nanoseconds
    return (APPLE_EPOCH + timedelta(seconds=seconds)).astimezone()


def to_apple_time(dt: datetime) -> int:
    return int((dt - APPLE_EPOCH).total_seconds() * 1e9)


def decode_attributed_body(blob: bytes | None) -> str | None:
    """Pull the plain text out of the `attributedBody` typedstream blob.

    Recent macOS versions often leave `message.text` empty and only store the
    text inside this serialized NSAttributedString.
    """
    if not blob:
        return None
    start = blob.find(b"NSString")
    if start < 0:
        return None
    plus = blob.find(b"+", start + len(b"NSString"))
    if plus < 0:
        return None
    i = plus + 1
    length = blob[i]
    i += 1
    if length == 0x81:
        length = int.from_bytes(blob[i : i + 2], "little")
        i += 2
    elif length == 0x82:
        length = int.from_bytes(blob[i : i + 4], "little")
        i += 4
    return blob[i : i + length].decode("utf-8", errors="replace")


def _digits(s: str) -> str:
    return re.sub(r"\D", "", s or "")


def is_short_code(handle: str) -> bool:
    d = _digits(handle)
    return "@" not in (handle or "") and 0 < len(d) <= 6


def load_contact_names() -> dict[str, str]:
    """Best-effort phone/email -> name map from the Contacts database."""
    names: dict[str, str] = {}
    pattern = str(Path.home() / "Library/Application Support/AddressBook/Sources/*/AddressBook-v22.abcddb")
    for path in glob.glob(pattern):
        try:
            db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
            people = {
                pk: " ".join(p for p in (first, last) if p) or (org or "")
                for pk, first, last, org in db.execute(
                    "SELECT Z_PK, ZFIRSTNAME, ZLASTNAME, ZORGANIZATION FROM ZABCDRECORD"
                )
            }
            for owner, number in db.execute("SELECT ZOWNER, ZFULLNUMBER FROM ZABCDPHONENUMBER"):
                if people.get(owner) and number:
                    names[_digits(number)[-10:]] = people[owner]
            for owner, address in db.execute("SELECT ZOWNER, ZADDRESS FROM ZABCDEMAILADDRESS"):
                if people.get(owner) and address:
                    names[address.lower()] = people[owner]
            db.close()
        except sqlite3.Error as e:
            log.debug("Contacts lookup skipped for %s: %s", path, e)
    return names


def contact_name(handle: str, names: dict[str, str]) -> str:
    if not handle:
        return "Unknown"
    key = handle.lower() if "@" in handle else _digits(handle)[-10:]
    name = names.get(key)
    return f"{name} ({handle})" if name else handle


QUERY = """
SELECT m.ROWID AS rowid, m.text, m.attributedBody, m.date, m.is_from_me,
       h.id AS handle, c.ROWID AS chat_id, c.display_name, c.chat_identifier
FROM message m
LEFT JOIN handle h ON m.handle_id = h.ROWID
LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
LEFT JOIN chat c ON c.ROWID = cmj.chat_id
WHERE m.associated_message_type = 0   -- skip tapbacks/reactions
  AND {where}
ORDER BY m.ROWID
"""


def _text_of(row) -> str | None:
    text = row["text"] or decode_attributed_body(row["attributedBody"])
    if text:
        text = text.replace("￼", "").strip()  # attachment placeholder
    return text or None


def open_db(path: str) -> sqlite3.Connection:
    db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    return db


def fetch_new(cfg: MessagesConfig, cursor: int | None) -> tuple[list[SourceItem], int]:
    """Return one SourceItem per conversation with new texts, plus the new cursor (max ROWID)."""
    db = open_db(cfg.chat_db)
    try:
        if cursor is None:
            since = to_apple_time(datetime.now().astimezone() - timedelta(days=cfg.first_run_lookback_days))
            rows = db.execute(QUERY.format(where="m.date > ?"), (since,)).fetchall()
            cursor = 0
        else:
            rows = db.execute(QUERY.format(where="m.ROWID > ?"), (cursor,)).fetchall()

        new_cursor = max([cursor] + [r["rowid"] for r in rows])
        ignore = [s.lower() for s in cfg.ignore_senders]
        by_chat: dict[int, list] = defaultdict(list)
        for r in rows:
            handle = r["handle"] or ""
            if cfg.skip_short_codes and is_short_code(handle):
                continue
            if any(s in handle.lower() for s in ignore):
                continue
            text = _text_of(r)
            if not text or text.startswith(DIGEST_MARKER):
                continue
            by_chat[r["chat_id"] or -r["rowid"]].append((r, text))
        if not by_chat:
            return [], new_cursor

        names = load_contact_names()
        items = []
        for chat_id, msgs in by_chat.items():
            first_row = msgs[0][0]
            earlier = []
            if chat_id > 0:
                earlier = db.execute(
                    QUERY.format(where="c.ROWID = ? AND m.ROWID < ?").replace(
                        "ORDER BY m.ROWID", "ORDER BY m.ROWID DESC LIMIT ?"
                    ),
                    (chat_id, first_row["rowid"], CONTEXT_MESSAGES),
                ).fetchall()[::-1]

            def line(r, text):
                who = "Me" if r["is_from_me"] else contact_name(r["handle"] or "", names)
                return f"[{apple_time(r['date']).strftime('%a %b %d %I:%M %p')}] {who}: {text}"

            lines = []
            context = [(r, _text_of(r)) for r in earlier]
            context = [(r, t) for r, t in context if t and not t.startswith(DIGEST_MARKER)]
            if context:
                lines.append("(earlier in this conversation, already seen)")
                lines += [line(r, t) for r, t in context]
                lines.append("(new messages)")
            lines += [line(r, t) for r, t in msgs]

            other = next((r["handle"] for r, _ in msgs if r["handle"]), "")
            title = first_row["display_name"] or contact_name(other, names)
            last_row = msgs[-1][0]
            items.append(
                SourceItem(
                    source="text",
                    ref=f"text:{first_row['chat_identifier'] or other}:{last_row['rowid']}",
                    sender=title,
                    received=apple_time(last_row["date"]),
                    subject=f"Text conversation with {title}",
                    body="\n".join(lines),
                )
            )
        return items, new_cursor
    finally:
        db.close()
