"""
100% synthetic MT5 data generator for unit tests and local LedgerFX compatibility verification.
Never connects to MT5 or uses any real trader credentials or account records.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import List, Tuple

from .config import AccountNamespace
from .exporter import (
    ACCOUNT_INFO_CSV_HEADERS,
    DEALS_CSV_HEADERS,
    OPEN_POSITIONS_CSV_HEADERS,
    ORDERS_CSV_HEADERS,
    build_account_info_rows,
    build_deals_rows,
    build_open_positions_rows,
    build_orders_rows,
    write_csv_safely,
)
from .mt5_client import AccountSnapshot


def _epoch(year: int, month: int, day: int, hour: int, minute: int, second: int = 0) -> int:
    return int(datetime(year, month, day, hour, minute, second, tzinfo=timezone.utc).timestamp())


@dataclass(frozen=True)
class SyntheticMT5Bundle:
    snapshot: AccountSnapshot
    deals: List[SimpleNamespace]
    orders: List[SimpleNamespace]
    open_positions: List[SimpleNamespace]


def create_synthetic_mt5_bundle() -> SyntheticMT5Bundle:
    """
    Build a realistic, strictly synthetic MT5 dataset including:
      - 1 initial deposit (DEAL_TYPE_BALANCE)
      - Position #780101 (EURUSD BUY): single entry & single winning exit with SL/TP from order
      - Position #780102 (GBPUSD SELL): single entry & stop-loss exit with swap/commission
      - Position #780103 (XAUUSD BUY): 2 scaled-in entries + 2 partial exits (tests partial fill grouping
        AND sanitisation of commas/semicolons in broker comments)
      - Position #780104 (USDJPY SELL): currently open position (entry deal + live open position)
    """
    snapshot = AccountSnapshot(
        login="99001234",
        server="SyntheticBroker-Demo01",
        company="Synthetic Test Broker Ltd",
        currency="USD",
        leverage=100,
        trade_mode=0,  # Demo
        margin_mode=2,  # Hedging
        balance=10688.70,
        equity=10754.20,
        profit=65.50,
        margin=450.00,
        margin_free=10304.20,
        margin_level=2389.82,
        trade_allowed=False,
        terminal_trade_allowed=False,
        connected=True,
        captured_at_utc="2026-11-20T18:00:00Z",
    )

    orders = [
        SimpleNamespace(
            ticket=680101,
            position_id=780101,
            symbol="EURUSD",
            type=0,  # ORDER_TYPE_BUY
            state=4,  # ORDER_STATE_FILLED
            volume_initial=0.50,
            volume_current=0.00,
            price_open=1.08200,
            price_current=1.08200,
            sl=1.07900,
            tp=1.08800,
            time_setup=_epoch(2026, 11, 10, 9, 15, 0),
            time_done=_epoch(2026, 11, 10, 9, 15, 1),
            magic=0,
            comment="London open breakout, clean structure",
        ),
        SimpleNamespace(
            ticket=680102,
            position_id=780101,
            symbol="EURUSD",
            type=1,  # ORDER_TYPE_SELL
            state=4,
            volume_initial=0.50,
            volume_current=0.00,
            price_open=1.08740,
            price_current=1.08740,
            sl=1.07900,
            tp=1.08800,
            time_setup=_epoch(2026, 11, 10, 14, 40, 0),
            time_done=_epoch(2026, 11, 10, 14, 40, 2),
            magic=0,
            comment="TP approach manual close",
        ),
        SimpleNamespace(
            ticket=680103,
            position_id=780102,
            symbol="GBPUSD",
            type=1,  # ORDER_TYPE_SELL
            state=4,
            volume_initial=0.40,
            volume_current=0.00,
            price_open=1.26850,
            price_current=1.26850,
            sl=1.27150,
            tp=1.26100,
            time_setup=_epoch(2026, 11, 12, 10, 5, 0),
            time_done=_epoch(2026, 11, 12, 10, 5, 1),
            magic=0,
            comment="NY pullback; resistance test",
        ),
        SimpleNamespace(
            ticket=680104,
            position_id=780102,
            symbol="GBPUSD",
            type=0,
            state=4,
            volume_initial=0.40,
            volume_current=0.00,
            price_open=1.27150,
            price_current=1.27150,
            sl=1.27150,
            tp=1.26100,
            time_setup=_epoch(2026, 11, 13, 8, 20, 0),
            time_done=_epoch(2026, 11, 13, 8, 20, 0),
            magic=0,
            comment="[sl 1.27150]",
        ),
        SimpleNamespace(
            ticket=680105,
            position_id=780103,
            symbol="XAUUSD",
            type=0,
            state=4,
            volume_initial=0.30,
            volume_current=0.00,
            price_open=2640.50,
            price_current=2640.50,
            sl=2628.00,
            tp=2665.00,
            time_setup=_epoch(2026, 11, 17, 9, 30, 0),
            time_done=_epoch(2026, 11, 17, 9, 30, 1),
            magic=0,
            comment="Scale-in leg 1, gold trend",
        ),
        SimpleNamespace(
            ticket=680106,
            position_id=780103,
            symbol="XAUUSD",
            type=0,
            state=4,
            volume_initial=0.20,
            volume_current=0.00,
            price_open=2644.00,
            price_current=2644.00,
            sl=2632.00,
            tp=2665.00,
            time_setup=_epoch(2026, 11, 17, 11, 10, 0),
            time_done=_epoch(2026, 11, 17, 11, 10, 1),
            magic=0,
            comment="Scale-in leg 2; retest",
        ),
        SimpleNamespace(
            ticket=680107,
            position_id=780103,
            symbol="XAUUSD",
            type=1,
            state=4,
            volume_initial=0.25,
            volume_current=0.00,
            price_open=2653.50,
            price_current=2653.50,
            sl=2642.00,
            tp=2665.00,
            time_setup=_epoch(2026, 11, 17, 14, 25, 0),
            time_done=_epoch(2026, 11, 17, 14, 25, 1),
            magic=0,
            comment="Partial exit 1, 50% off",
        ),
        SimpleNamespace(
            ticket=680108,
            position_id=780103,
            symbol="XAUUSD",
            type=1,
            state=4,
            volume_initial=0.25,
            volume_current=0.00,
            price_open=2662.00,
            price_current=2662.00,
            sl=2645.00,
            tp=2665.00,
            time_setup=_epoch(2026, 11, 17, 16, 50, 0),
            time_done=_epoch(2026, 11, 17, 16, 50, 1),
            magic=0,
            comment="Final exit 2, target zone",
        ),
        SimpleNamespace(
            ticket=680109,
            position_id=780104,
            symbol="USDJPY",
            type=1,
            state=4,
            volume_initial=0.30,
            volume_current=0.00,
            price_open=154.650,
            price_current=154.650,
            sl=155.150,
            tp=153.400,
            time_setup=_epoch(2026, 11, 20, 13, 15, 0),
            time_done=_epoch(2026, 11, 20, 13, 15, 1),
            magic=0,
            comment="Open swing short",
        ),
    ]

    deals = [
        SimpleNamespace(
            ticket=980100,
            order=0,
            position_id=0,
            time=_epoch(2026, 11, 1, 8, 0, 0),
            symbol="",
            type=2,  # DEAL_TYPE_BALANCE
            entry=0,
            volume=0.0,
            price=0.0,
            profit=10000.00,
            commission=0.0,
            swap=0.0,
            fee=0.0,
            comment="Synthetic initial account deposit",
        ),
        # Trade 1: EURUSD BUY (win)
        SimpleNamespace(
            ticket=980101,
            order=680101,
            position_id=780101,
            time=_epoch(2026, 11, 10, 9, 15, 1),
            symbol="EURUSD",
            type=0,  # BUY
            entry=0,  # IN
            volume=0.50,
            price=1.08200,
            profit=0.00,
            commission=-1.75,
            swap=0.00,
            fee=0.00,
            comment="London open breakout, clean structure",
        ),
        SimpleNamespace(
            ticket=980102,
            order=680102,
            position_id=780101,
            time=_epoch(2026, 11, 10, 14, 40, 2),
            symbol="EURUSD",
            type=1,  # SELL
            entry=1,  # OUT
            volume=0.50,
            price=1.08740,
            profit=270.00,
            commission=-1.75,
            swap=0.00,
            fee=0.00,
            comment="TP approach manual close",
        ),
        # Trade 2: GBPUSD SELL (loss + overnight swap)
        SimpleNamespace(
            ticket=980103,
            order=680103,
            position_id=780102,
            time=_epoch(2026, 11, 12, 10, 5, 1),
            symbol="GBPUSD",
            type=1,  # SELL
            entry=0,  # IN
            volume=0.40,
            price=1.26850,
            profit=0.00,
            commission=-1.40,
            swap=0.00,
            fee=0.00,
            comment="NY pullback; resistance test",
        ),
        SimpleNamespace(
            ticket=980104,
            order=680104,
            position_id=780102,
            time=_epoch(2026, 11, 13, 8, 20, 0),
            symbol="GBPUSD",
            type=0,  # BUY
            entry=1,  # OUT
            volume=0.40,
            price=1.27150,
            profit=-120.00,
            commission=-1.40,
            swap=-3.20,
            fee=0.00,
            comment="[sl 1.27150]",
        ),
        # Trade 3: XAUUSD BUY (2 partial entries + 2 partial exits)
        SimpleNamespace(
            ticket=980105,
            order=680105,
            position_id=780103,
            time=_epoch(2026, 11, 17, 9, 30, 1),
            symbol="XAUUSD",
            type=0,  # BUY
            entry=0,  # IN
            volume=0.30,
            price=2640.50,
            profit=0.00,
            commission=-1.50,
            swap=0.00,
            fee=0.00,
            comment="Scale-in leg 1, gold trend",
        ),
        SimpleNamespace(
            ticket=980106,
            order=680106,
            position_id=780103,
            time=_epoch(2026, 11, 17, 11, 10, 1),
            symbol="XAUUSD",
            type=0,  # BUY
            entry=0,  # IN
            volume=0.20,
            price=2644.00,
            profit=0.00,
            commission=-1.00,
            swap=0.00,
            fee=0.00,
            comment="Scale-in leg 2; retest",
        ),
        SimpleNamespace(
            ticket=980107,
            order=680107,
            position_id=780103,
            time=_epoch(2026, 11, 17, 14, 25, 1),
            symbol="XAUUSD",
            type=1,  # SELL
            entry=1,  # OUT
            volume=0.25,
            price=2653.50,
            profit=290.00,
            commission=-1.25,
            swap=0.00,
            fee=0.00,
            comment="Partial exit 1, 50% off",
        ),
        SimpleNamespace(
            ticket=980108,
            order=680108,
            position_id=780103,
            time=_epoch(2026, 11, 17, 16, 50, 1),
            symbol="XAUUSD",
            type=1,  # SELL
            entry=1,  # OUT
            volume=0.25,
            price=2662.00,
            profit=262.50,
            commission=-1.25,
            swap=0.00,
            fee=0.00,
            comment="Final exit 2, target zone",
        ),
        # Open Trade 4 entry deal (still open in open_positions)
        SimpleNamespace(
            ticket=980109,
            order=680109,
            position_id=780104,
            time=_epoch(2026, 11, 20, 13, 15, 1),
            symbol="USDJPY",
            type=1,  # SELL
            entry=0,  # IN
            volume=0.30,
            price=154.650,
            profit=0.00,
            commission=-1.05,
            swap=0.00,
            fee=0.00,
            comment="Open swing short",
        ),
    ]

    open_positions = [
        SimpleNamespace(
            ticket=780104,
            symbol="USDJPY",
            type=1,  # SELL
            volume=0.30,
            price_open=154.650,
            price_current=154.310,
            sl=155.150,
            tp=153.400,
            swap=-1.10,
            commission=-1.05,
            profit=67.65,
            time=_epoch(2026, 11, 20, 13, 15, 1),
            magic=0,
            comment="Open swing short",
        )
    ]

    return SyntheticMT5Bundle(
        snapshot=snapshot,
        deals=deals,
        orders=orders,
        open_positions=open_positions,
    )


def create_synthetic_incremental_followup() -> Tuple[List[SimpleNamespace], List[SimpleNamespace]]:
    """
    Synthetic follow-up deals & orders containing BOTH overlapping old tickets (980108, 980109)
    and a brand-new closing deal (980110) for USDJPY position #780104 to test deduplication.
    """
    base = create_synthetic_mt5_bundle()
    new_order = SimpleNamespace(
        ticket=680110,
        position_id=780104,
        symbol="USDJPY",
        type=0,  # BUY to close SELL
        state=4,
        volume_initial=0.30,
        volume_current=0.00,
        price_open=153.950,
        price_current=153.950,
        sl=155.150,
        tp=153.400,
        time_setup=_epoch(2026, 11, 21, 9, 45, 0),
        time_done=_epoch(2026, 11, 21, 9, 45, 1),
        magic=0,
        comment="Incremental close USDJPY",
    )
    new_deal = SimpleNamespace(
        ticket=980110,
        order=680110,
        position_id=780104,
        time=_epoch(2026, 11, 21, 9, 45, 1),
        symbol="USDJPY",
        type=0,  # BUY
        entry=1,  # OUT
        volume=0.30,
        price=153.950,
        profit=136.40,
        commission=-1.05,
        swap=-1.10,
        fee=0.00,
        comment="Incremental close USDJPY",
    )
    return base.deals[-2:] + [new_deal], base.orders[-2:] + [new_order]


def write_synthetic_sample_directory(sample_dir: Path) -> dict[str, Path]:
    """Generate clean, deterministic synthetic sample CSVs inside sample_output/."""
    bundle = create_synthetic_mt5_bundle()
    deal_rows, _, _, _, _, _ = build_deals_rows(bundle.deals, bundle.orders)
    account_rows = build_account_info_rows(bundle.snapshot)
    pos_rows = build_open_positions_rows(bundle.open_positions)
    order_rows, _ = build_orders_rows(bundle.orders)

    sample_dir.mkdir(parents=True, exist_ok=True)
    deals_path = write_csv_safely(sample_dir / "deals_sample_ledgerfx.csv", DEALS_CSV_HEADERS, deal_rows)
    account_path = write_csv_safely(sample_dir / "account_info_sample.csv", ACCOUNT_INFO_CSV_HEADERS, account_rows)
    positions_path = write_csv_safely(sample_dir / "open_positions_sample.csv", OPEN_POSITIONS_CSV_HEADERS, pos_rows)
    orders_path = write_csv_safely(sample_dir / "orders_sample.csv", ORDERS_CSV_HEADERS, order_rows)

    return {
        "deals": deals_path,
        "account_info": account_path,
        "open_positions": positions_path,
        "orders": orders_path,
    }
