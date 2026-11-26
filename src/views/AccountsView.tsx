import React, { useEffect, useState } from 'react';
import {
  Plus,
  RefreshCw,
  Trash2,
  Upload,
  ShieldCheck,
  AlertTriangle,
  Copy,
  Check,
  Pencil,
} from 'lucide-react';
import type {
  BalanceOperation,
  BootstrapPayload,
  ClosedTrade,
  MT5Account,
  MT5OpenPosition,
  UserSettings,
} from '../shared/types.ts';
import {
  MT5_EET_US_DST_ZONE,
  SERVER_TIMEZONE_OPTIONS,
  formatCurrency,
  formatTimestampWithServer,
} from '../shared/timeUtils.ts';
import { api } from '../lib/api.ts';

interface AccountsViewProps {
  accounts: MT5Account[];
  closedTrades: ClosedTrade[];
  openPositions: MT5OpenPosition[];
  balanceOperations: BalanceOperation[];
  settings: UserSettings;
  onRefreshBootstrap: (payload?: unknown) => void;
  onSyncAccount: (
    accountId: string,
    opts?: { mode?: 'incremental' | 'reimport'; simulatePartialFailure?: boolean },
  ) => Promise<void>;
  syncingAccountId: string | null;
  initialOpenLinkForm?: boolean;
  onConsumeInitialOpenLinkForm?: () => void;
}

const PYTHON_BRIDGE_SNIPPET = `# Read-only local MetaTrader 5 Bridge (Python 3.10+)
# Runs alongside your MT5 Desktop Terminal and serves deal history over HTTPS/TLS
import MetaTrader5 as mt5
from datetime import datetime, timezone
from fastapi import FastAPI, HTTPException

app = FastAPI(title="LedgerFX Read-Only MT5 Bridge")

@app.post("/history")
def fetch_history(payload: dict):
    if not mt5.initialize():
        raise HTTPException(status_code=503, detail="MT5 terminal not initialised")
    deals = mt5.history_deals_get(datetime(2020, 1, 1, tzinfo=timezone.utc), datetime.now(timezone.utc))
    since_ticket = int(payload.get("sinceTicket", 0))
    return {
        "deals": [d._asdict() for d in (deals or []) if d.ticket > since_ticket],
        "readOnly": True,
    }`;

const SAMPLE_CSV_TEMPLATE = `DEAL_TICKET,DEAL_ORDER,DEAL_POSITION_ID,DEAL_TIME,DEAL_SYMBOL,DEAL_TYPE,DEAL_ENTRY,DEAL_VOLUME,DEAL_PRICE,DEAL_PROFIT,DEAL_COMMISSION,DEAL_SWAP,SL,TP,DEAL_COMMENT
955001,655001,799001,2026.11.19 10:15:00,EURUSD,DEAL_TYPE_BUY,DEAL_ENTRY_IN,0.50,1.07600,0.00,-2.75,0.00,1.07300,1.08200,CSV import entry 1
955002,655002,799001,2026.11.19 12:00:00,EURUSD,DEAL_TYPE_BUY,DEAL_ENTRY_IN,0.50,1.07700,0.00,-2.75,0.00,1.07350,1.08200,CSV scale-in entry 2
955003,655003,799001,2026.11.19 15:10:00,EURUSD,DEAL_TYPE_SELL,DEAL_ENTRY_OUT,0.40,1.08050,142.00,-2.20,0.00,1.07650,1.08200,CSV partial close 1
955004,655004,799001,2026.11.19 16:45:00,EURUSD,DEAL_TYPE_SELL,DEAL_ENTRY_OUT,0.60,1.08190,264.00,-3.30,0.00,1.07650,1.08200,CSV final close 2`;

const COMMON_MT5_SERVERS = [
  'ICMarketsSC-Live06',
  'ICMarketsSC-Demo',
  'PepperstoneUK-Live',
  'PepperstoneUK-Demo02',
  'FTMO-Server3',
  'FTMO-Demo',
  'Exness-MT5Real',
  'OANDA-MT5-Live',
  'XMGlobal-MT5',
  'MetaQuotes-Demo',
];

type ConnectionChoice = 'collector' | 'bridge_https' | 'csv_import' | 'mt5_sandbox';

