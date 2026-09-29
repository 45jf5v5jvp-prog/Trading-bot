"""Passwords and API keys live in the macOS Keychain, never in the config file."""

from __future__ import annotations

import os
import subprocess

SERVICE = "personal-assistant"

ANTHROPIC_API_KEY = "anthropic_api_key"
ICLOUD_APP_PASSWORD = "icloud_app_password"


def get(name: str) -> str | None:
    env = os.environ.get(name.upper())
    if env:
        return env
    try:
        out = subprocess.run(
            ["security", "find-generic-password", "-s", SERVICE, "-a", name, "-w"],
            capture_output=True,
            text=True,
            check=True,
        )
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None
    return out.stdout.strip() or None


def put(name: str, value: str) -> None:
    # -U updates the item if it already exists.
    subprocess.run(
        ["security", "add-generic-password", "-U", "-s", SERVICE, "-a", name, "-w", value],
        check=True,
        capture_output=True,
    )
