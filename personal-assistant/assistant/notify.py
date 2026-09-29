"""Lets you know new suggestions are waiting: an iMessage to yourself and/or a Mac notification."""

from __future__ import annotations

import logging
import subprocess

from .config import NotifyConfig
from .inbox import describe_when
from .models import Proposal
from .sources.messages import DIGEST_MARKER

log = logging.getLogger(__name__)

SEND_IMESSAGE = """
on run argv
    set theText to item 1 of argv
    set theHandle to item 2 of argv
    tell application "Messages"
        set svc to 1st account whose service type = iMessage
        send theText to participant theHandle of svc
    end tell
end run
"""

MAC_NOTIFICATION = """
on run argv
    display notification (item 1 of argv) with title "Personal Assistant" sound name "Glass"
end run
"""


def digest(added: list[Proposal], inbox_list: str) -> str:
    n = len(added)
    lines = [f"{DIGEST_MARKER}: {n} new suggestion{'s' if n != 1 else ''}"]
    for p in added[:10]:
        lines.append(f"• {p.title} — {describe_when(p.start, p.all_day, None)}")
    if n > 10:
        lines.append(f"…and {n - 10} more")
    lines.append(f"Open Reminders › {inbox_list}. Check off to add, delete to dismiss.")
    return "\n".join(lines)


def _osascript(script: str, *args: str) -> None:
    subprocess.run(["osascript", "-e", script, *args], check=True, capture_output=True, timeout=30)


def send(cfg: NotifyConfig, text: str) -> None:
    if cfg.imessage_to:
        try:
            _osascript(SEND_IMESSAGE, text, cfg.imessage_to)
        except (subprocess.SubprocessError, OSError) as e:
            log.warning("Could not send iMessage digest: %s", e)
    if cfg.mac_notification:
        try:
            _osascript(MAC_NOTIFICATION, text.split("\n", 1)[0])
        except (subprocess.SubprocessError, OSError) as e:
            log.warning("Could not show Mac notification: %s", e)
