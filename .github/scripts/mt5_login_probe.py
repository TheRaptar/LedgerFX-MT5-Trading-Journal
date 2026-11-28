"""CI-only helper: ask the already-running MT5 terminal to log in via the official Python bridge.

Unlike the config-file login, this returns a concrete error code if the broker refuses.
The Investor password comes from the environment only and is never printed.
It always exits 0 so the collector step still runs and reports its own result.
"""
import os
import sys
import time

import MetaTrader5 as mt5

path = os.environ["MT5_TERMINAL"]
login = int(os.environ["MT5_LOGIN"])
password = os.environ["MT5_INVESTOR_PASSWORD"]
server = os.environ["MT5_SERVER"]

for attempt in range(1, 4):
    ok = mt5.initialize(path=path, login=login, password=password, server=server,
                        portable=True, timeout=120000)
    print(f"attempt {attempt}: initialize ok={ok} last_error={mt5.last_error()}")
    if ok:
        info = mt5.terminal_info()
        acc = mt5.account_info()
        print("terminal connected:", getattr(info, "connected", None),
              "| trade_allowed:", getattr(info, "trade_allowed", None))
        print("account found:", acc is not None,
              "| trade_mode:", getattr(acc, "trade_mode", None),
              "| server matches:", getattr(acc, "server", None) == server)
        mt5.shutdown()
        break
    mt5.shutdown()
    time.sleep(20)
sys.exit(0)
