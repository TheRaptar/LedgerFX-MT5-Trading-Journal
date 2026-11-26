"""
Builds the JSON payload accepted by LedgerFX's POST /api/ingest/<accountId> endpoint.

Pure data mapping: no network, no files, no passwords. Reuses the exporter's enum maps so the CSV export
and the push payload can never disagree about how an MT5 deal is interpreted.
"""

from __future__ import annotations

from typing import Any, Dict, List, Sequence, Set, Tuple

from .exporter import (
    BALANCE_DEAL_TYPES,
    TRADE_DEAL_TYPES,
    _build_order_sl_tp_lookup,
    format_mt5_server_time,
    map_deal_entry,
    map_deal_type,
)
from .mt5_client import AccountSnapshot

MAX_ROWS_PER_REQUEST = 2000
MAX_TEXT = 200


def _text(value: Any) -> str:
    return str(value or "").strip()[:MAX_TEXT]


def build_account_info(snapshot: AccountSnapshot) -> Dict[str, Any]:
    """Identity + broker-reported figures. The server uses login/server to refuse mismatched data and
    tradeAllowed to refuse non-investor (trading-enabled) sessions."""
    return {
        "login": snapshot.login,
        "server": snapshot.server,
        "company": snapshot.company,
        "currency": snapshot.currency,
        "leverage": snapshot.leverage,
        "balance": round(snapshot.balance, 2),
        "equity": round(snapshot.equity, 2),
        "tradeAllowed": bool(snapshot.trade_allowed),
        "terminalTradeAllowed": bool(snapshot.terminal_trade_allowed),
        "capturedAtUtc": snapshot.captured_at_utc,
    }


def dedupe_deals(raw_deals: Sequence[Any]) -> List[Any]:
    """Deduplicate by deal ticket only. No ticket-based skipping: the server upserts, which also corrects
    deals the broker amended after first publication (late commission/swap)."""
    unique: Dict[int, Any] = {}
    for deal in raw_deals:
        ticket = int(getattr(deal, "ticket", 0) or 0)
        if ticket > 0:
            unique[ticket] = deal
    return sorted(
        unique.values(),
        key=lambda d: (int(getattr(d, "time", 0) or 0), int(getattr(d, "ticket", 0))),
    )


def positions_missing_entry(raw_deals: Sequence[Any]) -> List[int]:
    """Position ids that have an exit deal in this batch but no entry deal (opened before the fetch window).
    Their entry order is needed to recover the original SL/TP for R-multiple calculation."""
    has_entry: Set[int] = set()
    exit_only: Set[int] = set()
    for deal in raw_deals:
        pos = int(getattr(deal, "position_id", 0) or 0)
        if pos <= 0:
            continue
        entry = map_deal_entry(getattr(deal, "entry", 0))
        if entry in ("DEAL_ENTRY_IN", "DEAL_ENTRY_INOUT"):
            has_entry.add(pos)
        else:
            exit_only.add(pos)
    return sorted(exit_only - has_entry)


def collection_stats(raw_deals: Sequence[Any], raw_orders: Sequence[Any]) -> Tuple[int, int, int]:
    """(highest deal ticket, highest order ticket, latest deal epoch) for checkpointing when no CSV is exported."""
    highest_deal = max((int(getattr(d, "ticket", 0) or 0) for d in raw_deals), default=0)
    highest_order = max((int(getattr(o, "ticket", 0) or 0) for o in raw_orders), default=0)
    last_epoch = max((int(getattr(d, "time", 0) or 0) for d in raw_deals), default=0)
    return highest_deal, highest_order, last_epoch


