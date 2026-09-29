"""Reads new iCloud Mail over IMAP (read-only: messages are not marked as read)."""

from __future__ import annotations

import email
import email.policy
import html
import imaplib
import logging
import re
from datetime import datetime, timedelta
from email.utils import parseaddr, parsedate_to_datetime
from html.parser import HTMLParser

from ..config import EmailConfig
from ..models import SourceItem

log = logging.getLogger(__name__)

# Long newsletters don't hide appointments past this point; keeps API cost sane.
MAX_BODY_CHARS = 8000


class _TextExtractor(HTMLParser):
    SKIP = {"script", "style", "head"}

    def __init__(self):
        super().__init__()
        self.parts: list[str] = []
        self._skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self._skip += 1
        elif tag in {"br", "p", "div", "tr", "li", "h1", "h2", "h3"}:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in self.SKIP and self._skip:
            self._skip -= 1

    def handle_data(self, data):
        if not self._skip:
            self.parts.append(data)


def html_to_text(markup: str) -> str:
    p = _TextExtractor()
    p.feed(markup)
    text = html.unescape("".join(p.parts))
    text = re.sub(r"[ \t ]+", " ", text)
    return re.sub(r"\n\s*\n+", "\n\n", text).strip()


def message_text(msg: email.message.EmailMessage) -> str:
    part = msg.get_body(preferencelist=("plain", "html"))
    if part is None:
        return ""
    try:
        content = part.get_content()
    except (LookupError, UnicodeDecodeError):
        content = part.get_payload(decode=True).decode("utf-8", errors="replace")
    if part.get_content_type() == "text/html":
        content = html_to_text(content)
    return content.strip()


def parse_message(raw: bytes, ref: str) -> SourceItem:
    msg = email.message_from_bytes(raw, policy=email.policy.default)
    name, addr = parseaddr(str(msg.get("From", "")))
    try:
        received = parsedate_to_datetime(str(msg.get("Date"))).astimezone()
    except (TypeError, ValueError):
        received = datetime.now().astimezone()
    body = message_text(msg)
    if len(body) > MAX_BODY_CHARS:
        body = body[:MAX_BODY_CHARS] + "\n[...email continues...]"
    return SourceItem(
        source="email",
        ref=ref,
        sender=f"{name} <{addr}>" if name else addr,
        received=received,
        subject=str(msg.get("Subject", "")),
        body=body,
    )


def _ignored(item: SourceItem, cfg: EmailConfig) -> bool:
    sender = item.sender.lower()
    return any(s.lower() in sender for s in cfg.ignore_senders)


def fetch_new(cfg: EmailConfig, password: str, cursors: dict[str, str]) -> tuple[list[SourceItem], dict[str, str]]:
    """Return emails newer than the saved cursor, plus the cursor to save afterwards.

    Cursors are "<uidvalidity>:<last uid>" per folder.
    """
    items: list[SourceItem] = []
    new_cursors = dict(cursors)
    imap = imaplib.IMAP4_SSL(cfg.imap_host, cfg.imap_port)
    try:
        imap.login(cfg.username, password)
        for folder in cfg.folders:
            typ, _ = imap.select(f'"{folder}"', readonly=True)
            if typ != "OK":
                log.warning("Could not open mail folder %s", folder)
                continue
            validity = imap.response("UIDVALIDITY")[1]
            uidvalidity = validity[0].decode() if validity and validity[0] else "0"
            saved = cursors.get(folder, "")
            saved_validity, _, saved_uid = saved.partition(":")
            if saved and saved_validity == uidvalidity:
                last = int(saved_uid)
                typ, data = imap.uid("SEARCH", None, f"UID {last + 1}:*")
            else:
                last = 0
                since = (datetime.now() - timedelta(days=cfg.first_run_lookback_days)).strftime(
                    "%d-%b-%Y"
                )
                typ, data = imap.uid("SEARCH", None, f"SINCE {since}")
            uids = sorted(int(u) for u in (data[0] or b"").split() if int(u) > last)
            for uid in uids:
                typ, msg_data = imap.uid("FETCH", str(uid), "(BODY.PEEK[])")
                raw = next(
                    (part[1] for part in msg_data if isinstance(part, tuple)), None
                )
                if typ != "OK" or raw is None:
                    continue
                item = parse_message(raw, f"email:{folder}:{uid}")
                if not _ignored(item, cfg):
                    items.append(item)
            top = max(uids) if uids else last
            new_cursors[folder] = f"{uidvalidity}:{top}"
    finally:
        try:
            imap.logout()
        except Exception:  # connection may already be closed
            pass
    return items, new_cursors


def test_login(cfg: EmailConfig, password: str) -> None:
    imap = imaplib.IMAP4_SSL(cfg.imap_host, cfg.imap_port)
    try:
        imap.login(cfg.username, password)
    finally:
        imap.logout()
