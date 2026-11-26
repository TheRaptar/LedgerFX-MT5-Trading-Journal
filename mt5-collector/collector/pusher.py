"""
Optional, opt-in HTTPS push of collected MT5 history to the user's own LedgerFX server.

This is the ONLY collector module that touches the network, and it only ever talks to the single URL the
operator configured. Security properties:
- The MT5 password is never seen here (MT5 itself holds the Investor-password session).
- The LedgerFX ingest token is read from an environment variable or a local file, never from argv (which
  would be visible in process listings) and is never printed or written to logs.
- Plain HTTP is refused except for loopback addresses (local development).
- Requests are idempotent server-side, so retrying or re-running can never create duplicates.
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence
from urllib.parse import urlparse

from .payload import MAX_ROWS_PER_REQUEST, chunk_rows

LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1"}
DEFAULT_TOKEN_ENV = "LEDGERFX_INGEST_TOKEN"
USER_AGENT = "ledgerfx-mt5-collector/2"


class PushError(RuntimeError):
    """Raised when LedgerFX could not be reached or refused the data. Never contains the token."""


@dataclass
class PushSummary:
    requests: int = 0
    deals_inserted: int = 0
    deals_updated: int = 0
    deals_unchanged: int = 0
    deals_rejected: int = 0
    balance_ops_inserted: int = 0
    open_positions: Optional[int] = None
    rejections: List[str] = field(default_factory=list)
    notice: str = ""
    reconciliation: Optional[Dict[str, float]] = None


def validate_push_url(url: str) -> str:
    parsed = urlparse((url or "").strip())
    if parsed.scheme not in ("https", "http") or not parsed.hostname:
        raise ValueError("--push-url must be a full URL such as https://your-host/api/ingest/<accountId>.")
    if parsed.scheme == "http" and parsed.hostname.lower() not in LOOPBACK_HOSTS:
        raise ValueError(
            "Refusing to send data over plain HTTP to a remote host. Use an https:// URL "
            "(plain http is only allowed for localhost during development)."
        )
    if "/api/ingest/" not in parsed.path:
        raise ValueError("--push-url must point at LedgerFX's ingest endpoint: .../api/ingest/<accountId>.")
    return url.strip()


def read_ingest_token(env_var: str = DEFAULT_TOKEN_ENV, token_file: Optional[Path] = None) -> str:
    """Token comes from a token file or an environment variable only (never a command-line argument)."""
    token = ""
    if token_file is not None:
        try:
            token = Path(token_file).read_text(encoding="utf-8").strip()
        except OSError as exc:
            raise PushError(f"Unable to read the ingest token file ({exc.__class__.__name__}).") from exc
    else:
        token = os.environ.get(env_var, "").strip()
    if not token:
        raise PushError(
            f"No ingest token found. Set the {env_var} environment variable (or pass --token-file) "
            "to the token generated in LedgerFX → Accounts → Collector token."
        )
    return token


def post_json(
    url: str,
    token: str,
    payload: Dict[str, Any],
    *,
    timeout: float = 120.0,
    retries: int = 3,
    sleep: Callable[[float], None] = time.sleep,
) -> Dict[str, Any]:
    """POST one JSON batch. Retries only transient failures (network errors, 429, 5xx); 4xx is final."""
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    last_error = "unknown error"

    for attempt in range(1, max(1, retries) + 1):
        request = urllib.request.Request(
            url,
            data=body,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {token}",
                "User-Agent": USER_AGENT,
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310 - scheme validated above
                return json.loads(response.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError as exc:
            detail = ""
            try:
                detail = json.loads(exc.read().decode("utf-8")).get("error", "")
            except Exception:  # noqa: BLE001 - best-effort error text only
                detail = ""
            last_error = f"HTTP {exc.code}" + (f": {detail}" if detail else "")
            if exc.code not in (429, 500, 502, 503, 504):
                raise PushError(f"LedgerFX refused the data ({last_error}).") from None
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            reason = getattr(exc, "reason", exc)
            last_error = f"network error ({reason.__class__.__name__})"

        if attempt < retries:
            sleep(min(30.0, 2.0 ** attempt))

    raise PushError(f"LedgerFX could not be reached after {retries} attempts ({last_error}).")


def push_in_chunks(
    url: str,
    token: str,
    account_info: Dict[str, Any],
    deal_rows: Sequence[Dict[str, Any]],
    balance_rows: Sequence[Dict[str, Any]],
    open_positions: Sequence[Dict[str, Any]],
    *,
    max_rows: int = MAX_ROWS_PER_REQUEST,
    sender: Callable[..., Dict[str, Any]] = post_json,
) -> PushSummary:
    """Send history in batches. Open positions go with the LAST batch only (they replace the stored set).
    Any failure raises PushError; because the server upserts, simply re-running is always safe."""
    summary = PushSummary()
    chunks = chunk_rows(deal_rows, balance_rows, max_rows)

    for index, (deals_part, ops_part) in enumerate(chunks):
        is_last = index == len(chunks) - 1
        payload: Dict[str, Any] = {
            "accountInfo": account_info,
            "deals": deals_part,
            "balanceOperations": ops_part,
        }
        if is_last:
            payload["openPositions"] = list(open_positions)

        result = sender(url, token, payload)
        summary.requests += 1

        deals = result.get("deals", {})
        ops = result.get("balanceOperations", {})
        summary.deals_inserted += int(deals.get("inserted", 0))
        summary.deals_updated += int(deals.get("updated", 0))
        summary.deals_unchanged += int(deals.get("unchanged", 0))
        summary.deals_rejected += int(deals.get("rejected", 0))
        summary.balance_ops_inserted += int(ops.get("inserted", 0))
        for note in result.get("rejections", []) or []:
            if len(summary.rejections) < 20:
                summary.rejections.append(str(note))
        if is_last:
            summary.open_positions = result.get("openPositions")
            summary.notice = str(result.get("notice", ""))
            summary.reconciliation = result.get("reconciliation")

    return summary
