"""
Normalises read-only MT5 data structures and writes LedgerFX-compatible local CSV files.

Key guarantees:
- Exact 15-column LedgerFX Deals CSV format matching src/shared/mt5Engine.ts (parseMT5CsvDeals).
- Sanitises delimiters/newlines in text fields so LedgerFX's CSV parser never shifts columns.
- Enriches historical deals with SL/TP from matching historical orders for accurate R-multiple calculation.
- Preserves all partial entries and partial exits under their shared DEAL_POSITION_ID.
- Deduplicates deals/orders by ticket and never silently overwrites existing export files.
"""

from __future__ import annotations

import csv
import json
import os
import re
import shutil
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from .config import AccountNamespace
from .mt5_client import AccountSnapshot


# Exact headers expected by LedgerFX's parseMT5CsvDeals()
DEALS_CSV_HEADERS = [
    "DEAL_TICKET",
    "DEAL_ORDER",
    "DEAL_POSITION_ID",
    "DEAL_TIME",
    "DEAL_SYMBOL",
    "DEAL_TYPE",
    "DEAL_ENTRY",
    "DEAL_VOLUME",
    "DEAL_PRICE",
    "DEAL_PROFIT",
    "DEAL_COMMISSION",
    "DEAL_SWAP",
    "SL",
    "TP",
    "DEAL_COMMENT",
]

ACCOUNT_INFO_CSV_HEADERS = [
    "ACCOUNT_LOGIN",
    "BROKER_NAME",
    "BROKER_SERVER",
    "CURRENCY",
    "LEVERAGE",
    "ENVIRONMENT",
    "ACCOUNT_MODE",
    "BALANCE",
    "EQUITY",
    "PROFIT",
    "MARGIN",
    "MARGIN_FREE",
    "MARGIN_LEVEL",
    "ACCOUNT_TRADE_ALLOWED",
    "TERMINAL_TRADE_ALLOWED",
    "CAPTURED_AT_UTC",
]

OPEN_POSITIONS_CSV_HEADERS = [
    "TICKET",
    "SYMBOL",
    "DIRECTION",
    "VOLUME",
    "OPEN_PRICE",
    "CURRENT_PRICE",
    "SL",
    "TP",
    "SWAP",
    "COMMISSION",
    "UNREALISED_PROFIT",
    "OPEN_TIME",
    "MAGIC_NUMBER",
    "COMMENT",
]

ORDERS_CSV_HEADERS = [
    "ORDER_TICKET",
    "POSITION_ID",
    "SYMBOL",
    "ORDER_TYPE",
    "ORDER_STATE",
    "VOLUME_INITIAL",
    "VOLUME_CURRENT",
    "PRICE_OPEN",
    "PRICE_CURRENT",
    "SL",
    "TP",
    "TIME_SETUP",
    "TIME_DONE",
    "MAGIC_NUMBER",
    "COMMENT",
]

# Official MetaQuotes MT5 integer enums -> canonical strings
MT5_DEAL_TYPE_MAP: Dict[int, str] = {
    0: "DEAL_TYPE_BUY",
    1: "DEAL_TYPE_SELL",
    2: "DEAL_TYPE_BALANCE",
    3: "DEAL_TYPE_CREDIT",
    4: "DEAL_TYPE_CHARGE",
    5: "DEAL_TYPE_CORRECTION",
    6: "DEAL_TYPE_CREDIT",  # Bonus -> treated as credit balance operation
    7: "DEAL_TYPE_CHARGE",  # Commission -> balance adjustment
    8: "DEAL_TYPE_CHARGE",  # Commission daily
    9: "DEAL_TYPE_CHARGE",  # Commission monthly
    10: "DEAL_TYPE_CHARGE",  # Commission agent daily
    11: "DEAL_TYPE_CHARGE",  # Commission agent monthly
    12: "DEAL_TYPE_BALANCE",  # Interest
    15: "DEAL_TYPE_DIVIDEND",
    16: "DEAL_TYPE_DIVIDEND",
    17: "DEAL_TYPE_TAX",
}

MT5_DEAL_ENTRY_MAP: Dict[int, str] = {
    0: "DEAL_ENTRY_IN",
    1: "DEAL_ENTRY_OUT",
    2: "DEAL_ENTRY_INOUT",
    3: "DEAL_ENTRY_OUT_BY",
}

