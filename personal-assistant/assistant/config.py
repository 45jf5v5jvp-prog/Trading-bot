"""Loads ~/.personal-assistant/config.toml (created by `assistant setup`)."""

from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

DATA_DIR = Path(os.environ.get("ASSISTANT_HOME", Path.home() / ".personal-assistant"))
CONFIG_PATH = DATA_DIR / "config.toml"
DB_PATH = DATA_DIR / "state.sqlite3"
LOG_PATH = DATA_DIR / "assistant.log"


@dataclass
class CalendarConfig:
    # iCloud calendar that mirrors your to-do list (created if missing).
    todo_calendar: str = "To-Do"
    # Calendar that approved email/text events go to. "" = your default calendar.
    events_calendar: str = ""
    default_duration_minutes: int = 30


@dataclass
class RemindersConfig:
    sync_to_calendar: bool = True
    # Which Reminders lists to mirror. Empty = every list except the inbox list.
    lists: list[str] = field(default_factory=list)
    # What to do with reminders that have no date: "skip" or "today" (all-day event today).
    undated: str = "skip"
    # Where suggestions wait for your approval.
    inbox_list: str = "Assistant Inbox"
    # Where approved tasks go. "" = your default Reminders list.
    todo_list: str = ""


@dataclass
class EmailConfig:
    enabled: bool = True
    imap_host: str = "imap.mail.me.com"
    imap_port: int = 993
    username: str = ""
    folders: list[str] = field(default_factory=lambda: ["INBOX"])
    first_run_lookback_days: int = 3
    ignore_senders: list[str] = field(default_factory=list)


@dataclass
class MessagesConfig:
    enabled: bool = True
    chat_db: str = str(Path.home() / "Library" / "Messages" / "chat.db")
    first_run_lookback_days: int = 2
    # Skip automated texts from 5-6 digit short codes (bank alerts, 2FA codes, promos).
    skip_short_codes: bool = True
    ignore_senders: list[str] = field(default_factory=list)


@dataclass
class ScheduleConfig:
    # Local times at which email/texts are scanned and you get a "new suggestions" ping.
    scan_times: list[str] = field(
        default_factory=lambda: ["08:00", "11:00", "14:00", "17:00", "20:00"]
    )


@dataclass
class NotifyConfig:
    # Your own phone number or Apple ID email; the digest is iMessaged to you.
    # Leave empty to only show a Mac notification.
    imessage_to: str = ""
    mac_notification: bool = True


@dataclass
class AIConfig:
    model: str = "claude-opus-5-5"
    # Drop suggestions Claude rates "low" confidence.
    min_confidence: str = "medium"


@dataclass
class Config:
    calendar: CalendarConfig = field(default_factory=CalendarConfig)
    reminders: RemindersConfig = field(default_factory=RemindersConfig)
    email: EmailConfig = field(default_factory=EmailConfig)
    messages: MessagesConfig = field(default_factory=MessagesConfig)
    schedule: ScheduleConfig = field(default_factory=ScheduleConfig)
    notify: NotifyConfig = field(default_factory=NotifyConfig)
    ai: AIConfig = field(default_factory=AIConfig)


def _apply(section, values: dict, name: str) -> None:
    for key, value in values.items():
        if not hasattr(section, key):
            raise ValueError(f"Unknown setting [{name}] {key} in {CONFIG_PATH}")
        setattr(section, key, value)


def load(path: Path = CONFIG_PATH) -> Config:
    cfg = Config()
    if not path.exists():
        return cfg
    with open(path, "rb") as f:
        raw = tomllib.load(f)
    for name, values in raw.items():
        if not hasattr(cfg, name):
            raise ValueError(f"Unknown section [{name}] in {path}")
        _apply(getattr(cfg, name), values, name)
    return cfg


def _toml_value(v) -> str:
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, list):
        return "[" + ", ".join(_toml_value(x) for x in v) + "]"
    s = str(v).replace("\\", "\\\\").replace('"', '\\"')
    return f'"{s}"'


def save(cfg: Config, path: Path = CONFIG_PATH) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = ["# Personal Assistant settings. Edit freely; changes apply on the next run.", ""]
    for name in ("calendar", "reminders", "email", "messages", "schedule", "notify", "ai"):
        lines.append(f"[{name}]")
        for key, value in vars(getattr(cfg, name)).items():
            lines.append(f"{key} = {_toml_value(value)}")
        lines.append("")
    path.write_text("\n".join(lines))
