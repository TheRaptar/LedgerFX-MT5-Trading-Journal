# LedgerFX — Standalone Periodic MT5 Data Collector (Windows)

A standalone, strictly read-only Windows Python collector that reads account details, open positions, historical deals, and historical orders from your **already running MetaTrader 5 desktop terminal** via the official MetaQuotes `MetaTrader5` Python package, and exports CSV files locally for direct import into LedgerFX.

---

## Security & Scope Guarantees

- **Zero Password Handling:** Never prompts for, stores, transmits, or logs your MT5 Master Password or Investor Password. It attaches solely to the currently signed-in MT5 desktop session via `mt5.initialize()`.
- **Manual Session Verification Gate:** Before reading real account data, the collector prints your detected Account Login, Broker Server, Currency, and `trade_allowed` status, warns that `trade_allowed` alone does **not** guarantee Investor Password access, and requires you to type `YES` to confirm.
- **Strictly Read-Only:** Only calls `initialize`, `shutdown`, `last_error`, `terminal_info`, `account_info`, `positions_get`, `history_deals_get`, and `history_orders_get`. Contains zero trading, order placement, modification, copying, or EA logic.
- **100% Local Only:** Makes zero external network requests, cloud uploads, or automatic transmissions.
- **Strict Account/Server Separation:** Exports and checkpoints are isolated under `exports/<broker_server>__<account_login>/` and `state/<broker_server>__<account_login>/`.
- **Non-Destructive Writes:** Every export uses a unique timestamped filename (never silently overwriting previous exports), and every checkpoint update first copies the previous `checkpoint.json` into `state/<broker_server>__<account_login>/backups/`.

---

## Prerequisites (Windows)

1. **Windows 10 / 11 (64-bit)** with the **MetaTrader 5 Desktop Terminal** installed.
2. **Python 3.10+ (64-bit)** installed (`python --version`).
3. **Log into MT5 with your Read-Only Investor Password:**
   - Open MetaTrader 5 on Windows.
   - Go to **File → Login to Trade Account**.
   - Enter your account login, your **read-only Investor Password** (never your Master trading password), and your broker server (e.g. FundingPips server name).
   - Open the **Toolbox → History** tab, right-click inside History, and select **All History** so MT5 loads full broker history locally.

---

## Installation (Windows PowerShell or Command Prompt)

From inside the `mt5-collector` folder:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

*(If using Command Prompt `cmd.exe`, activate with `.venv\Scripts\activate.bat` instead.)*

---

## Running the Collector

### 1. First Local Collection (Full Historical Export)

Run a full historical pull on your first collection to establish your local checkpoint:

```powershell
.\run_collector.bat --mode full
```

Review the session verification banner, confirm inside MetaTrader 5 that you are signed in with your **Investor Password**, and type `YES` when prompted.

### 2. Periodic Incremental Collection (New Deals Only)

Subsequent runs pull only deals with a ticket higher than your saved checkpoint (with a 3-day safety overlap deduplicated by `DEAL_TICKET`):

```powershell
.\run_collector.bat --mode incremental
```

### 3. Useful Optional Flags

- Specify a custom MT5 installation path (if you run multiple MT5 terminals):
  ```powershell
  .\run_collector.bat --mode full --terminal-path "C:\Program Files\MetaTrader 5\terminal64.exe"
  ```
- Export a specific date range:
  ```powershell
  .\run_collector.bat --mode full --from-date 2026-01-01 --to-date 2026-11-21
  ```
- Regenerate synthetic sample files (no MT5 connection):
  ```powershell
  python collect_mt5.py --generate-sample
  ```

---

## Importing Exported Deals into LedgerFX

1. Open your **LedgerFX** web portal and go to the **Accounts** tab.
2. Click **Import CSV** on your linked account card.
3. Upload the exported file listed as `LedgerFX Deals CSV` in the collector report:
   `mt5-collector\exports\<broker_server>__<account_login>\deals_<broker_server>_<account_login>_<mode>_<timestamp>.csv`
4. Click **Import Deals (Duplicate-Safe)**. LedgerFX automatically skips duplicate deal tickets, groups partial entries and partial exits by `DEAL_POSITION_ID`, calculates weighted entry/exit prices and R-multiples (using the SL/TP enriched from order history), and preserves your existing journal notes.

---

## Optional: Periodic Local Runs via Windows Task Scheduler

If you want Windows to run incremental exports periodically while your MT5 desktop terminal is open in an Investor Password session:

1. Verify manually first that MT5 is signed in with your **read-only Investor Password** (`account.trade_allowed` is `False`).
2. Open **Task Scheduler → Create Basic Task**.
3. Set your preferred trigger (e.g. Daily or every 4 hours while logged in).
4. Set Action to **Start a program**:
   - **Program/script:** `C:\path\to\mt5-collector\run_collector.bat`
   - **Add arguments:** `--mode incremental --confirm-investor-session`
   - **Start in:** `C:\path\to\mt5-collector`
5. Note: `--confirm-investor-session` will still automatically **abort** if MT5 reports `account.trade_allowed = True`.

---

## Running Automated Tests (Synthetic Data Only)

These tests use 100% synthetic data and never connect to MetaTrader 5:

```powershell
# Python unit & security guardrail tests
python -m unittest discover -s tests -v

# LedgerFX CSV importer compatibility test (from repository root)
npx tsx mt5-collector/tests/verify_ledgerfx_import.ts
```

## Push straight into LedgerFX (recommended)

Instead of exporting CSVs by hand, the collector can send the history directly to your own LedgerFX server. No MT5 password is involved: you sign in to MT5 with the Investor password inside the terminal, and the collector authenticates to LedgerFX with a revocable per-account **ingest token**.

1. In LedgerFX → Accounts, link the account with connection type **Windows Read-Only Collector**, and pick the broker clock (`MT5/EET-US-DST` is right for most brokers: GMT+2 winter / GMT+3 during US DST).
2. Copy the token shown once (it is stored only as a SHA-256 hash; "Rotate Collector Token" revokes the old one).
3. Run (PowerShell):

   ```powershell
   $env:LEDGERFX_INGEST_TOKEN = "<token>"
   python collect_mt5.py --mode full --push-url "https://your-ledgerfx/api/ingest/<accountId>" --no-csv
   ```

   Use `--token-file path` instead of the env var if you prefer. Plain HTTP is refused except for localhost. The server must see the same login and server name as the linked account and refuses sessions where trading is enabled.
4. Re-run any time (`--mode incremental`). Records are upserted by (account, ticket), so nothing is duplicated; the checkpoint only advances after the server accepts the data.

A balance-mismatch warning means the imported history does not add up to the broker-reported balance (usually history older than the fetched range: run `--mode full`).

Server settings: `APP_URL` (public base URL used in the ingest URL), `SEED_DEMO_DATA=true` (opt-in demo data; off by default).
