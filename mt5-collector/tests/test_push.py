"""
Tests for the opt-in LedgerFX push path. 100% synthetic data; the "server" is a local stub on 127.0.0.1.
"""

from __future__ import annotations

import io
import json
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

COLLECTOR_ROOT = Path(__file__).resolve().parents[1]
if str(COLLECTOR_ROOT) not in sys.path:
    sys.path.insert(0, str(COLLECTOR_ROOT))
if str(Path(__file__).resolve().parent) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parent))

import collect_mt5  # noqa: E402
from collector.config import CollectorConfig  # noqa: E402
from collector.payload import (  # noqa: E402
    build_deal_rows,
    build_open_position_rows,
    chunk_rows,
    positions_missing_entry,
)
from collector.pusher import (  # noqa: E402
    PushError,
    post_json,
    push_in_chunks,
    read_ingest_token,
    validate_push_url,
)
from collector.sample_generator import create_synthetic_mt5_bundle  # noqa: E402
from test_exporter import FakeMT5Backend  # noqa: E402


class StubServer:
    """Records requests; scripted status codes let tests simulate failures."""

    def __init__(self, statuses=None):
        self.requests: list[dict] = []
        self.statuses = list(statuses or [])
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802
                length = int(self.headers.get("Content-Length", 0))
                body = json.loads(self.rfile.read(length) or b"{}")
                outer.requests.append({"auth": self.headers.get("Authorization"), "body": body, "path": self.path})
                status = outer.statuses.pop(0) if outer.statuses else 200
                payload = (
                    {
                        "deals": {"inserted": len(body.get("deals", [])), "updated": 0, "unchanged": 0, "rejected": 0},
                        "balanceOperations": {"inserted": len(body.get("balanceOperations", [])), "updated": 0, "unchanged": 0, "rejected": 0},
                        "openPositions": len(body["openPositions"]) if "openPositions" in body else None,
                        "rejections": [],
                        "notice": "ok",
                        "reconciliation": None,
                    }
                    if status == 200
                    else {"error": "scripted failure"}
                )
                data = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):  # silence
                pass

        self.httpd = HTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.httpd.server_port}/api/ingest/acc_test"
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.httpd.shutdown()
        self.httpd.server_close()