def build_deal_rows(
    raw_deals: Sequence[Any],
    orders_for_enrichment: Sequence[Any],
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], List[str]]:
    """Returns (trade deal rows, balance operation rows, warnings)."""
    by_order, by_position = _build_order_sl_tp_lookup(orders_for_enrichment)

    deals: List[Dict[str, Any]] = []
    balance_ops: List[Dict[str, Any]] = []
    warnings: List[str] = []

    for deal in dedupe_deals(raw_deals):
        ticket = int(getattr(deal, "ticket", 0) or 0)
        deal_type = map_deal_type(getattr(deal, "type", None))
        if deal_type is None:
            warnings.append(f"Skipped unsupported MT5 deal type {getattr(deal, 'type', None)} on ticket #{ticket}.")
            continue

        epoch = int(getattr(deal, "time", 0) or 0)
        server_time = format_mt5_server_time(epoch)
        if not server_time:
            warnings.append(f"Skipped deal #{ticket}: missing timestamp.")
            continue

        profit = float(getattr(deal, "profit", 0.0) or 0.0)
        commission = float(getattr(deal, "commission", 0.0) or 0.0) + float(getattr(deal, "fee", 0.0) or 0.0)
        swap = float(getattr(deal, "swap", 0.0) or 0.0)

        if deal_type in BALANCE_DEAL_TYPES:
            balance_ops.append(
                {
                    "ticket": ticket,
                    "dealType": deal_type,
                    "profit": profit,
                    "commission": commission,
                    "swap": swap,
                    "serverTime": server_time,
                    "comment": _text(getattr(deal, "comment", "")) or "Balance operation",
                }
            )
            continue

        if deal_type not in TRADE_DEAL_TYPES:
            warnings.append(f"Skipped {deal_type} deal #{ticket} (not part of trade P/L or deposits).")
            continue

        symbol = _text(getattr(deal, "symbol", "")).upper()
        position_id = int(getattr(deal, "position_id", 0) or 0)
        if not symbol or position_id <= 0:
            warnings.append(f"Skipped trade deal #{ticket}: missing symbol or position id.")
            continue

        order_id = int(getattr(deal, "order", 0) or 0)
        sl = float(getattr(deal, "sl", 0.0) or 0.0)
        tp = float(getattr(deal, "tp", 0.0) or 0.0)
        if sl <= 0.0 and tp <= 0.0:
            if order_id in by_order:
                sl, tp = by_order[order_id]
            elif position_id in by_position:
                sl, tp = by_position[position_id]

        deals.append(
            {
                "ticket": ticket,
                "orderId": order_id,
                "positionId": position_id,
                "symbol": symbol,
                "dealType": deal_type,
                "dealEntry": map_deal_entry(getattr(deal, "entry", 0)),
                "volume": float(getattr(deal, "volume", 0.0) or 0.0),
                "price": float(getattr(deal, "price", 0.0) or 0.0),
                "profit": profit,
                "commission": commission,
                "swap": swap,
                "sl": sl,
                "tp": tp,
                "serverTime": server_time,
                "magicNumber": int(getattr(deal, "magic", 0) or 0),
                "comment": _text(getattr(deal, "comment", "")),
            }
        )

    return deals, balance_ops, warnings


def build_open_position_rows(positions: Sequence[Any]) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    for pos in sorted(positions, key=lambda p: int(getattr(p, "ticket", 0) or 0)):
        ticket = int(getattr(pos, "ticket", 0) or 0)
        symbol = _text(getattr(pos, "symbol", "")).upper()
        server_time = format_mt5_server_time(getattr(pos, "time", 0))
        if ticket <= 0 or not symbol or not server_time:
            continue
        rows.append(
            {
                "ticket": ticket,
                "symbol": symbol,
                "direction": "BUY" if int(getattr(pos, "type", 0) or 0) == 0 else "SELL",
                "volume": float(getattr(pos, "volume", 0.0) or 0.0),
                "openPrice": float(getattr(pos, "price_open", 0.0) or 0.0),
                "currentPrice": float(getattr(pos, "price_current", 0.0) or 0.0),
                "sl": float(getattr(pos, "sl", 0.0) or 0.0),
                "tp": float(getattr(pos, "tp", 0.0) or 0.0),
                "swap": float(getattr(pos, "swap", 0.0) or 0.0),
                "commission": float(getattr(pos, "commission", 0.0) or 0.0),
                "profit": float(getattr(pos, "profit", 0.0) or 0.0),
                "serverTime": server_time,
                "magicNumber": int(getattr(pos, "magic", 0) or 0),
                "comment": _text(getattr(pos, "comment", "")),
            }
        )
    return rows


def chunk_rows(
    deals: Sequence[Dict[str, Any]],
    balance_ops: Sequence[Dict[str, Any]],
    max_rows: int = MAX_ROWS_PER_REQUEST,
) -> List[Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]]:
    """Split rows into request-sized batches. Always returns at least one (possibly empty) batch so the
    final request can still refresh open positions and the broker-reported balance."""
    max_rows = max(1, int(max_rows))
    chunks: List[Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]] = []
    ops = list(balance_ops)
    rest = list(deals)

    while ops or rest:
        room = max_rows
        ops_part = ops[:room]
        ops = ops[len(ops_part):]
        room -= len(ops_part)
        deals_part = rest[:room]
        rest = rest[len(deals_part):]
        chunks.append((deals_part, ops_part))

    return chunks or [([], [])]
