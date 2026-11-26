"""Configuration models, safe account namespace helpers, and date chunking utilities."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import List, Optional, Tuple


DEFAULT_LOOKBACK_DAYS = 3
DEFAULT_FULL_HISTORY_START_YEAR = 2015
DEFAULT_CHUNK_DAYS = 90


def sanitise_path_segment(value: str, fallback: str = "unknown") -> str:
    """Return a filesystem-safe, deterministic path token (alphanumeric, hyphen, underscore)."""
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", (value or "").strip())
    cleaned = cleaned.strip("._-")
    if not cleaned or cleaned in {".", ".."}:
        return fallback
    return cleaned[:80]


@dataclass(frozen=True)
class AccountNamespace:
    """Separates exported files and checkpoints strictly by (broker_server, account_login)."""

    broker_server: str
    account_login: str

    @property
    def server_slug(self) -> str:
        return sanitise_path_segment(self.broker_server, "unknown-server")

    @property
    def login_slug(self) -> str:
        return sanitise_path_segment(str(self.account_login), "unknown-login")

    @property
    def folder_name(self) -> str:
        return f"{self.server_slug}__{self.login_slug}"

    @property
    def file_prefix(self) -> str:
        return f"{self.server_slug}_{self.login_slug}"


@dataclass(frozen=True)
class CollectorConfig:
    """Runtime options for a single local read-only MT5 collection run."""

    mode: str = "incremental"  # "incremental" or "full"
    output_dir: Path = field(default_factory=lambda: Path("exports"))
    state_dir: Path = field(default_factory=lambda: Path("state"))
    terminal_path: Optional[str] = None
    from_date: Optional[datetime] = None
    to_date: Optional[datetime] = None
    lookback_days: int = DEFAULT_LOOKBACK_DAYS
    chunk_days: int = DEFAULT_CHUNK_DAYS
    confirm_investor_session: bool = False
    # Optional push to the user's own LedgerFX server (see collector/pusher.py).
    push_url: Optional[str] = None
    token_env: str = "LEDGERFX_INGEST_TOKEN"
    token_file: Optional[Path] = None
    no_csv: bool = False

    def validate(self) -> None:
        if self.mode not in {"incremental", "full"}:
            raise ValueError(f"Unsupported collection mode '{self.mode}'. Use 'incremental' or 'full'.")
        if self.lookback_days < 0 or self.lookback_days > 365:
            raise ValueError("lookback_days must be between 0 and 365.")
        if self.chunk_days < 1 or self.chunk_days > 366:
            raise ValueError("chunk_days must be between 1 and 366.")
        if self.from_date and self.to_date and self.from_date > self.to_date:
            raise ValueError("from_date must not be later than to_date.")


def build_date_chunks(
    date_from: datetime,
    date_to: datetime,
    chunk_days: int = DEFAULT_CHUNK_DAYS,
) -> List[Tuple[datetime, datetime]]:
    """Split a historical date range into safe chunks to avoid MT5 terminal IPC timeouts."""
    start = date_from.astimezone(timezone.utc) if date_from.tzinfo else date_from.replace(tzinfo=timezone.utc)
    end = date_to.astimezone(timezone.utc) if date_to.tzinfo else date_to.replace(tzinfo=timezone.utc)
    if start >= end:
        return [(start, end)]

    chunks: List[Tuple[datetime, datetime]] = []
    cursor = start
    delta = timedelta(days=max(1, chunk_days))
    while cursor < end:
        nxt = min(cursor + delta, end)
        chunks.append((cursor, nxt))
        cursor = nxt
    return chunks
