"""
Strictly read-only wrapper around the official MetaQuotes MetaTrader5 Python package.

Security & compliance invariants:
- Connects ONLY to the already running and logged-in MT5 desktop terminal (never accepts passwords).
- Invokes ONLY read-only query functions:
    initialize, shutdown, last_error, terminal_info, account_info,
    positions_get, history_deals_get, history_orders_get.
- Never performs trading, order placement, order modification, account management, or network calls.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, List, Optional, Protocol, Sequence

from .config import build_date_chunks


class MT5CollectorError(RuntimeError):
    """Base error for read-only MT5 collection issues."""


class MT5UnavailableError(MT5CollectorError):
    """Raised when the official MetaTrader5 Python package cannot be imported."""


class MT5DisconnectedError(MT5CollectorError):
    """Raised when the MT5 desktop terminal is not running or cannot connect."""


class MT5InvalidAccountError(MT5CollectorError):
    """Raised when no valid MT5 account session is logged in."""


class MT5HistoryUnavailableError(MT5CollectorError):
    """Raised when the broker or terminal returns unavailable history."""


@dataclass(frozen=True)
class AccountSnapshot:
    login: str
    server: str
    company: str
    currency: str
    leverage: int
    trade_mode: int
    margin_mode: int
    balance: float
    equity: float
    profit: float
    margin: float
    margin_free: float
    margin_level: float
    trade_allowed: bool
    terminal_trade_allowed: bool
    connected: bool
    captured_at_utc: str


class MT5BackendProtocol(Protocol):
    """Protocol for dependency-injected testing without touching a live MT5 terminal."""

    def initialize(self, path: Optional[str] = None) -> bool: ...
    def shutdown(self) -> None: ...
    def last_error(self) -> Any: ...
    def terminal_info(self) -> Any: ...
    def account_info(self) -> Any: ...
    def positions_get(self) -> Any: ...
    def history_deals_get(self, date_from: datetime, date_to: datetime) -> Any: ...
    def history_orders_get(self, date_from: datetime, date_to: datetime) -> Any: ...


class ReadOnlyMT5Client:
    """Read-only facade over the official MetaTrader5 Python integration."""

    def __init__(
        self,
        terminal_path: Optional[str] = None,
        backend: Optional[MT5BackendProtocol] = None,
    ) -> None:
        self._terminal_path = terminal_path
        self._backend = backend
        self._connected = False

    def _load_backend(self) -> MT5BackendProtocol:
        if self._backend is not None:
            return self._backend
        try:
            import MetaTrader5 as mt5  # type: ignore[import-not-found]
        except ImportError as exc:
            raise MT5UnavailableError(
                "The official 'MetaTrader5' Python package is not installed. "
                "Install it on Windows with: pip install -r requirements.txt"
            ) from exc
        self._backend = mt5
        return mt5

    def connect(self) -> None:
        """Attach to the already-open MT5 desktop terminal without passing any credentials."""
        mt5 = self._load_backend()
        if self._terminal_path:
            kwargs: dict = {"path": self._terminal_path}
            # A terminal started with /portable keeps its data beside the exe; the Python bridge must be
            # told, otherwise it looks in %APPDATA% and fails with IPC timeout (-10005).
            if os.environ.get("MT5_PORTABLE") == "1":
                kwargs["portable"] = True
            ok = mt5.initialize(**kwargs)
        else:
            ok = mt5.initialize()
        if not ok:
            err = mt5.last_error()
            raise MT5DisconnectedError(
                f"Unable to attach to MetaTrader 5 desktop terminal (MT5 last_error={err}). "
                "Ensure MetaTrader 5 is installed, running, and logged in with your Investor Password."
            )
        self._connected = True

    def disconnect(self) -> None:
        if self._connected and self._backend is not None:
            try:
                self._backend.shutdown()
            finally:
                self._connected = False

    def __enter__(self) -> "ReadOnlyMT5Client":
        self.connect()
        return self

    def __exit__(self, _exc_type: Any, _exc: Any, _tb: Any) -> None:
        self.disconnect()

    def get_account_snapshot(self) -> AccountSnapshot:
        """Read current account and terminal status (read-only)."""
        mt5 = self._load_backend()
        t_info = mt5.terminal_info()
        if t_info is None:
            err = mt5.last_error()
            raise MT5DisconnectedError(
                f"MetaTrader 5 terminal info is unavailable (MT5 last_error={err})."
            )

        is_connected = bool(getattr(t_info, "connected", False))
        if not is_connected:
            raise MT5DisconnectedError(
                "MetaTrader 5 terminal is open but disconnected from the broker server. "
                "Check your internet connection and broker server login in MT5."
            )

        acc = mt5.account_info()
        if acc is None or not getattr(acc, "login", 0):
            err = mt5.last_error()
            raise MT5InvalidAccountError(
                f"No active MT5 account session found (MT5 last_error={err}). "
                "Log into your account in MT5 using your Investor Password and try again."
            )

        server = str(getattr(acc, "server", "") or "").strip()
        if not server:
            raise MT5InvalidAccountError(
                "Active MT5 session is missing a broker server name. Verify your MT5 login session."
            )

        return AccountSnapshot(
            login=str(getattr(acc, "login")),
            server=server,
            company=str(getattr(acc, "company", "") or "MetaTrader 5 Broker").strip(),
            currency=str(getattr(acc, "currency", "USD") or "USD").strip().upper(),
            leverage=int(getattr(acc, "leverage", 0) or 0),
            trade_mode=int(getattr(acc, "trade_mode", 0) or 0),
            margin_mode=int(getattr(acc, "margin_mode", 0) or 0),
            balance=float(getattr(acc, "balance", 0.0) or 0.0),
            equity=float(getattr(acc, "equity", 0.0) or 0.0),
            profit=float(getattr(acc, "profit", 0.0) or 0.0),
            margin=float(getattr(acc, "margin", 0.0) or 0.0),
            margin_free=float(getattr(acc, "margin_free", 0.0) or 0.0),
            margin_level=float(getattr(acc, "margin_level", 0.0) or 0.0),
            trade_allowed=bool(getattr(acc, "trade_allowed", False)),
            terminal_trade_allowed=bool(getattr(t_info, "trade_allowed", False)),
            connected=is_connected,
            captured_at_utc=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        )

    def get_open_positions(self) -> List[Any]:
        """Read currently open MT5 positions (read-only)."""
        mt5 = self._load_backend()
        positions = mt5.positions_get()
        if positions is None:
            err = mt5.last_error()
            # MT5 returns None when error occurs; empty tuple () when 0 positions exist.
            if err and isinstance(err, tuple) and err[0] not in (0, 1):
                raise MT5HistoryUnavailableError(
                    f"Unable to read open positions from MT5 (MT5 last_error={err})."
                )
            return []
        return list(positions)

    def get_history_deals(
        self,
        date_from: datetime,
        date_to: datetime,
        chunk_days: int = 90,
    ) -> List[Any]:
        """Fetch historical deals in date chunks and deduplicate strictly by deal ticket."""
        mt5 = self._load_backend()
        seen: dict[int, Any] = {}
        chunks = build_date_chunks(date_from, date_to, chunk_days=chunk_days)

        for chunk_start, chunk_end in chunks:
            deals = mt5.history_deals_get(chunk_start, chunk_end)
            if deals is None:
                err = mt5.last_error()
                raise MT5HistoryUnavailableError(
                    f"MT5 returned unavailable deal history for window "
                    f"{chunk_start.strftime('%Y-%m-%d')} to {chunk_end.strftime('%Y-%m-%d')} "
                    f"(MT5 last_error={err}). Ensure 'Account History -> All History' is enabled in MT5."
                )
            for deal in deals:
                ticket = int(getattr(deal, "ticket", 0) or 0)
                if ticket > 0:
                    seen[ticket] = deal

        return sorted(seen.values(), key=lambda d: (int(getattr(d, "time", 0) or 0), int(getattr(d, "ticket", 0))))

    def get_orders_for_positions(self, position_ids: Sequence[int], limit: int = 500) -> List[Any]:
        """
        Read-only lookup of the orders belonging to specific positions (MT5: history_orders_get(position=...)).
        Used to recover the ORIGINAL SL/TP of positions that were opened before the fetch window, so their
        R-multiple stays correct on incremental runs. Silently returns [] if the backend has no such lookup.
        """
        mt5 = self._load_backend()
        fetch = getattr(mt5, "history_orders_get", None)
        if fetch is None:
            return []
        found: dict[int, Any] = {}
        for pos_id in sorted({int(p) for p in position_ids if int(p) > 0})[:limit]:
            try:
                orders = fetch(position=pos_id)
            except TypeError:
                return []
            if orders is None:
                continue
            for order in orders:
                ticket = int(getattr(order, "ticket", 0) or 0)
                if ticket > 0:
                    found[ticket] = order
        return list(found.values())

    def get_history_orders(
        self,
        date_from: datetime,
        date_to: datetime,
        chunk_days: int = 90,
    ) -> List[Any]:
        """Fetch historical orders in date chunks (used for order history CSV and SL/TP enrichment)."""
        mt5 = self._load_backend()
        seen: dict[int, Any] = {}
        chunks = build_date_chunks(date_from, date_to, chunk_days=chunk_days)

        for chunk_start, chunk_end in chunks:
            orders = mt5.history_orders_get(chunk_start, chunk_end)
            if orders is None:
                err = mt5.last_error()
                raise MT5HistoryUnavailableError(
                    f"MT5 returned unavailable order history for window "
                    f"{chunk_start.strftime('%Y-%m-%d')} to {chunk_end.strftime('%Y-%m-%d')} "
                    f"(MT5 last_error={err})."
                )
            for order in orders:
                ticket = int(getattr(order, "ticket", 0) or 0)
                if ticket > 0:
                    seen[ticket] = order

        return sorted(
            seen.values(),
            key=lambda o: (int(getattr(o, "time_done", 0) or getattr(o, "time_setup", 0) or 0), int(getattr(o, "ticket", 0))),
        )
