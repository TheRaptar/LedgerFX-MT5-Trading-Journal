"""
Unit and security-guardrail tests for the standalone mt5-collector package.
Uses 100% synthetic data and dependency-injected fake MT5 backends.
Never connects to MetaTrader 5 or touches any real trader account.
"""

from __future__ import annotations

import csv
import io
import json
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Optional

COLLECTOR_ROOT = Path(__file__).resolve().parents[1]
if str(COLLECTOR_ROOT) not in sys.path:
    sys.path.insert(0, str(COLLECTOR_ROOT))

import collect_mt5  # noqa: E402
from collector.config import AccountNamespace, CollectorConfig  # noqa: E402
from collector.exporter import (  # noqa: E402
    DEALS_CSV_HEADERS,
    allocate_non_overwriting_path,
    sanitise_csv_text,
    write_csv_safely,
)
from collector.sample_generator import (  # noqa: E402
    create_synthetic_incremental_followup,
    create_synthetic_mt5_bundle,
)
from collector.state import (  # noqa: E402
    CollectorCheckpoint,
    checkpoint_path_for,
    load_checkpoint,
    save_checkpoint_with_backup,
)


class FakeMT5Backend:
    """In-memory read-only synthetic MT5 backend for deterministic tests."""

    def __init__(
        self,
        *,
        init_ok: bool = True,
        connected: bool = True,
        account_login: Optional[int] = 99001234,
        server: str = "SyntheticBroker-Demo01",
        trade_allowed: bool = False,
        deals: Optional[list[Any]] = None,
        orders: Optional[list[Any]] = None,
        positions: Optional[list[Any]] = None,
        deals_error: bool = False,
    ) -> None:
        self.init_ok = init_ok
        self.connected = connected
        self.account_login = account_login
        self.server = server
        self.trade_allowed = trade_allowed
        self.deals = deals if deals is not None else []
        self.orders = orders if orders is not None else []
        self.positions = positions if positions is not None else []
        self.deals_error = deals_error
        self.shutdown_called = False
        self.history_calls = 0

    def initialize(self, path: Optional[str] = None) -> bool:
        return self.init_ok

    def shutdown(self) -> None:
        self.shutdown_called = True

    def last_error(self) -> tuple[int, str]:
        if not self.init_ok:
            return (-10003, "IPC initialize failed")
        if self.deals_error:
            return (-10004, "History unavailable")
        return (1, "Success")

    def terminal_info(self) -> Any:
        return SimpleNamespace(connected=self.connected, trade_allowed=False)

    def account_info(self) -> Any:
        if self.account_login is None:
            return None
        return SimpleNamespace(
            login=self.account_login,
            server=self.server,
            company="Synthetic Test Broker Ltd",
            currency="USD",
            leverage=100,
            trade_mode=0,
            margin_mode=2,
            balance=10688.70,
            equity=10754.20,
            profit=65.50,
            margin=450.00,
            margin_free=10304.20,
            margin_level=2389.82,
            trade_allowed=self.trade_allowed,
        )

    def positions_get(self) -> Any:
        return tuple(self.positions)

    def history_deals_get(self, date_from: datetime, date_to: datetime) -> Any:
        self.history_calls += 1
        if self.deals_error:
            return None
        return tuple(self.deals)

    def history_orders_get(self, date_from: datetime, date_to: datetime) -> Any:
        return tuple(self.orders)