class PushTests(unittest.TestCase):
    def test_url_validation_refuses_plain_http_to_remote_hosts(self) -> None:
        with self.assertRaises(ValueError):
            validate_push_url("http://example.com/api/ingest/acc")
        with self.assertRaises(ValueError):
            validate_push_url("https://example.com/somewhere/else")
        self.assertTrue(validate_push_url("https://example.com/api/ingest/acc"))
        self.assertTrue(validate_push_url("http://localhost:3000/api/ingest/acc"))

    def test_token_comes_from_env_or_file_never_argv(self) -> None:
        import os

        os.environ["LFX_TEST_TOKEN"] = "lfx_ing_abc"
        self.assertEqual(read_ingest_token("LFX_TEST_TOKEN"), "lfx_ing_abc")
        del os.environ["LFX_TEST_TOKEN"]
        with self.assertRaises(PushError):
            read_ingest_token("LFX_TEST_TOKEN")
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "t.txt"
            p.write_text("  lfx_ing_file \n", encoding="utf-8")
            self.assertEqual(read_ingest_token("LFX_TEST_TOKEN", p), "lfx_ing_file")
        self.assertNotIn("--token ", collect_mt5.build_arg_parser().format_help())

    def test_payload_maps_synthetic_history_with_sl_tp_and_no_invented_rows(self) -> None:
        bundle = create_synthetic_mt5_bundle()
        deals, ops, warnings = build_deal_rows(bundle.deals, bundle.orders)
        self.assertEqual(len(ops), 1)
        self.assertEqual(len(deals), 9)
        xau = [d for d in deals if d["positionId"] == 780103]
        self.assertEqual(len(xau), 4)
        self.assertEqual(xau[0]["sl"], 2628.0)
        self.assertTrue(all(d["serverTime"].count(":") == 2 for d in deals))
        self.assertEqual(len(build_open_position_rows(bundle.open_positions)), len(bundle.open_positions))

    def test_exit_only_positions_are_detected_for_sl_tp_recovery(self) -> None:
        bundle = create_synthetic_mt5_bundle()
        exits_only = [d for d in bundle.deals if int(getattr(d, "entry", 0)) == 1]
        self.assertTrue(positions_missing_entry(exits_only))
        self.assertEqual(positions_missing_entry(bundle.deals), [])

    def test_chunking_splits_large_batches_and_always_yields_one_chunk(self) -> None:
        rows = [{"ticket": i} for i in range(5)]
        chunks = chunk_rows(rows, [{"ticket": 100}], max_rows=2)
        self.assertEqual(sum(len(d) + len(o) for d, o in chunks), 6)
        self.assertTrue(all(len(d) + len(o) <= 2 for d, o in chunks))
        self.assertEqual(chunk_rows([], [], 2), [([], [])])

    def test_push_sends_bearer_token_and_open_positions_only_on_last_chunk(self) -> None:
        bundle = create_synthetic_mt5_bundle()
        deals, ops, _ = build_deal_rows(bundle.deals, bundle.orders)
        with StubServer() as srv:
            summary = push_in_chunks(
                srv.url, "lfx_ing_secret", {"login": "1"}, deals, ops, [{"ticket": 1}], max_rows=4
            )
        self.assertGreater(summary.requests, 1)
        self.assertTrue(all(r["auth"] == "Bearer lfx_ing_secret" for r in srv.requests))
        self.assertNotIn("openPositions", srv.requests[0]["body"])
        self.assertIn("openPositions", srv.requests[-1]["body"])
        self.assertEqual(summary.deals_inserted, len(deals))

    def test_retries_transient_errors_but_not_client_errors(self) -> None:
        sleeps: list[float] = []
        with StubServer(statuses=[503, 200]) as srv:
            result = post_json(srv.url, "t", {"deals": []}, sleep=sleeps.append)
        self.assertEqual(result["notice"], "ok")
        self.assertEqual(len(srv.requests), 2)
        self.assertEqual(len(sleeps), 1)

        with StubServer(statuses=[409]) as srv2:
            with self.assertRaises(PushError) as ctx:
                post_json(srv2.url, "secret-token", {}, sleep=lambda _s: None)
        self.assertEqual(len(srv2.requests), 1)
        self.assertNotIn("secret-token", str(ctx.exception))

    def test_end_to_end_push_updates_checkpoint_and_skips_csv(self) -> None:
        bundle = create_synthetic_mt5_bundle()
        import os

        os.environ["LFX_E2E_TOKEN"] = "lfx_ing_e2e"
        try:
            with StubServer() as srv, tempfile.TemporaryDirectory() as tmp:
                cfg = CollectorConfig(
                    mode="full",
                    output_dir=Path(tmp) / "exports",
                    state_dir=Path(tmp) / "state",
                    confirm_investor_session=True,
                    push_url=srv.url,
                    token_env="LFX_E2E_TOKEN",
                    no_csv=True,
                )
                backend = FakeMT5Backend(deals=bundle.deals, orders=bundle.orders, positions=bundle.open_positions)
                buf = io.StringIO()
                rc = collect_mt5.run_collection(cfg, backend=backend, output_stream=buf)
                self.assertEqual(rc, 0, msg=buf.getvalue())
                self.assertIn("PUSHED TO LEDGERFX", buf.getvalue())
                self.assertNotIn("lfx_ing_e2e", buf.getvalue())
                self.assertFalse((Path(tmp) / "exports").exists())
                self.assertEqual(srv.requests[0]["body"]["accountInfo"]["tradeAllowed"], False)
        finally:
            del os.environ["LFX_E2E_TOKEN"]

    def test_failed_push_does_not_advance_checkpoint(self) -> None:
        bundle = create_synthetic_mt5_bundle()
        import os

        os.environ["LFX_E2E_TOKEN"] = "lfx_ing_e2e"
        try:
            with StubServer(statuses=[401]) as srv, tempfile.TemporaryDirectory() as tmp:
                cfg = CollectorConfig(
                    mode="full",
                    output_dir=Path(tmp) / "exports",
                    state_dir=Path(tmp) / "state",
                    confirm_investor_session=True,
                    push_url=srv.url,
                    token_env="LFX_E2E_TOKEN",
                )
                backend = FakeMT5Backend(deals=bundle.deals, orders=bundle.orders, positions=bundle.open_positions)
                buf = io.StringIO()
                rc = collect_mt5.run_collection(cfg, backend=backend, output_stream=buf)
                self.assertEqual(rc, 1)
                self.assertIn("FAILED", buf.getvalue())
                self.assertFalse((Path(tmp) / "state").exists() and any((Path(tmp) / "state").rglob("*.json")))
        finally:
            del os.environ["LFX_E2E_TOKEN"]

    def test_push_refuses_trade_enabled_session(self) -> None:
        bundle = create_synthetic_mt5_bundle()
        import os

        os.environ["LFX_E2E_TOKEN"] = "lfx_ing_e2e"
        try:
            with StubServer() as srv, tempfile.TemporaryDirectory() as tmp:
                cfg = CollectorConfig(
                    mode="full",
                    output_dir=Path(tmp) / "exports",
                    state_dir=Path(tmp) / "state",
                    push_url=srv.url,
                    token_env="LFX_E2E_TOKEN",
                )
                backend = FakeMT5Backend(deals=bundle.deals, orders=bundle.orders, trade_allowed=True)
                buf = io.StringIO()
                rc = collect_mt5.run_collection(cfg, backend=backend, input_fn=lambda _p: "YES", output_stream=buf)
                self.assertEqual(rc, 2)
                self.assertEqual(srv.requests, [])
        finally:
            del os.environ["LFX_E2E_TOKEN"]


if __name__ == "__main__":
    unittest.main()
