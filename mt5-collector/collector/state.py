"""Persistent per-account incremental checkpoint store with safe non-destructive backups."""

from __future__ import annotations

import json
import os
import shutil
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from .config import AccountNamespace


@dataclass
class CollectorCheckpoint:
    """Tracks the last successfully exported deal ticket and timestamps for one (server, login)."""

    account_login: str
    broker_server: str
    highest_deal_ticket: int = 0
    highest_order_ticket: int = 0
    last_deal_server_epoch: int = 0
    last_collection_utc: Optional[str] = None
    last_mode: Optional[str] = None
    total_runs: int = 0
    last_deals_export_file: Optional[str] = None


def checkpoint_path_for(state_dir: Path, namespace: AccountNamespace) -> Path:
    return state_dir / namespace.folder_name / "checkpoint.json"


def load_checkpoint(state_dir: Path, namespace: AccountNamespace) -> CollectorCheckpoint:
    """Load an existing checkpoint for this (broker_server, account_login), or return a fresh one."""
    cp_path = checkpoint_path_for(state_dir, namespace)
    if not cp_path.exists():
        return CollectorCheckpoint(
            account_login=namespace.account_login,
            broker_server=namespace.broker_server,
        )

    try:
        raw = json.loads(cp_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(
            f"Checkpoint file '{cp_path}' is unreadable or corrupted ({exc}). "
            "Move or inspect it before continuing so no state is silently overwritten."
        ) from exc

    return CollectorCheckpoint(
        account_login=str(raw.get("account_login", namespace.account_login)),
        broker_server=str(raw.get("broker_server", namespace.broker_server)),
        highest_deal_ticket=int(raw.get("highest_deal_ticket", 0)),
        highest_order_ticket=int(raw.get("highest_order_ticket", 0)),
        last_deal_server_epoch=int(raw.get("last_deal_server_epoch", 0)),
        last_collection_utc=raw.get("last_collection_utc"),
        last_mode=raw.get("last_mode"),
        total_runs=int(raw.get("total_runs", 0)),
        last_deals_export_file=raw.get("last_deals_export_file"),
    )


def save_checkpoint_with_backup(
    state_dir: Path,
    namespace: AccountNamespace,
    checkpoint: CollectorCheckpoint,
    now_utc: Optional[datetime] = None,
) -> tuple[Path, Optional[Path]]:
    """
    Persist checkpoint.json atomically and NEVER silently overwrite an existing checkpoint:
    if checkpoint.json already exists, copy it into state/<namespace>/backups/ first.
    """
    ts_dt = now_utc or datetime.now(timezone.utc)
    ts_label = ts_dt.strftime("%Y%m%d_%H%M%SZ")

    cp_path = checkpoint_path_for(state_dir, namespace)
    cp_path.parent.mkdir(parents=True, exist_ok=True)

    backup_path: Optional[Path] = None
    if cp_path.exists():
        backups_dir = cp_path.parent / "backups"
        backups_dir.mkdir(parents=True, exist_ok=True)
        candidate = backups_dir / f"checkpoint_{ts_label}.json"
        counter = 1
        while candidate.exists():
            candidate = backups_dir / f"checkpoint_{ts_label}_{counter:02d}.json"
            counter += 1
        shutil.copy2(cp_path, candidate)
        backup_path = candidate

    tmp_path = cp_path.with_name(f".checkpoint_{ts_label}.tmp")
    payload = json.dumps(asdict(checkpoint), indent=2, sort_keys=True) + "\n"
    tmp_path.write_text(payload, encoding="utf-8")
    os.replace(tmp_path, cp_path)
    return cp_path, backup_path
