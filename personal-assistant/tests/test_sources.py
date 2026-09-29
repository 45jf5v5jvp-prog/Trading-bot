import sqlite3
from datetime import datetime, timedelta
from email.message import EmailMessage

from assistant.config import MessagesConfig
from assistant.sources import email_imap, messages


def test_plain_email_parsed():
    msg = EmailMessage()
    msg["From"] = "Dr. Patel Office <frontdesk@patel.example>"
    msg["Subject"] = "Appointment confirmed"
    msg["Date"] = "Tue, 29 Sep 2026 08:15:00 -0700"
    msg.set_content("See you Thursday at 3pm.")
    item = email_imap.parse_message(msg.as_bytes(), "email:INBOX:7")
    assert item.sender == "Dr. Patel Office <frontdesk@patel.example>"
    assert item.subject == "Appointment confirmed"
    assert "Thursday at 3pm" in item.body
    assert item.ref == "email:INBOX:7"


def test_html_only_email_is_converted_to_text():
    msg = EmailMessage()
    msg["From"] = "school@example.org"
    msg["Subject"] = "Picture day"
    msg.set_content(
        "<html><style>p{}</style><body><p>Picture day is</p><p>Oct 8</p></body></html>",
        subtype="html",
    )
    item = email_imap.parse_message(msg.as_bytes(), "email:INBOX:8")
    assert "Picture day is" in item.body and "Oct 8" in item.body
    assert "<p>" not in item.body and "p{}" not in item.body


def _typedstream(text: str) -> bytes:
    data = text.encode()
    if len(data) < 0x80:
        length = bytes([len(data)])
    else:
        length = b"\x81" + len(data).to_bytes(2, "little")
    return b"\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x12NSAttributedString\x00\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84\x08NSString\x01\x94\x84\x01+" + length + data + b"\x86\x84\x02iI"


def test_attributed_body_decoding_short_and_long():
    assert messages.decode_attributed_body(_typedstream("Dinner at 7?")) == "Dinner at 7?"
    long_text = "x" * 300
    assert messages.decode_attributed_body(_typedstream(long_text)) == long_text
    assert messages.decode_attributed_body(None) is None


def test_short_codes():
    assert messages.is_short_code("72975")
    assert not messages.is_short_code("+15551234567")
    assert not messages.is_short_code("someone@icloud.com")


def _chat_db(path):
    db = sqlite3.connect(path)
    db.executescript(
        """
        CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
        CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, display_name TEXT, chat_identifier TEXT);
        CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
        CREATE TABLE message (ROWID INTEGER PRIMARY KEY, text TEXT, attributedBody BLOB,
            date INTEGER, is_from_me INTEGER, handle_id INTEGER, associated_message_type INTEGER);
        INSERT INTO handle VALUES (1, '+15551234567'), (2, '72975');
        INSERT INTO chat VALUES (1, NULL, '+15551234567'), (2, NULL, '72975');
        """
    )
    now = datetime.now().astimezone()

    def add(rowid, text, handle, chat, minutes_ago, from_me=0, assoc=0, blob=None):
        db.execute(
            "INSERT INTO message VALUES (?,?,?,?,?,?,?)",
            (rowid, text, blob, messages.to_apple_time(now - timedelta(minutes=minutes_ago)),
             from_me, handle, assoc),
        )
        db.execute("INSERT INTO chat_message_join VALUES (?,?)", (chat, rowid))

    add(1, "Can you grab Emma from practice Thursday at 5?", 1, 1, 30)
    add(2, None, 1, 1, 29, from_me=1, blob=_typedstream("Yes I'll get her"))
    add(3, "Loved “Yes I'll get her”", 1, 1, 28, assoc=2000)  # tapback
    add(4, "Your code is 998877", 2, 2, 20)  # short code
    add(5, "\U0001F4E5 Assistant: 1 new suggestion", 1, 1, 10, from_me=1)  # our own digest
    db.commit()
    db.close()


def test_messages_first_run_and_cursor(tmp_path):
    path = str(tmp_path / "chat.db")
    _chat_db(path)
    cfg = MessagesConfig(chat_db=path)
    items, cursor = messages.fetch_new(cfg, None)
    assert cursor == 5
    assert len(items) == 1
    body = items[0].body
    assert "grab Emma" in body
    assert "Me: Yes I'll get her" in body
    assert "Loved" not in body and "998877" not in body and "Assistant" not in body

    again, cursor2 = messages.fetch_new(cfg, cursor)
    assert again == [] and cursor2 == 5