class MT5CollectorTests(unittest.TestCase):
    def test_comment_sanitisation_removes_delimiters_and_newlines(self) -> None:
        raw = "Scale-in leg 1, gold; retest\twith\nnewline"
        cleaned = sanitise_csv_text(raw)
        self.assertNotIn(",", cleaned)
        self.assertNotIn(";", cleaned)
        self.assertNotIn("\t", cleaned)
        self.assertNotIn("\n", cleaned)
        self.assertEqual(cleaned, "Scale-in leg 1 gold retest with newline")

    def test_account_and_server_namespace_separation(self) -> None:
        ns_a = AccountNamespace(broker_server="BrokerA-Live01", account_login="123456")
        ns_b = AccountNamespace(broker_server="BrokerB-Demo02", account_login="123456")
        self.assertNotEqual(ns_a.folder_name, ns_b.folder_name)
        self.assertEqual(ns_a.folder_name, "BrokerA-Live01__123456")
        self.assertEqual(ns_b.folder_name, "BrokerB-Demo02__123456")

    def test_checkpoint_creates_backup_and_never_silently_overwrites(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            state_dir = Path(tmp) / "state"
            ns = AccountNamespace(broker_server="SyntheticBroker-Demo01", account_login="99001234")

            cp1 = CollectorCheckpoint(
                account_login="99001234",
                broker_server="SyntheticBroker-Demo01",
                highest_deal_ticket=100,
                total_runs=1,
            )
            path1, backup1 = save_checkpoint_with_backup(
                state_dir, ns, cp1, now_utc=datetime(2026, 11, 20, 10, 0, 0, tzinfo=timezone.utc)
            )
            self.assertTrue(path1.exists())
            self.assertIsNone(backup1)

            cp2 = CollectorCheckpoint(
                account_login="99001234",
                broker_server="SyntheticBroker-Demo01",
                highest_deal_ticket=250,
                total_runs=2,
            )
            path2, backup2 = save_checkpoint_with_backup(
                state_dir, ns, cp2, now_utc=datetime(2026, 11, 20, 12, 0, 0, tzinfo=timezone.utc)
            )
            self.assertEqual(path1, path2)
            self.assertIsNotNone(backup2)
            assert backup2 is not None
            self.assertTrue(backup2.exists())
            old_data = json.loads(backup2.read_text(encoding="utf-8"))
            new_data = json.loads(path2.read_text(encoding="utf-8"))
            self.assertEqual(old_data["highest_deal_ticket"], 100)
            self.assertEqual(new_data["highest_deal_ticket"], 250)

    def test_non_overwriting_export_allocation(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            out_dir = Path(tmp)
            p1 = allocate_non_overwriting_path(out_dir, "deals_test", ".csv")
            write_csv_safely(p1, ["A"], [["1"]])
            p2 = allocate_non_overwriting_path(out_dir, "deals_test", ".csv")
            self.assertNotEqual(p1, p2)
            self.assertTrue(p2.name.endswith("_01.csv"))

    def test_manual_confirmation_declined_aborts_without_reading_history(self) -> None:
        bundle = create_synthetic_mt5_bundle()
        backend = FakeMT5Backend(
            deals=bundle.deals,
            orders=bundle.orders,
            positions=bundle.open_positions,
            trade_allowed=False,
        )
        with tempfile.TemporaryDirectory() as tmp:
            cfg = CollectorConfig(
                mode="full",
                output_dir=Path(tmp) / "exports",
                state_dir=Path(tmp) / "state",
            )
            buf = io.StringIO()
            rc = collect_mt5.run_collection(
                cfg,
                backend=backend,
                input_fn=lambda _prompt: "no",
                output_stream=buf,
            )
            self.assertEqual(rc, 2)
            self.assertEqual(backend.history_calls, 0)
            self.assertIn("trade_allowed", buf.getvalue())
            self.assertIn("does NOT prove", buf.getvalue())
            self.assertTrue(backend.shutdown_called)

    def test_unattended_flag_refuses_when_trade_allowed_is_true(self) -> None:
        bundle = create_synthetic_mt5_bundle()
        backend = FakeMT5Backend(
            deals=bundle.deals,
            orders=bundle.orders,
            positions=bundle.open_positions,
            trade_allowed=True,
        )
        with tempfile.TemporaryDirectory() as tmp:
            cfg = CollectorConfig(
                mode="incremental",
                output_dir=Path(tmp) / "exports",
                state_dir=Path(tmp) / "state",
                confirm_investor_session=True,
            )
            buf = io.StringIO()
            rc = collect_mt5.run_collection(cfg, backend=backend, output_stream=buf)
            self.assertEqual(rc, 2)
            self.assertEqual(backend.history_calls, 0)
            self.assertIn("ABORTED", buf.getvalue())

    def test_full_then_incremental_collection_preserves_partials_and_prevents_duplicates(self) -> None:
        bundle = create_synthetic_mt5_bundle()
        followup_deals, followup_orders = create_synthetic_incremental_followup()

        with tempfile.TemporaryDirectory() as tmp:
            out_dir = Path(tmp) / "exports"
            state_dir = Path(tmp) / "state"

            # Run 1: Full collection
            backend1 = FakeMT5Backend(
                deals=bundle.deals,
                orders=bundle.orders,
                positions=bundle.open_positions,
                trade_allowed=False,
            )
            cfg1 = CollectorConfig(mode="full", output_dir=out_dir, state_dir=state_dir)
            buf1 = io.StringIO()
            rc1 = collect_mt5.run_collection(
                cfg1,
                backend=backend1,
                input_fn=lambda _p: "YES",
                output_stream=buf1,
                now_utc=datetime(2026, 11, 20, 18, 0, 0, tzinfo=timezone.utc),
            )
            self.assertEqual(rc1, 0, msg=buf1.getvalue())

            ns = AccountNamespace(broker_server="SyntheticBroker-Demo01", account_login="99001234")
            cp1 = load_checkpoint(state_dir, ns)
            self.assertEqual(cp1.highest_deal_ticket, 980109)
            self.assertEqual(cp1.total_runs, 1)

            # Verify exported CSV headers, SL/TP enrichment, and partial-fill preservation
            first_deals_csv = Path(cp1.last_deals_export_file or "")
            self.assertTrue(first_deals_csv.exists())
            with first_deals_csv.open("r", encoding="utf-8", newline="") as fh:
                rows = list(csv.reader(fh))
            self.assertEqual(rows[0], DEALS_CSV_HEADERS)
            self.assertEqual(len(rows) - 1, 10)  # 1 balance + 9 trade deals

            # Verify XAUUSD position #780103 preserved all 4 partial fills and enriched SL/TP
            xau_rows = [r for r in rows[1:] if r[2] == "780103"]
            self.assertEqual(len(xau_rows), 4)
            self.assertEqual(xau_rows[0][12], "2628.00000")  # SL from order 680105
            self.assertEqual(xau_rows[0][13], "2665.00000")  # TP from order 680105

            # Run 2: Incremental collection with overlapping old tickets (980108, 980109) + 1 new ticket (980110)
            backend2 = FakeMT5Backend(
                deals=followup_deals,
                orders=followup_orders,
                positions=[],
                trade_allowed=False,
            )
            cfg2 = CollectorConfig(mode="incremental", output_dir=out_dir, state_dir=state_dir)
            buf2 = io.StringIO()
            rc2 = collect_mt5.run_collection(
                cfg2,
                backend=backend2,
                input_fn=lambda _p: "YES",
                output_stream=buf2,
                now_utc=datetime(2026, 11, 21, 10, 0, 0, tzinfo=timezone.utc),
            )
            self.assertEqual(rc2, 0, msg=buf2.getvalue())

            cp2 = load_checkpoint(state_dir, ns)
            self.assertEqual(cp2.highest_deal_ticket, 980110)
            self.assertEqual(cp2.total_runs, 2)
            self.assertNotEqual(cp1.last_deals_export_file, cp2.last_deals_export_file)
            self.assertTrue(first_deals_csv.exists())  # First export untouched

            second_deals_csv = Path(cp2.last_deals_export_file or "")
            with second_deals_csv.open("r", encoding="utf-8", newline="") as fh:
                inc_rows = list(csv.reader(fh))
            # Only the brand-new deal #980110 should be exported; overlapping #980108 and #980109 skipped
            self.assertEqual(len(inc_rows) - 1, 1)
            self.assertEqual(inc_rows[1][0], "980110")

            # Verify checkpoint backup was created
            backups_dir = checkpoint_path_for(state_dir, ns).parent / "backups"
            self.assertEqual(len(list(backups_dir.glob("checkpoint_*.json"))), 1)

    def test_error_handling_disconnected_invalid_account_and_unavailable_history(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            cfg = CollectorConfig(
                mode="incremental",
                output_dir=Path(tmp) / "exports",
                state_dir=Path(tmp) / "state",
            )

            # 1. Terminal not running / initialize failed
            buf_init = io.StringIO()
            rc_init = collect_mt5.run_collection(cfg, backend=FakeMT5Backend(init_ok=False), output_stream=buf_init)
            self.assertEqual(rc_init, 1)
            self.assertIn("Unable to attach", buf_init.getvalue())

            # 2. Terminal open but disconnected
            buf_disc = io.StringIO()
            rc_disc = collect_mt5.run_collection(cfg, backend=FakeMT5Backend(connected=False), output_stream=buf_disc)
            self.assertEqual(rc_disc, 1)
            self.assertIn("disconnected", buf_disc.getvalue())

            # 3. Invalid / unlogged account session
            buf_acc = io.StringIO()
            rc_acc = collect_mt5.run_collection(cfg, backend=FakeMT5Backend(account_login=None), output_stream=buf_acc)
            self.assertEqual(rc_acc, 1)
            self.assertIn("No active MT5 account session", buf_acc.getvalue())

            # 4. Broker history unavailable
            buf_hist = io.StringIO()
            rc_hist = collect_mt5.run_collection(
                cfg,
                backend=FakeMT5Backend(deals_error=True),
                input_fn=lambda _p: "YES",
                output_stream=buf_hist,
            )
            self.assertEqual(rc_hist, 1)
            self.assertIn("unavailable deal history", buf_hist.getvalue())

    def test_static_security_guardrails_no_trading_no_network_no_password_capture(self) -> None:
        """Verify collector source code contains zero trading calls, zero network clients, and zero password prompts."""
        source_files = [
            COLLECTOR_ROOT / "collect_mt5.py",
            *(COLLECTOR_ROOT / "collector").glob("*.py"),
        ]
        forbidden_tokens = [
            "order_send",
            "order_check",
            "order_calc_margin",
            "order_calc_profit",
            "getpass",
            "import requests",
            "import socket",
            "import httpx",
            "mt5.login(",
        ]
        # Network code is allowed ONLY in the opt-in pusher module, which talks to the single
        # operator-configured LedgerFX URL. Everything else must stay network-free.
        network_tokens = ["urllib", "http.client"]
        for file_path in source_files:
            content = file_path.read_text(encoding="utf-8")
            for token in forbidden_tokens:
                self.assertNotIn(
                    token,
                    content,
                    msg=f"Forbidden token '{token}' found in {file_path.name}",
                )
            if file_path.name != "pusher.py":
                for token in network_tokens:
                    self.assertNotIn(
                        token,
                        content,
                        msg=f"Network token '{token}' found outside pusher.py in {file_path.name}",
                    )


if __name__ == "__main__":
    unittest.main()