MT5_ORDER_TYPE_MAP: Dict[int, str] = {
    0: "ORDER_TYPE_BUY",
    1: "ORDER_TYPE_SELL",
    2: "ORDER_TYPE_BUY_LIMIT",
    3: "ORDER_TYPE_SELL_LIMIT",
    4: "ORDER_TYPE_BUY_STOP",
    5: "ORDER_TYPE_SELL_STOP",
    6: "ORDER_TYPE_BUY_STOP_LIMIT",
    7: "ORDER_TYPE_SELL_STOP_LIMIT",
    8: "ORDER_TYPE_CLOSE_BY",
}

MT5_ORDER_STATE_MAP: Dict[int, str] = {
    0: "ORDER_STATE_STARTED",
    1: "ORDER_STATE_PLACED",
    2: "ORDER_STATE_CANCELED",
    3: "ORDER_STATE_PARTIAL",
    4: "ORDER_STATE_FILLED",
    5: "ORDER_STATE_REJECTED",
    6: "ORDER_STATE_EXPIRED",
    7: "ORDER_STATE_REQUEST_ADD",
    8: "ORDER_STATE_REQUEST_MODIFY",
    9: "ORDER_STATE_REQUEST_CANCEL",
}

TRADE_DEAL_TYPES = {"DEAL_TYPE_BUY", "DEAL_TYPE_SELL"}
BALANCE_DEAL_TYPES = {
    "DEAL_TYPE_BALANCE",
    "DEAL_TYPE_CREDIT",
    "DEAL_TYPE_CHARGE",
    "DEAL_TYPE_CORRECTION",
}


@dataclass(frozen=True)
class ExportArtifacts:
    account_dir: Path
    deals_csv: Path
    account_info_csv: Path
    open_positions_csv: Path
    orders_csv: Path
    report_json: Path
    deals_exported: int
    balance_ops_exported: int
    trade_deals_exported: int
    open_positions_exported: int
    orders_exported: int
    highest_deal_ticket: int
    highest_order_ticket: int
    last_deal_server_epoch: int
    warnings: List[str]


def sanitise_csv_text(value: Any) -> str:
    """
    Sanitise text so it never contains delimiters (, ; \\t) or line breaks.
    LedgerFX's existing parseMT5CsvDeals() splits rows directly on commas,
    so removing delimiters guarantees zero column-alignment issues.
    """
    text = str(value or "")
    text = re.sub(r"[\r\n\t,;]+", " ", text)
    text = re.sub(r"\s{2,}", " ", text)
    return text.strip()


def format_mt5_server_time(epoch_seconds: Any) -> str:
    """
    MT5 Python API timestamps represent broker server time as a Unix epoch.
    Format as 'YYYY.MM.DD HH:MM:SS' to match MT5 exports and LedgerFX's parser.
    """
    ts = int(epoch_seconds or 0)
    if ts <= 0:
        return ""
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y.%m.%d %H:%M:%S")


def format_price(value: Any, symbol: str = "") -> str:
    num = float(value or 0.0)
    if num == 0.0:
        return ""
    decimals = 3 if "JPY" in symbol.upper() else 5
    return f"{num:.{decimals}f}"


def format_money(value: Any) -> str:
    num = float(value or 0.0)
    return f"{num:.2f}"


def format_volume(value: Any) -> str:
    num = float(value or 0.0)
    return f"{num:.2f}"


def map_deal_type(raw_type: Any) -> Optional[str]:
    if isinstance(raw_type, str) and raw_type.upper().startswith("DEAL_TYPE_"):
        return raw_type.upper()
    try:
        return MT5_DEAL_TYPE_MAP.get(int(raw_type))
    except (TypeError, ValueError):
        return None


def map_deal_entry(raw_entry: Any) -> str:
    if isinstance(raw_entry, str) and raw_entry.upper().startswith("DEAL_ENTRY_"):
        return raw_entry.upper()
    try:
        return MT5_DEAL_ENTRY_MAP.get(int(raw_entry), "DEAL_ENTRY_IN")
    except (TypeError, ValueError):
        return "DEAL_ENTRY_IN"


