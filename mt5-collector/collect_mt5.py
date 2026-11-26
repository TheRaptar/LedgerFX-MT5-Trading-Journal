#!/usr/bin/env python3
"""
LedgerFX Standalone Periodic MT5 Data Collector (Method 5)

Connects strictly read-only to your already-running Windows MetaTrader 5 Desktop terminal
using the official MetaTrader5 Python package and exports LedgerFX-compatible CSV files locally.

Safeguards:
- Never requests, stores, transmits, or logs any MT5 Master or Investor password.
- Never performs trading, order placement, modification, copying, or account management.
- Makes zero external network requests or cloud uploads.
- Displays a clear Investor Password session verification warning and requires explicit
  manual confirmation before reading real account history (unless explicitly acknowledged
  for scheduled runs via --confirm-investor-session).
- Separates exports and checkpoints strictly by (broker_server, account_login).
- Never silently overwrites existing exports or checkpoint files.
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, Optional, Sequence

from collector.config import (
    AccountNamespace,
    CollectorConfig,
    DEFAULT_CHUNK_DAYS,
    DEFAULT_FULL_HISTORY_START_YEAR,
    DEFAULT_LOOKBACK_DAYS,
)
from collector.exporter import export_collection_bundle
from collector.mt5_client import (
    AccountSnapshot,
    MT5BackendProtocol,
    MT5CollectorError,
    ReadOnlyMT5Client,
)
from collector.sample_generator import write_synthetic_sample_directory
from collector.state import load_checkpoint, save_checkpoint_with_backup


def _parse_iso_date(value: str) -> datetime:
    cleaned = value.strip()
    for fmt in ("%Y-%m-%d", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M:%SZ"):
        try:
            dt = datetime.strptime(cleaned, fmt)
            return dt.replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    raise argparse.ArgumentTypeError(
        f"Invalid date '{value}'. Expected YYYY-MM-DD (for example: 2025-01-01)."
    )


def format_session_verification_notice(snapshot: AccountSnapshot) -> str:
    """
    Build a clear operator warning explaining that trade_allowed alone does NOT prove
    Investor Password access, and showing the exact detected session details.
    """
    lines = [
        "=" * 76,
        "MT5 SESSION VERIFICATION — MANUAL INVESTOR PASSWORD CHECK REQUIRED",
        "=" * 76,
        f"  Detected Account Login : {snapshot.login}",
        f"  Broker / Company       : {snapshot.company}",
        f"  Broker Server          : {snapshot.server}",
        f"  Account Currency       : {snapshot.currency}",
        f"  Account trade_allowed  : {snapshot.trade_allowed}",
        f"  Terminal trade_allowed : {snapshot.terminal_trade_allowed}",
        "-" * 76,
        "IMPORTANT SECURITY NOTICE:",
        "  1. The MT5 'trade_allowed' flag alone does NOT prove that this terminal is",
        "     logged in with a read-only Investor Password (for example, disabled",
        "     Algo Trading or broker restrictions can also report trade_allowed=False).",
    ]
    if snapshot.trade_allowed:
        lines.extend(
            [
                "  2. WARNING: account.trade_allowed is True, which strongly indicates this",
                "     MT5 terminal may be logged in with your MASTER trading password!",
                "     Switch MT5 to your read-only Investor Password before continuing.",
            ]
        )
    else:
        lines.extend(
            [
                "  2. Even though account.trade_allowed is False, confirm inside MT5",
                "     (File -> Login to Trade Account) that you signed in using your",
                "     read-only Investor Password.",
            ]
        )
    lines.extend(
        [
            "  3. This collector performs strictly READ-ONLY local exports and never",
            "     requests, stores, transmits, or logs any password.",
            "=" * 76,
        ]
    )
    return "\n".join(lines)


def verify_operator_confirmation(
    snapshot: AccountSnapshot,
    confirm_flag: bool,
    input_fn: Callable[[str], str] = input,
    output_stream=None,
) -> tuple[bool, str]:
    """
    Require explicit manual confirmation before reading real account history.
    Returns (confirmed, confirmation_method).
    """
    out = output_stream or sys.stdout
    print(format_session_verification_notice(snapshot), file=out)

    if confirm_flag:
        if snapshot.trade_allowed:
            print(
                "ABORTED: --confirm-investor-session cannot be used while account.trade_allowed is True.\n"
                "Log into MT5 with your read-only Investor Password first, or run interactively.",
                file=out,
            )
            return False, "rejected_trade_allowed_true"
        print(
            "Unattended confirmation flag (--confirm-investor-session) supplied and "
            "account.trade_allowed is False. Proceeding with read-only local collection.",
            file=out,
        )
        return True, "cli_flag_confirmed"

    if not sys.stdin.isatty() and input_fn is input:
        print(
            "ABORTED: Interactive terminal required for manual Investor Password confirmation.\n"
            "Run from Windows Command Prompt/PowerShell to confirm interactively, or pass\n"
            "--confirm-investor-session only after verifying your MT5 Investor Password session.",
            file=out,
        )
        return False, "non_interactive_abort"

    prompt = (
        f"Confirm that MT5 account #{snapshot.login} on '{snapshot.server}' is logged in\n"
        "with your read-only INVESTOR PASSWORD. Type YES to proceed (anything else cancels): "
    )
    try:
        answer = input_fn(prompt).strip()
    except (EOFError, KeyboardInterrupt):
        print("\nCollection cancelled by user.", file=out)
        return False, "user_cancelled"

    if answer != "YES":
        print("Collection cancelled. No account history was read or written.", file=out)
        return False, "user_declined"

    return True, "interactive_yes"


def compute_fetch_window(
    config: CollectorConfig,
    last_deal_server_epoch: int,
    now_utc: datetime,
) -> tuple[datetime, datetime]:
    """Determine (date_from, date_to) for incremental vs full collection."""
    # Add a 1-day forward buffer because MT5 broker server time may be ahead of UTC (e.g. GMT+2/GMT+3).
    date_to = config.to_date or (now_utc + timedelta(days=1))

    if config.from_date is not None:
        return config.from_date, date_to

    if config.mode == "incremental" and last_deal_server_epoch > 0:
        last_dt = datetime.fromtimestamp(last_deal_server_epoch, tz=timezone.utc)
        date_from = last_dt - timedelta(days=config.lookback_days)
        return date_from, date_to

    # Full history or first-ever incremental run with no prior checkpoint
    return datetime(DEFAULT_FULL_HISTORY_START_YEAR, 1, 1, tzinfo=timezone.utc), date_to


def run_collection(
    config: CollectorConfig,
    backend: Optional[MT5BackendProtocol] = None,
    input_fn: Callable[[str], str] = input,
    output_stream=None,
    now_utc: Optional[datetime] = None,
) -> int:
    """Execute one local read-only MT5 collection cycle and print a clear report."""
    out = output_stream or sys.stdout
    config.validate()
    run_now = now_utc or datetime.now(timezone.utc)

    try:
        with ReadOnlyMT5Client(terminal_path=config.terminal_path, backend=backend) as client:
            snapshot = client.get_account_snapshot()

            confirmed, confirmation_method = verify_operator_confirmation(
                snapshot=snapshot,
                confirm_flag=config.confirm_investor_session,
                input_fn=input_fn,
                output_stream=out,
            )
            if not confirmed:
                return 2

            namespace = AccountNamespace(
                broker_server=snapshot.server,
                account_login=snapshot.login,
            )
            checkpoint = load_checkpoint(config.state_dir, namespace)
            date_from, date_to = compute_fetch_window(
                config=config,
                last_deal_server_epoch=checkpoint.last_deal_server_epoch,
                now_utc=run_now,
            )

            raw_deals = client.get_history_deals(date_from, date_to, chunk_days=config.chunk_days)
            raw_orders = client.get_history_orders(date_from, date_to, chunk_days=config.chunk_days)
            open_positions = client.get_open_positions()

            artifacts = export_collection_bundle(
                output_dir=config.output_dir,
                namespace=namespace,
                snapshot=snapshot,
                raw_deals=raw_deals,
                raw_orders=raw_orders,
                open_positions=open_positions,
                mode=config.mode,
                previous_highest_deal_ticket=checkpoint.highest_deal_ticket,
                previous_highest_order_ticket=checkpoint.highest_order_ticket,
                now_utc=run_now,
                investor_session_confirmation_method=confirmation_method,
            )

            checkpoint.highest_deal_ticket = artifacts.highest_deal_ticket
            checkpoint.highest_order_ticket = artifacts.highest_order_ticket
            if artifacts.last_deal_server_epoch > checkpoint.last_deal_server_epoch:
                checkpoint.last_deal_server_epoch = artifacts.last_deal_server_epoch
            checkpoint.last_collection_utc = run_now.strftime("%Y-%m-%dT%H:%M:%SZ")
            checkpoint.last_mode = config.mode
            checkpoint.total_runs += 1
            checkpoint.last_deals_export_file = str(artifacts.deals_csv)

            cp_path, cp_backup = save_checkpoint_with_backup(
                state_dir=config.state_dir,
                namespace=namespace,
                checkpoint=checkpoint,
                now_utc=run_now,
            )

            print("", file=out)
            print("=" * 76, file=out)
            print("LEDGERFX MT5 COLLECTION REPORT — SUCCESS", file=out)
            print("=" * 76, file=out)
            print(f"  Account           : #{snapshot.login} ({snapshot.company})", file=out)
            print(f"  Broker Server     : {snapshot.server}", file=out)
            print(f"  Collection Mode   : {config.mode}", file=out)
            print(f"  History Window    : {date_from.strftime('%Y-%m-%d')} -> {date_to.strftime('%Y-%m-%d')} (UTC)", file=out)
            print(f"  Deals Exported    : {artifacts.deals_exported} ({artifacts.trade_deals_exported} trade, {artifacts.balance_ops_exported} balance ops)", file=out)
            print(f"  Orders Exported   : {artifacts.orders_exported}", file=out)
            print(f"  Open Positions    : {artifacts.open_positions_exported}", file=out)
            print(f"  Highest Ticket    : #{artifacts.highest_deal_ticket}", file=out)
            print("-" * 76, file=out)
            print(f"  LedgerFX Deals CSV: {artifacts.deals_csv}", file=out)
            print(f"  Account Info CSV  : {artifacts.account_info_csv}", file=out)
            print(f"  Open Positions CSV: {artifacts.open_positions_csv}", file=out)
            print(f"  Orders CSV        : {artifacts.orders_csv}", file=out)
            print(f"  Run Report JSON   : {artifacts.report_json}", file=out)
            print(f"  Checkpoint File   : {cp_path}", file=out)
            if cp_backup:
                print(f"  Checkpoint Backup : {cp_backup}", file=out)
            if artifacts.warnings:
                print("-" * 76, file=out)
                print("  Warnings:", file=out)
                for w in artifacts.warnings:
                    print(f"    - {w}", file=out)
            print("-" * 76, file=out)
            print(
                "  Next Step: In LedgerFX -> Accounts -> Import CSV, upload the Deals CSV above.",
                file=out,
            )
            print("=" * 76, file=out)
            return 0

    except (MT5CollectorError, RuntimeError, ValueError, OSError) as exc:
        print("", file=out)
        print("=" * 76, file=out)
        print("LEDGERFX MT5 COLLECTION REPORT — FAILED", file=out)
        print("=" * 76, file=out)
        print(f"  Error: {exc}", file=out)
        print("=" * 76, file=out)
        return 1


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="collect_mt5.py",
        description="Read-only local MetaTrader 5 CSV collector for LedgerFX (no passwords stored or requested).",
    )
    parser.add_argument(
        "--mode",
        choices=("incremental", "full"),
        default="incremental",
        help="Collection mode: 'incremental' exports only new deals since the last checkpoint; 'full' exports complete history.",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path(__file__).resolve().parent / "exports",
        help="Base local folder for exported CSV files (subfolders created per broker server and account login).",
    )
    parser.add_argument(
        "--state-dir",
        type=Path,
        default=Path(__file__).resolve().parent / "state",
        help="Base local folder for per-account incremental checkpoints and backups.",
    )
    parser.add_argument(
        "--terminal-path",
        type=str,
        default=None,
        help="Optional full path to terminal64.exe if you have multiple MetaTrader 5 installations.",
    )
    parser.add_argument(
        "--from-date",
        type=_parse_iso_date,
        default=None,
        help="Optional start date override (YYYY-MM-DD, UTC).",
    )
    parser.add_argument(
        "--to-date",
        type=_parse_iso_date,
        default=None,
        help="Optional end date override (YYYY-MM-DD, UTC).",
    )
    parser.add_argument(
        "--lookback-days",
        type=int,
        default=DEFAULT_LOOKBACK_DAYS,
        help=f"Safety overlap window in days for incremental runs (default: {DEFAULT_LOOKBACK_DAYS}). Deduplicated by deal ticket.",
    )
    parser.add_argument(
        "--chunk-days",
        type=int,
        default=DEFAULT_CHUNK_DAYS,
        help=f"Date chunk size in days for multi-year history pulls (default: {DEFAULT_CHUNK_DAYS}).",
    )
    parser.add_argument(
        "--confirm-investor-session",
        action="store_true",
        help=(
            "For intentional Windows Task Scheduler runs ONLY: acknowledges you have manually verified "
            "MT5 is logged in with a read-only Investor Password (still refuses if account.trade_allowed is True)."
        ),
    )
    parser.add_argument(
        "--generate-sample",
        action="store_true",
        help="Generate synthetic sample CSVs into sample_output/ without connecting to MetaTrader 5.",
    )
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)

    if args.generate_sample:
        sample_dir = Path(__file__).resolve().parent / "sample_output"
        written = write_synthetic_sample_directory(sample_dir)
        print("Generated synthetic sample CSV files (no MT5 connection made):")
        for label, path in written.items():
            print(f"  - {label}: {path}")
        return 0

    config = CollectorConfig(
        mode=args.mode,
        output_dir=args.output_dir,
        state_dir=args.state_dir,
        terminal_path=args.terminal_path,
        from_date=args.from_date,
        to_date=args.to_date,
        lookback_days=args.lookback_days,
        chunk_days=args.chunk_days,
        confirm_investor_session=args.confirm_investor_session,
    )
    return run_collection(config)


if __name__ == "__main__":
    raise SystemExit(main())