const CONNECTION_DESCRIPTIONS: Record<ConnectionChoice, string> = {
  collector:
    'Recommended for real data. You sign in to MT5 with the Investor (read-only) password inside your own MT5 terminal; the LedgerFX collector reads the history and pushes it here with a revocable token. No password is ever entered into or stored by this app.',
  bridge_https:
    'Connects over TLS to your self-hosted Python MetaTrader 5 bridge running beside your desktop MT5 terminal for automated live/demo history pulls.',
  csv_import:
    'Creates your account profile so you can upload real MetaTrader 5 Deal History CSV exports directly. No password is stored.',
  mt5_sandbox:
    'SIMULATED demo account with generated sample trades. Only for trying out the app — never use it for a real account.',
};

function buildCollectorCommands(token: string, ingestUrl: string) {
  return {
    powershell: `$env:LEDGERFX_INGEST_TOKEN = "${token}"\npython collect_mt5.py --mode full --push-url "${ingestUrl}" --no-csv`,
    cmd: `set LEDGERFX_INGEST_TOKEN=${token}\npython collect_mt5.py --mode full --push-url "${ingestUrl}" --no-csv`,
  };
}

export function AccountsView({
  accounts,
  closedTrades,
  openPositions,
  balanceOperations,
  settings,
  onRefreshBootstrap,
  onSyncAccount,
  syncingAccountId,
  initialOpenLinkForm,
  onConsumeInitialOpenLinkForm,
}: AccountsViewProps) {
  const [showLinkForm, setShowLinkForm] = useState(Boolean(initialOpenLinkForm));
  const [friendlyName, setFriendlyName] = useState('');
  const [accountLogin, setAccountLogin] = useState('');
  const [brokerName, setBrokerName] = useState('');
  const [brokerServer, setBrokerServer] = useState('');
  const [environment, setEnvironment] = useState<'live' | 'demo'>('live');
  const [accountMode, setAccountMode] = useState<'hedging' | 'netting'>('hedging');
  const [currency, setCurrency] = useState('GBP');
  const [leverage, setLeverage] = useState(30);
  const [serverTimeZone, setServerTimeZone] = useState<string>(MT5_EET_US_DST_ZONE);
  const [connectionType, setConnectionType] = useState<ConnectionChoice>('collector');
  const [collectorInfo, setCollectorInfo] = useState<{ accountId: string; token: string; ingestUrl: string } | null>(
    null,
  );
  const [collectorBusyId, setCollectorBusyId] = useState<string | null>(null);
  const [collectorError, setCollectorError] = useState<string | null>(null);
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);
  const [bridgeUrl, setBridgeUrl] = useState('');
  const [emptyHistory, setEmptyHistory] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [formSuccess, setFormSuccess] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);

  const [csvAccountId, setCsvAccountId] = useState<string | null>(null);
  const [csvText, setCsvText] = useState('');
  const [csvStatus, setCsvStatus] = useState<string | null>(null);

  const [editingAccountId, setEditingAccountId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editServerTz, setEditServerTz] = useState<string>(MT5_EET_US_DST_ZONE);
  const [editError, setEditError] = useState<string | null>(null);

  const [copiedBridge, setCopiedBridge] = useState(false);
  const [confirmUnlinkId, setConfirmUnlinkId] = useState<string | null>(null);

  useEffect(() => {
    if (initialOpenLinkForm) {
      setShowLinkForm(true);
      onConsumeInitialOpenLinkForm?.();
    }
  }, [initialOpenLinkForm, onConsumeInitialOpenLinkForm]);

  async function handleLinkAccount(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    setFormSuccess(null);
    setLinking(true);
    const existingIds = new Set(accounts.map((a) => a.id));
    const selectedMode = connectionType;
    try {
      const payload = (await api.linkAccount({
        friendlyName,
        accountLogin,
        brokerName: brokerName || 'MetaTrader 5 Broker',
        brokerServer,
        environment,
        accountMode,
        currency,
        leverage,
        serverTimeZone,
        serverUtcOffsetLabel: 'GMT+2',
        connectionType,
        bridgeUrl: connectionType === 'bridge_https' ? bridgeUrl : undefined,
        emptyHistory,
      })) as BootstrapPayload;
      onRefreshBootstrap(payload);
      const created = payload.accounts.find((a) => !existingIds.has(a.id));
      setFormSuccess(
        selectedMode === 'csv_import'
          ? `Account "${friendlyName}" (#${accountLogin}) linked. Paste or upload your MT5 Deal History CSV below.`
          : selectedMode === 'collector'
            ? `Account "${friendlyName}" (#${accountLogin}) linked. Follow the collector setup below to import its real history.`
            : `Account "${friendlyName}" (#${accountLogin}) linked.`,
      );
      if (selectedMode === 'csv_import' && created) {
        setCsvAccountId(created.id);
      }
      if (selectedMode === 'collector' && created) {
        await handleGenerateToken(created.id);
      }
      setFriendlyName('');
      setAccountLogin('');
      setBrokerName('');
      setBrokerServer('');
      setBridgeUrl('');
      setShowLinkForm(false);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Connection failed.');
    } finally {
      setLinking(false);
    }
  }

  async function handleGenerateToken(accountId: string) {
    setCollectorError(null);
    setCollectorBusyId(accountId);
    try {
      const res = await api.createIngestToken(accountId);
      onRefreshBootstrap(res.payload);
      setCollectorInfo({ accountId, token: res.token, ingestUrl: res.ingestUrl });
    } catch (err) {
      setCollectorError(err instanceof Error ? err.message : 'Unable to generate collector token.');
    } finally {
      setCollectorBusyId(null);
    }
  }

  async function copyCommand(key: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedCommand(key);
      window.setTimeout(() => setCopiedCommand((cur) => (cur === key ? null : cur)), 2000);
    } catch {
      setCollectorError('Copy failed — select the command text and copy it manually.');
    }
  }

  async function handleSaveEdit(accountId: string) {
    setEditError(null);
    try {
      const payload = await api.updateAccount(accountId, {
        friendlyName: editName,
        serverTimeZone: editServerTz,
      });
      onRefreshBootstrap(payload);
      setEditingAccountId(null);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Unable to update account.');
    }
  }

  async function handleUnlink(accountId: string) {
    setFormError(null);
    try {
      const payload = await api.unlinkAccount(accountId);
      onRefreshBootstrap(payload);
      setConfirmUnlinkId(null);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Unable to unlink account.');
    }
  }

  async function handleCsvImport(e: React.FormEvent) {
    e.preventDefault();
    if (!csvAccountId || !csvText.trim()) return;
    setCsvStatus(null);
    try {
      const res = await api.importCsv(csvAccountId, csvText);
      onRefreshBootstrap(res.payload);
      setCsvStatus(
        `Imported ${res.newDeals} new deal(s) and ${res.newOps} balance operation(s).` +
          (res.warnings.length > 0 ? ` Notes: ${res.warnings.join(' ')}` : ''),
      );
      setCsvText('');
    } catch (err) {
      setCsvStatus(err instanceof Error ? err.message : 'CSV import failed.');
    }
  }

  function handleCsvFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') setCsvText(reader.result);
    };
    reader.readAsText(file);
  }

  function copyBridgeScript() {
    navigator.clipboard?.writeText(PYTHON_BRIDGE_SNIPPET);
    setCopiedBridge(true);
    setTimeout(() => setCopiedBridge(false), 2000);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4 pb-4 border-b border-slate-200 dark:border-slate-800">
        <div>
          <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-slate-100">
            MT5 Accounts & Synchronisation
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Read-only broker connections · AES-256-GCM encrypted credentials · Zero order execution capability
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setShowLinkForm((v) => !v);
            setFormError(null);
          }}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-md bg-slate-900 hover:bg-slate-800 dark:bg-blue-600 dark:hover:bg-blue-500 text-white whitespace-nowrap shrink-0"
        >
          <Plus className="w-4 h-4" aria-hidden="true" />
          Link MT5 Account
        </button>
      </div>

      {formSuccess && (
        <div
          role="status"
          className="text-xs text-emerald-800 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 rounded-lg px-4 py-3"
        >
          {formSuccess}
        </div>
      )}

      {/* Link New MT5 Account Form */}
      {showLinkForm && (
        <form
          onSubmit={handleLinkAccount}
          className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-6 space-y-4"
        >
          <div className="flex items-center justify-between">
            <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
              Connect MetaTrader 5 Account (Read-Only)
            </h2>
            <span className="inline-flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
              <ShieldCheck className="w-4 h-4" aria-hidden="true" />
              No MT5 password is entered into or stored by this app
            </span>
          </div>

          <p className="text-xs text-slate-600 dark:text-slate-400 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md px-3.5 py-2.5">
            {CONNECTION_DESCRIPTIONS[connectionType]}
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Connection Method
              </label>
              <select
                value={connectionType}
                onChange={(e) => setConnectionType(e.target.value as ConnectionChoice)}
                className="w-full px-3 py-2 text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
              >
                <option value="collector">Windows Read-Only Collector (real data, recommended)</option>
                <option value="csv_import">MT5 Statement / Deal History CSV Only</option>
                <option value="bridge_https">Self-Hosted MT5 HTTPS Python Bridge (TLS)</option>
                <option value="mt5_sandbox">Demo Sandbox (SIMULATED sample data)</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Friendly Account Name *
              </label>
              <input
                required
                value={friendlyName}
                onChange={(e) => setFriendlyName(e.target.value)}
                placeholder="e.g. IC Markets UK Live"
                className="w-full px-3 py-2 text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                MT5 Account Login *
              </label>
              <input
                required
                inputMode="numeric"
                value={accountLogin}
                onChange={(e) => setAccountLogin(e.target.value)}
                placeholder="e.g. 5120984"
                className="w-full px-3 py-2 text-xs font-mono rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
              />
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
                Numeric account number from MT5 → File → Login to Trade Account.
              </p>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Broker Name
              </label>
              <input
                value={brokerName}
                onChange={(e) => setBrokerName(e.target.value)}
                placeholder="e.g. IC Markets (UK) Ltd"
                className="w-full px-3 py-2 text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                MT5 Broker Server *
              </label>
              <input
                required
                list="mt5-broker-servers"
                value={brokerServer}
                onChange={(e) => setBrokerServer(e.target.value)}
                placeholder="e.g. ICMarketsSC-Live06"
                className="w-full px-3 py-2 text-xs font-mono rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
              />
              <datalist id="mt5-broker-servers">
                {COMMON_MT5_SERVERS.map((srv) => (
                  <option key={srv} value={srv} />
                ))}
              </datalist>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
                Exact server name shown in your MT5 Navigator panel.
              </p>
            </div>

            {connectionType === 'bridge_https' && (
              <div className="sm:col-span-2 lg:col-span-3">
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  HTTPS MT5 Bridge Endpoint URL *
                </label>
                <input
                  type="url"
                  required
                  value={bridgeUrl}
                  onChange={(e) => setBridgeUrl(e.target.value)}
                  placeholder="https://mt5-bridge.yourdomain.co.uk/history"
                  className="w-full px-3 py-2 text-xs font-mono rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                />
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Environment & Mode
              </label>
              <div className="flex gap-2">
                <select
                  aria-label="Account environment"
                  value={environment}
                  onChange={(e) => setEnvironment(e.target.value as 'live' | 'demo')}
                  className="w-1/2 px-2.5 py-2 text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                >
                  <option value="live">Live</option>
                  <option value="demo">Demo</option>
                </select>
                <select
                  aria-label="Position accounting mode"
                  value={accountMode}
                  onChange={(e) => setAccountMode(e.target.value as 'hedging' | 'netting')}
                  className="w-1/2 px-2.5 py-2 text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                >
                  <option value="hedging">Hedging</option>
                  <option value="netting">Netting</option>
                </select>
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Base Currency & Leverage
              </label>
              <div className="flex gap-2">
                <select
                  aria-label="Account currency"
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value)}
                  className="w-1/2 px-2.5 py-2 text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                >
                  <option value="GBP">GBP (£)</option>
                  <option value="USD">USD ($)</option>
                  <option value="EUR">EUR (€)</option>
                </select>
                <input
                  type="number"
                  min={1}
                  max={1000}
                  aria-label="Account leverage"
                  value={leverage}
                  onChange={(e) => setLeverage(Number(e.target.value))}
                  className="w-1/2 px-2.5 py-2 text-xs font-mono rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Broker Server Clock (time zone)
              </label>
              <select
                value={serverTimeZone}
                onChange={(e) => setServerTimeZone(e.target.value)}
                className="w-full px-3 py-2 text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
              >
                {SERVER_TIMEZONE_OPTIONS.map((tz) => (
                  <option key={tz.value} value={tz.value}>
                    {tz.label}
                  </option>
                ))}
              </select>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
                Controls trade times and sessions. Changeable later — timestamps are rebuilt automatically.
              </p>
            </div>
          </div>

          {connectionType === 'mt5_sandbox' && (
            <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300 pt-1">
              <input
                type="checkbox"
                checked={emptyHistory}
                onChange={(e) => setEmptyHistory(e.target.checked)}
                className="rounded border-slate-300 dark:border-slate-700"
              />
              Start with empty broker history (0 trades) — useful for importing your own CSV or testing empty state
            </label>
          )}

          {formError && (
            <div
              role="alert"
              className="text-xs text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded-lg px-3.5 py-2.5"
            >
              {formError}
            </div>
          )}

          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={() => setShowLinkForm(false)}
              className="px-4 py-2 text-xs font-medium rounded-md border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={linking}
              className="px-4 py-2 text-xs font-medium rounded-md bg-slate-900 dark:bg-blue-600 text-white hover:bg-slate-800 dark:hover:bg-blue-500 disabled:opacity-60"
            >
              {linking ? 'Linking...' : 'Link Read-Only Account'}
            </button>
          </div>
        </form>
      )}

      {/* Linked Account Cards */}
      <div className="space-y-4">
        {accounts.length === 0 ? (
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-10 text-center">
            <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
              No MT5 accounts linked yet
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 max-w-md mx-auto">
              Link your live or demo MetaTrader 5 account using its login number and server name, then import its real history with the read-only collector or a CSV export.
            </p>
            {!showLinkForm && (
              <button
                type="button"
                onClick={() => {
                  setShowLinkForm(true);
                  setFormError(null);
                }}
                className="mt-4 inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-md bg-slate-900 hover:bg-slate-800 dark:bg-blue-600 dark:hover:bg-blue-500 text-white"
              >
                <Plus className="w-4 h-4" aria-hidden="true" />
                Link MT5 Account
              </button>
            )}
          </div>
        ) : (
          accounts.map((acc) => {
            const accTrades = closedTrades.filter((t) => t.accountId === acc.id);
            const accOpen = openPositions.filter((p) => p.accountId === acc.id);
            const accOps = balanceOperations.filter((o) => o.accountId === acc.id);
            const accNetPL = accTrades.reduce((s, t) => s + t.netProfit, 0);
            const isSyncing = syncingAccountId === acc.id;

            return (
              <div
                key={acc.id}
                className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                      <span className="font-mono">Login #{acc.accountLogin}</span>
                      <span aria-hidden="true">·</span>
                      <span>{acc.brokerName}</span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono">{acc.brokerServer}</span>
                      <span aria-hidden="true">·</span>
                      <span className="capitalize">{acc.environment}</span>
                      <span aria-hidden="true">·</span>
                      <span className="capitalize">{acc.accountMode}</span>
                      <span aria-hidden="true">·</span>
                      <span>1:{acc.leverage}</span>
                    </div>
                    <h2 className="font-display text-lg font-bold text-slate-900 dark:text-slate-100 mt-1">
                      {acc.friendlyName}
                    </h2>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {acc.connectionType === 'collector' && (
                      <button
                        type="button"
                        disabled={collectorBusyId === acc.id}
                        onClick={() => handleGenerateToken(acc.id)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-slate-900 dark:bg-blue-600 text-white hover:bg-slate-800 dark:hover:bg-blue-500 disabled:opacity-60 whitespace-nowrap"
                      >
                        <ShieldCheck className="w-3.5 h-3.5" aria-hidden="true" />
                        {collectorBusyId === acc.id
                          ? 'Generating...'
                          : acc.hasIngestToken
                            ? 'Rotate Collector Token'
                            : 'Generate Collector Token'}
                      </button>
                    )}
                    {acc.connectionType !== 'collector' && acc.connectionType !== 'csv_import' && (
                      <>
                        <button
                          type="button"
                          disabled={isSyncing}
                          onClick={() => onSyncAccount(acc.id, { mode: 'incremental' })}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-slate-900 dark:bg-blue-600 text-white hover:bg-slate-800 dark:hover:bg-blue-500 disabled:opacity-60 whitespace-nowrap"
                        >
                          <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin' : ''}`} aria-hidden="true" />
                          {isSyncing ? 'Syncing...' : 'Sync Now'}
                        </button>
                        <button
                          type="button"
                          disabled={isSyncing}
                          onClick={() => onSyncAccount(acc.id, { mode: 'reimport' })}
                          className="px-3 py-1.5 text-xs font-medium rounded-md border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
                        >
                          Re-Import (Keep Notes)
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setCsvAccountId(csvAccountId === acc.id ? null : acc.id);
                        setCsvStatus(null);
                      }}
                      className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-md border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
                    >
                      <Upload className="w-3.5 h-3.5" aria-hidden="true" />
                      Import CSV
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setEditingAccountId(editingAccountId === acc.id ? null : acc.id);
                        setEditName(acc.friendlyName);
                        setEditServerTz(acc.serverTimeZone || MT5_EET_US_DST_ZONE);
                        setEditError(null);
                      }}
                      aria-label={`Edit ${acc.friendlyName}`}
                      className="p-1.5 rounded-md border border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmUnlinkId(confirmUnlinkId === acc.id ? null : acc.id)}
                      aria-label={`Unlink ${acc.friendlyName}`}
                      className="p-1.5 rounded-md border border-red-200 dark:border-red-900 text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {/* Account Financial Stats Row */}
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-4 pt-3 border-t border-slate-100 dark:border-slate-800 text-xs">
                  <div>
                    <p className="text-slate-500 dark:text-slate-400">Balance</p>
                    <p className="font-mono tabular-nums font-semibold text-slate-900 dark:text-slate-100 mt-0.5">
                      {formatCurrency(acc.balance, settings, { currencyOverride: acc.currency })}
                    </p>
                  </div>
                  <div>
                    <p className="text-slate-500 dark:text-slate-400">Equity</p>
                    <p className="font-mono tabular-nums font-semibold text-slate-900 dark:text-slate-100 mt-0.5">
                      {formatCurrency(acc.equity, settings, { currencyOverride: acc.currency })}
                    </p>
                  </div>
                  <div>
                    <p className="text-slate-500 dark:text-slate-400">Realised Net P/L</p>
                    <p
                      className={`font-mono tabular-nums font-semibold mt-0.5 ${
                        accNetPL >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400'
                      }`}
                    >
                      {formatCurrency(accNetPL, settings, { signed: true, currencyOverride: acc.currency })}
                    </p>
                  </div>
                  <div>
                    <p className="text-slate-500 dark:text-slate-400">Records Synced</p>
                    <p className="font-mono tabular-nums text-slate-800 dark:text-slate-200 mt-0.5">
                      {accTrades.length} closed · {accOpen.length} open · {accOps.length} cash ops
                    </p>
                  </div>
                  <div>
                    <p className="text-slate-500 dark:text-slate-400">Last Sync (Highest Ticket)</p>
                    <p className="font-mono tabular-nums text-slate-800 dark:text-slate-200 mt-0.5">
                      {acc.lastSyncUtc
                        ? `${formatTimestampWithServer(acc.lastSyncUtc, undefined, undefined, settings)} (#${acc.highestDealTicket})`
                        : 'Never'}
                    </p>
                  </div>
                </div>

                {/* Sync Notice & Reliability Controls */}
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600 dark:text-slate-400 pt-2 border-t border-slate-100 dark:border-slate-800">
                  <p>{acc.syncNotice ?? 'Read-only connection ready.'}</p>
                  {acc.connectionType === 'mt5_sandbox' && (
                    <button
                      type="button"
                      disabled={isSyncing}
                      onClick={() => onSyncAccount(acc.id, { simulatePartialFailure: true })}
                      className="text-[11px] text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200 underline whitespace-nowrap"
                    >
                      Test Partial Sync Failure Recovery (simulated)
                    </button>
                  )}
                </div>

                {/* Collector token panel (token is shown once, right after it is generated) */}
                {collectorError && collectorBusyId === null && collectorInfo?.accountId !== acc.id && editingAccountId !== acc.id && acc.connectionType === 'collector' && (
                  <p role="alert" className="text-xs text-red-700 dark:text-red-400">{collectorError}</p>
                )}
                {collectorInfo?.accountId === acc.id && (
                  <div className="p-4 rounded-md bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-900 space-y-3 text-xs">
                    <div className="flex items-center gap-2 font-semibold text-blue-900 dark:text-blue-200">
                      <ShieldCheck className="w-4 h-4" aria-hidden="true" />
                      Collector setup — copy this now, the token is shown only once
                    </div>
                    <ol className="list-decimal pl-5 space-y-1 text-slate-700 dark:text-slate-300">
                      <li>On Windows, open MetaTrader 5 and sign in to this account with the Investor (read-only) password.</li>
                      <li>Open a terminal in the <span className="font-mono">mt5-collector</span> folder (Python 3.10+ and <span className="font-mono">pip install MetaTrader5</span>).</li>
                      <li>Paste one of the commands below. Re-run it any time to pull new history — duplicates are never created.</li>
                    </ol>
                    {(() => {
                      const cmds = buildCollectorCommands(collectorInfo.token, collectorInfo.ingestUrl);
                      return (
                        <div className="space-y-2">
                          {([['powershell', 'PowerShell', cmds.powershell], ['cmd', 'Command Prompt', cmds.cmd]] as const).map(
                            ([key, label, text]) => (
                              <div key={key}>
                                <div className="flex items-center justify-between mb-1">
                                  <span className="font-medium text-slate-700 dark:text-slate-300">{label}</span>
                                  <button
                                    type="button"
                                    onClick={() => copyCommand(key, text)}
                                    className="inline-flex items-center gap-1 px-2 py-1 rounded border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200"
                                  >
                                    {copiedCommand === key ? <Check className="w-3 h-3" aria-hidden="true" /> : <Copy className="w-3 h-3" aria-hidden="true" />}
                                    {copiedCommand === key ? 'Copied' : 'Copy'}
                                  </button>
                                </div>
                                <pre className="font-mono text-[11px] bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded p-2 overflow-x-auto whitespace-pre-wrap break-all">{text}</pre>
                              </div>
                            ),
                          )}
                        </div>
                      );
                    })()}
                    <p className="text-slate-600 dark:text-slate-400">
                      The URL uses this site&apos;s address. If LedgerFX runs on another machine than the one hosting it publicly, set{' '}
                      <span className="font-mono">APP_URL</span> on the server so the URL is reachable from your Windows PC (HTTPS required except localhost).
                    </p>
                    <button
                      type="button"
                      onClick={() => setCollectorInfo(null)}
                      className="px-3 py-1.5 rounded-md border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200"
                    >
                      I&apos;ve saved it — hide token
                    </button>
                  </div>
                )}

                {acc.integrityWarnings.length > 0 && (
                  <div className="flex items-start gap-2 text-xs text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 rounded-md px-3.5 py-2.5">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
                    <div className="space-y-1">
                      {acc.integrityWarnings.map((w, idx) => (
                        <p key={idx}>{w}</p>
                      ))}
                    </div>
                  </div>
                )}

                {/* Inline Rename / Re-validate Credentials */}
                {editingAccountId === acc.id && (
                  <div className="p-4 rounded-md bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 space-y-3">
                    <p className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                      Edit Account Settings
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <input
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        placeholder="Friendly account name"
                        aria-label="Friendly account name"
                        className="px-3 py-1.5 text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
                      />
                      <select
                        value={editServerTz}
                        onChange={(e) => setEditServerTz(e.target.value)}
                        aria-label="Broker server clock time zone"
                        className="px-3 py-1.5 text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
                      >
                        {SERVER_TIMEZONE_OPTIONS.map((tz) => (
                          <option key={tz.value} value={tz.value}>
                            {tz.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400">
                      Changing the broker clock rebuilds every stored trade time from the original broker timestamps.
                    </p>
                    {editError && <p className="text-xs text-red-700 dark:text-red-400">{editError}</p>}
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setEditingAccountId(null)}
                        className="px-3 py-1.5 text-xs rounded-md border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => handleSaveEdit(acc.id)}
                        className="px-3 py-1.5 text-xs font-medium rounded-md bg-slate-900 dark:bg-blue-600 text-white"
                      >
                        Save Changes
                      </button>
                    </div>
                  </div>
                )}

                {/* Inline Unlink Confirmation */}
                {confirmUnlinkId === acc.id && (
                  <div className="p-4 rounded-md bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 flex flex-wrap items-center justify-between gap-3 text-xs">
                    <p className="text-red-800 dark:text-red-300">
                      Unlinking permanently deletes all imported deals, open positions, and trade journal notes for{' '}
                      <strong>{acc.friendlyName}</strong>.
                    </p>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setConfirmUnlinkId(null)}
                        className="px-3 py-1.5 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => handleUnlink(acc.id)}
                        className="px-3 py-1.5 font-medium rounded-md bg-red-600 hover:bg-red-700 text-white"
                      >
                        Confirm Permanent Unlink
                      </button>
                    </div>
                  </div>
                )}

                {/* Inline CSV Importer */}
                {csvAccountId === acc.id && (
                  <form
                    onSubmit={handleCsvImport}
                    className="p-4 rounded-md bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 space-y-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                        Import MT5 Deal History CSV / TSV into {acc.friendlyName}
                      </p>
                      <div className="flex items-center gap-3">
                        <button
                          type="button"
                          onClick={() => setCsvText(SAMPLE_CSV_TEMPLATE)}
                          className="text-xs text-blue-700 dark:text-blue-400 hover:underline"
                        >
                          Load Partial-Fill Sample CSV
                        </button>
                        <label className="text-xs text-slate-600 dark:text-slate-300 cursor-pointer underline">
                          Upload .csv file
                          <input
                            type="file"
                            accept=".csv,.tsv,.txt"
                            onChange={handleCsvFileUpload}
                            className="sr-only"
                          />
                        </label>
                      </div>
                    </div>
                    <textarea
                      rows={5}
                      value={csvText}
                      onChange={(e) => setCsvText(e.target.value)}
                      placeholder="Paste MT5 deals CSV (DEAL_TICKET, DEAL_POSITION_ID, DEAL_TIME, DEAL_SYMBOL, DEAL_TYPE, DEAL_ENTRY, DEAL_VOLUME, DEAL_PRICE, DEAL_PROFIT...)"
                      className="w-full p-2.5 text-[11px] font-mono rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
                    />
                    {csvStatus && (
                      <p role="status" className="text-xs text-slate-700 dark:text-slate-300">
                        {csvStatus}
                      </p>
                    )}
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setCsvAccountId(null)}
                        className="px-3 py-1.5 text-xs rounded-md border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200"
                      >
                        Close
                      </button>
                      <button
                        type="submit"
                        disabled={!csvText.trim()}
                        className="px-3 py-1.5 text-xs font-medium rounded-md bg-slate-900 dark:bg-blue-600 text-white disabled:opacity-50"
                      >
                        Import Deals (Duplicate-Safe)
                      </button>
                    </div>
                  </form>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Self-Hosted Read-Only MT5 Python Bridge Reference */}
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
              Self-Hosted MT5 Read-Only Python Bridge Reference
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Use the official MetaTrader5 Python package on your Windows trading machine to stream read-only deals over TLS.
            </p>
          </div>
          <button
            type="button"
            onClick={copyBridgeScript}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
          >
            {copiedBridge ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
            {copiedBridge ? 'Copied' : 'Copy Script'}
          </button>
        </div>
        <pre className="p-3.5 rounded-md bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-[11px] font-mono text-slate-800 dark:text-slate-200 overflow-x-auto leading-relaxed">
          {PYTHON_BRIDGE_SNIPPET}
        </pre>
      </section>
    </div>
  );
}