def _build_order_sl_tp_lookup(orders: Sequence[Any]) -> Tuple[Dict[int, Tuple[float, float]], Dict[int, Tuple[float, float]]]:
    """
    Build lookup maps for SL/TP from historical orders:
      1) by order_ticket
      2) by position_id (first non-zero SL/TP recorded on the position's orders)
    """
    by_order: Dict[int, Tuple[float, float]] = {}
    by_position: Dict[int, Tuple[float, float]] = {}

    for order in orders:
        o_ticket = int(getattr(order, "ticket", 0) or 0)
        pos_id = int(getattr(order, "position_id", 0) or 0)
        sl = float(getattr(order, "sl", 0.0) or 0.0)
        tp = float(getattr(order, "tp", 0.0) or 0.0)
        if o_ticket > 0 and (sl > 0.0 or tp > 0.0):
            by_order[o_ticket] = (sl, tp)
        if pos_id > 0 and (sl > 0.0 or tp > 0.0):
            prev_sl, prev_tp = by_position.get(pos_id, (0.0, 0.0))
            by_position[pos_id] = (prev_sl or sl, prev_tp or tp)

    return by_order, by_position


def filter_and_deduplicate_deals(
    raw_deals: Sequence[Any],
    mode: str,
    previous_highest_ticket: int,
) -> List[Any]:
    """
    Deduplicate strictly by DEAL_TICKET and apply incremental filtering when mode == 'incremental'.
    In incremental mode, only deals with ticket > previous_highest_ticket are exported,
    preventing duplicate deals while preserving every partial entry/exit ticket.
    """
    unique_by_ticket: Dict[int, Any] = {}
    for deal in raw_deals:
        ticket = int(getattr(deal, "ticket", 0) or 0)
        if ticket <= 0:
            continue
        if mode == "incremental" and previous_highest_ticket > 0 and ticket <= previous_highest_ticket:
            continue
        unique_by_ticket[ticket] = deal

    return sorted(
        unique_by_ticket.values(),
        key=lambda d: (int(getattr(d, "time", 0) or 0), int(getattr(d, "ticket", 0))),
    )


def filter_and_deduplicate_orders(
    raw_orders: Sequence[Any],
    mode: str,
    previous_highest_order_ticket: int,
) -> List[Any]:
    unique_by_ticket: Dict[int, Any] = {}
    for order in raw_orders:
        ticket = int(getattr(order, "ticket", 0) or 0)
        if ticket <= 0:
            continue
        if mode == "incremental" and previous_highest_order_ticket > 0 and ticket <= previous_highest_order_ticket:
            continue
        unique_by_ticket[ticket] = order

    return sorted(
        unique_by_ticket.values(),
        key=lambda o: (
            int(getattr(o, "time_done", 0) or getattr(o, "time_setup", 0) or 0),
            int(getattr(o, "ticket", 0)),
        ),
    )


def allocate_non_overwriting_path(directory: Path, stem: str, suffix: str) -> Path:
    """
    Allocate a unique output path so an existing export file is NEVER silently overwritten.
    """
    directory.mkdir(parents=True, exist_ok=True)
    candidate = directory / f"{stem}{suffix}"
    counter = 1
    while candidate.exists():
        candidate = directory / f"{stem}_{counter:02d}{suffix}"
        counter += 1
    return candidate


def write_csv_safely(path: Path, headers: Sequence[str], rows: Iterable[Sequence[Any]]) -> Path:
    """Write a CSV file atomically via a temporary file; back up if target unexpectedly exists."""
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        backups_dir = path.parent / "backups"
        backups_dir.mkdir(parents=True, exist_ok=True)
        ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%SZ")
        bak = allocate_non_overwriting_path(backups_dir, f"{path.stem}.bak_{ts}", path.suffix)
        shutil.copy2(path, bak)

    tmp_path = path.with_name(f".{path.name}.tmp")
    with tmp_path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.writer(fh, delimiter=",", quoting=csv.QUOTE_MINIMAL, lineterminator="\n")
        writer.writerow(headers)
        for row in rows:
            writer.writerow(row)
    os.replace(tmp_path, path)
    return path


def write_json_safely(path: Path, payload: Dict[str, Any]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        backups_dir = path.parent / "backups"
        backups_dir.mkdir(parents=True, exist_ok=True)
        ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%SZ")
        bak = allocate_non_overwriting_path(backups_dir, f"{path.stem}.bak_{ts}", path.suffix)
        shutil.copy2(path, bak)

    tmp_path = path.with_name(f".{path.name}.tmp")
    tmp_path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(tmp_path, path)
    return path


def build_deals_rows(
    deals: Sequence[Any],
    all_orders_for_enrichment: Sequence[Any],
) -> Tuple[List[List[str]], int, int, int, int, List[str]]:
    """Convert MT5 deals into LedgerFX-compatible CSV rows with SL/TP enrichment from orders."""
    sl_tp_by_order, sl_tp_by_pos = _build_order_sl_tp_lookup(all_orders_for_enrichment)

    rows: List[List[str]] = []
    trade_count = 0
    balance_count = 0
    highest_ticket = 0
    last_epoch = 0
    warnings: List[str] = []

    for deal in deals:
        ticket = int(getattr(deal, "ticket", 0) or 0)
        if ticket <= 0:
            continue
        highest_ticket = max(highest_ticket, ticket)
        deal_epoch = int(getattr(deal, "time", 0) or 0)
        last_epoch = max(last_epoch, deal_epoch)

        deal_type = map_deal_type(getattr(deal, "type", None))
        if deal_type is None:
            warnings.append(f"Skipped unsupported MT5 deal type {getattr(deal, 'type', None)} on ticket #{ticket}.")
            continue

        order_id = int(getattr(deal, "order", 0) or 0)
        position_id = int(getattr(deal, "position_id", 0) or 0)
        symbol = sanitise_csv_text(getattr(deal, "symbol", "")).upper()
        profit = float(getattr(deal, "profit", 0.0) or 0.0)
        commission = float(getattr(deal, "commission", 0.0) or 0.0)
        fee = float(getattr(deal, "fee", 0.0) or 0.0)
        total_commission = commission + fee
        swap = float(getattr(deal, "swap", 0.0) or 0.0)
        volume = float(getattr(deal, "volume", 0.0) or 0.0)
        price = float(getattr(deal, "price", 0.0) or 0.0)
        comment = sanitise_csv_text(getattr(deal, "comment", ""))

        if deal_type in BALANCE_DEAL_TYPES:
            balance_count += 1
            rows.append(
                [
                    str(ticket),
                    str(order_id),
                    str(position_id),
                    format_mt5_server_time(deal_epoch),
                    "",
                    deal_type,
                    "",
                    "0.00",
                    "0.00000",
                    format_money(profit),
                    format_money(total_commission),
                    format_money(swap),
                    "",
                    "",
                    comment or "Balance operation",
                ]
            )
            continue

        if deal_type in TRADE_DEAL_TYPES and not symbol:
            warnings.append(f"Skipped trade deal #{ticket} with empty symbol.")
            continue

        deal_entry = map_deal_entry(getattr(deal, "entry", 0))
        sl_val = float(getattr(deal, "sl", 0.0) or 0.0)
        tp_val = float(getattr(deal, "tp", 0.0) or 0.0)
        if sl_val <= 0.0 and tp_val <= 0.0:
            o_sl, o_tp = sl_tp_by_order.get(order_id, (0.0, 0.0))
            if o_sl > 0.0 or o_tp > 0.0:
                sl_val, tp_val = o_sl, o_tp
            elif position_id in sl_tp_by_pos:
                sl_val, tp_val = sl_tp_by_pos[position_id]

        trade_count += 1
        rows.append(
            [
                str(ticket),
                str(order_id),
                str(position_id),
                format_mt5_server_time(deal_epoch),
                symbol,
                deal_type,
                deal_entry,
                format_volume(volume),
                format_price(price, symbol),
                format_money(profit),
                format_money(total_commission),
                format_money(swap),
                format_price(sl_val, symbol),
                format_price(tp_val, symbol),
                comment,
            ]
        )

    return rows, trade_count, balance_count, highest_ticket, last_epoch, warnings


def build_account_info_rows(snapshot: AccountSnapshot) -> List[List[str]]:
    env_label = "demo" if snapshot.trade_mode == 0 else ("contest" if snapshot.trade_mode == 1 else "live")
    mode_label = "hedging" if snapshot.margin_mode == 2 else "netting"
    return [
        [
            sanitise_csv_text(snapshot.login),
            sanitise_csv_text(snapshot.company),
            sanitise_csv_text(snapshot.server),
            sanitise_csv_text(snapshot.currency),
            str(snapshot.leverage),
            env_label,
            mode_label,
            format_money(snapshot.balance),
            format_money(snapshot.equity),
            format_money(snapshot.profit),
            format_money(snapshot.margin),
            format_money(snapshot.margin_free),
            format_money(snapshot.margin_level),
            "true" if snapshot.trade_allowed else "false",
            "true" if snapshot.terminal_trade_allowed else "false",
            snapshot.captured_at_utc,
        ]
    ]


def build_open_positions_rows(positions: Sequence[Any]) -> List[List[str]]:
    rows: List[List[str]] = []
    for pos in sorted(positions, key=lambda p: int(getattr(p, "ticket", 0) or 0)):
        ticket = int(getattr(pos, "ticket", 0) or 0)
        if ticket <= 0:
            continue
        symbol = sanitise_csv_text(getattr(pos, "symbol", "")).upper()
        p_type = int(getattr(pos, "type", 0) or 0)
        direction = "BUY" if p_type == 0 else "SELL"
        rows.append(
            [
                str(ticket),
                symbol,
                direction,
                format_volume(getattr(pos, "volume", 0.0)),
                format_price(getattr(pos, "price_open", 0.0), symbol),
                format_price(getattr(pos, "price_current", 0.0), symbol),
                format_price(getattr(pos, "sl", 0.0), symbol),
                format_price(getattr(pos, "tp", 0.0), symbol),
                format_money(getattr(pos, "swap", 0.0)),
                format_money(getattr(pos, "commission", 0.0)),
                format_money(getattr(pos, "profit", 0.0)),
                format_mt5_server_time(getattr(pos, "time", 0)),
                str(int(getattr(pos, "magic", 0) or 0)),
                sanitise_csv_text(getattr(pos, "comment", "")),
            ]
        )
    return rows


def build_orders_rows(orders: Sequence[Any]) -> Tuple[List[List[str]], int]:
    rows: List[List[str]] = []
    highest_order_ticket = 0
    for order in orders:
        ticket = int(getattr(order, "ticket", 0) or 0)
        if ticket <= 0:
            continue
        highest_order_ticket = max(highest_order_ticket, ticket)
        symbol = sanitise_csv_text(getattr(order, "symbol", "")).upper()
        o_type = MT5_ORDER_TYPE_MAP.get(int(getattr(order, "type", 0) or 0), f"ORDER_TYPE_{getattr(order, 'type', 0)}")
        o_state = MT5_ORDER_STATE_MAP.get(int(getattr(order, "state", 0) or 0), f"ORDER_STATE_{getattr(order, 'state', 0)}")
        rows.append(
            [
                str(ticket),
                str(int(getattr(order, "position_id", 0) or 0)),
                symbol,
                o_type,
                o_state,
                format_volume(getattr(order, "volume_initial", 0.0)),
                format_volume(getattr(order, "volume_current", 0.0)),
                format_price(getattr(order, "price_open", 0.0), symbol),
                format_price(getattr(order, "price_current", 0.0), symbol),
                format_price(getattr(order, "sl", 0.0), symbol),
                format_price(getattr(order, "tp", 0.0), symbol),
                format_mt5_server_time(getattr(order, "time_setup", 0)),
                format_mt5_server_time(getattr(order, "time_done", 0)),
                str(int(getattr(order, "magic", 0) or 0)),
                sanitise_csv_text(getattr(order, "comment", "")),
            ]
        )
    return rows, highest_order_ticket


def export_collection_bundle(
    output_dir: Path,
    namespace: AccountNamespace,
    snapshot: AccountSnapshot,
    raw_deals: Sequence[Any],
    raw_orders: Sequence[Any],
    open_positions: Sequence[Any],
    mode: str,
    previous_highest_deal_ticket: int,
    previous_highest_order_ticket: int,
    now_utc: Optional[datetime] = None,
    investor_session_confirmation_method: str = "interactive",
) -> ExportArtifacts:
    """
    Export deals, account info, open positions, orders, and a collection summary JSON
    under exports/<server>__<login>/ using unique non-overwriting timestamped filenames.
    """
    ts_dt = now_utc or datetime.now(timezone.utc)
    ts_label = ts_dt.strftime("%Y%m%d_%H%M%SZ")
    account_dir = output_dir / namespace.folder_name
    prefix = namespace.file_prefix

    filtered_deals = filter_and_deduplicate_deals(raw_deals, mode, previous_highest_deal_ticket)
    filtered_orders = filter_and_deduplicate_orders(raw_orders, mode, previous_highest_order_ticket)

    deal_rows, trade_count, balance_count, max_deal_ticket, last_epoch, warnings = build_deals_rows(
        filtered_deals,
        all_orders_for_enrichment=raw_orders,
    )
    account_rows = build_account_info_rows(snapshot)
    position_rows = build_open_positions_rows(open_positions)
    order_rows, max_order_ticket = build_orders_rows(filtered_orders)

    deals_csv = allocate_non_overwriting_path(account_dir, f"deals_{prefix}_{mode}_{ts_label}", ".csv")
    account_csv = allocate_non_overwriting_path(account_dir, f"account_info_{prefix}_{ts_label}", ".csv")
    positions_csv = allocate_non_overwriting_path(account_dir, f"open_positions_{prefix}_{ts_label}", ".csv")
    orders_csv = allocate_non_overwriting_path(account_dir, f"orders_{prefix}_{mode}_{ts_label}", ".csv")
    report_json = allocate_non_overwriting_path(account_dir, f"report_{prefix}_{mode}_{ts_label}", ".json")

    write_csv_safely(deals_csv, DEALS_CSV_HEADERS, deal_rows)
    write_csv_safely(account_csv, ACCOUNT_INFO_CSV_HEADERS, account_rows)
    write_csv_safely(positions_csv, OPEN_POSITIONS_CSV_HEADERS, position_rows)
    write_csv_safely(orders_csv, ORDERS_CSV_HEADERS, order_rows)

    highest_deal_ticket = max(previous_highest_deal_ticket, max_deal_ticket)
    highest_order_ticket = max(previous_highest_order_ticket, max_order_ticket)

    report_payload = {
        "status": "success",
        "collectedAtUtc": ts_dt.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "mode": mode,
        "accountLogin": snapshot.login,
        "brokerName": snapshot.company,
        "brokerServer": snapshot.server,
        "currency": snapshot.currency,
        "accountTradeAllowedFlag": snapshot.trade_allowed,
        "terminalTradeAllowedFlag": snapshot.terminal_trade_allowed,
        "investorSessionConfirmedVia": investor_session_confirmation_method,
        "readOnlyNote": "No MT5 password was requested, stored, transmitted, or logged. Local CSV export only.",
        "counts": {
            "dealsExported": len(deal_rows),
            "tradeDealsExported": trade_count,
            "balanceOperationsExported": balance_count,
            "openPositionsExported": len(position_rows),
            "ordersExported": len(order_rows),
        },
        "checkpoints": {
            "previousHighestDealTicket": previous_highest_deal_ticket,
            "newHighestDealTicket": highest_deal_ticket,
            "previousHighestOrderTicket": previous_highest_order_ticket,
            "newHighestOrderTicket": highest_order_ticket,
        },
        "files": {
            "dealsCsvForLedgerFX": str(deals_csv),
            "accountInfoCsv": str(account_csv),
            "openPositionsCsv": str(positions_csv),
            "ordersCsv": str(orders_csv),
        },
        "warnings": warnings,
    }
    write_json_safely(report_json, report_payload)

    return ExportArtifacts(
        account_dir=account_dir,
        deals_csv=deals_csv,
        account_info_csv=account_csv,
        open_positions_csv=positions_csv,
        orders_csv=orders_csv,
        report_json=report_json,
        deals_exported=len(deal_rows),
        balance_ops_exported=balance_count,
        trade_deals_exported=trade_count,
        open_positions_exported=len(position_rows),
        orders_exported=len(order_rows),
        highest_deal_ticket=highest_deal_ticket,
        highest_order_ticket=highest_order_ticket,
        last_deal_server_epoch=last_epoch,
        warnings=warnings,
    )
