import React, { useMemo, useState } from 'react';
import { Download, FileText, Database, Upload } from 'lucide-react';
import type {
  BalanceOperation,
  ClosedTrade,
  MT5Account,
  MT5Deal,
  MT5OpenPosition,
  UserSettings,
} from '../shared/types.ts';
import { computePerformanceMetrics } from '../shared/metricsEngine.ts';
import { getIsoDayInZone } from '../shared/timeUtils.ts';
import {
  downloadJsonBackup,
  downloadRawDealsCsv,
  downloadTradesCsv,
  generatePdfSummaryReport,
} from '../lib/exportUtils.ts';
import { api } from '../lib/api.ts';

interface ReportsViewProps {
  accounts: MT5Account[];
  allClosedTrades: ClosedTrade[];
  filteredTrades: ClosedTrade[];
  deals: MT5Deal[];
  balanceOperations: BalanceOperation[];
  openPositions: MT5OpenPosition[];
  settings: UserSettings;
  onRefreshBootstrap: (payload?: unknown) => void;
}

export function ReportsView({
  accounts,
  allClosedTrades,
  filteredTrades,
  deals,
  balanceOperations,
  openPositions,
  settings,
  onRefreshBootstrap,
}: ReportsViewProps) {
  const [preset, setPreset] = useState<'monthly' | 'year_end' | 'custom'>('monthly');
  const [reportTitle, setReportTitle] = useState('LedgerFX — Monthly MT5 Performance Summary');
  const [dateFrom, setDateFrom] = useState('2026-10-01');
  const [dateTo, setDateTo] = useState('2026-11-30');
  const [accountId, setAccountId] = useState('all');
  const [includeMetrics, setIncludeMetrics] = useState(true);
  const [includeFormulas, setIncludeFormulas] = useState(true);
  const [includeMonthlyTable, setIncludeMonthlyTable] = useState(true);
  const [includeSymbolBreakdown, setIncludeSymbolBreakdown] = useState(true);
  const [includeTradeHighlights, setIncludeTradeHighlights] = useState(true);
  const [backupMessage, setBackupMessage] = useState<string | null>(null);

  const applyPreset = (next: 'monthly' | 'year_end' | 'custom') => {
    setPreset(next);
    if (next === 'monthly') {
      setReportTitle('LedgerFX — Monthly MT5 Performance Summary');
      setDateFrom('2026-11-01');
      setDateTo('2026-11-30');
    } else if (next === 'year_end') {
      setReportTitle('LedgerFX — 2026 Annual Trading Audit');
      setDateFrom('2026-01-01');
      setDateTo('2026-12-31');
    } else {
      setReportTitle('LedgerFX — Custom Trading Report');
    }
  };

  const reportTrades = useMemo(() => {
    return allClosedTrades.filter((t) => {
      if (accountId !== 'all' && t.accountId !== accountId) return false;
      const day = getIsoDayInZone(t.closeTimeUtc, settings.displayTimeZone);
      if (dateFrom && day < dateFrom) return false;
      if (dateTo && day > dateTo) return false;
      return true;
    });
  }, [allClosedTrades, accountId, dateFrom, dateTo, settings.displayTimeZone]);

  const reportMetrics = useMemo(() => {
    const ops =
      accountId === 'all'
        ? balanceOperations
        : balanceOperations.filter((o) => o.accountId === accountId);
    const open =
      accountId === 'all' ? openPositions : openPositions.filter((p) => p.accountId === accountId);
    const accs = accountId === 'all' ? accounts : accounts.filter((a) => a.id === accountId);
    return computePerformanceMetrics(reportTrades, ops, open, accs, settings);
  }, [reportTrades, balanceOperations, openPositions, accounts, accountId, settings]);

  function handleGeneratePdf(e: React.FormEvent) {
    e.preventDefault();
    const accName =
      accountId === 'all'
        ? 'All Linked MT5 Accounts'
        : accounts.find((a) => a.id === accountId)?.friendlyName ?? 'MT5 Account';
    generatePdfSummaryReport(reportTrades, reportMetrics, settings, {
      title: reportTitle.trim() || 'LedgerFX Performance Report',
      subtitle: `${accName} · Period ${dateFrom || 'Earliest'} to ${dateTo || 'Present'}`,
      includeMetrics,
      includeFormulas,
      includeMonthlyTable,
      includeSymbolBreakdown,
      includeTradeHighlights,
    });
  }

  async function handleExportBackup() {
    setBackupMessage(null);
    try {
      const data = await api.exportBackup();
      downloadJsonBackup(data);
      setBackupMessage('Full JSON journal backup downloaded (MT5 passwords excluded for security).');
    } catch (err) {
      setBackupMessage(err instanceof Error ? err.message : 'Unable to export backup.');
    }
  }

  function handleRestoreBackupFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        const payload = await api.restoreBackup(parsed);
        onRefreshBootstrap(payload);
        setBackupMessage('Journal backup restored successfully.');
      } catch (err) {
        setBackupMessage(err instanceof Error ? err.message : 'Invalid backup file.');
      }
    };
    reader.readAsText(file);
  }

  return (
    <div className="space-y-6">
      <div className="pb-4 border-b border-slate-200 dark:border-slate-800">
        <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-slate-100">
          Reports & Data Export
        </h1>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
          Download CSV spreadsheets, raw MT5 deal archives, customisable PDF performance summaries, and local backups
        </p>
      </div>

      {/* Custom PDF Report Builder */}
      <form
        onSubmit={handleGeneratePdf}
        className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-6 space-y-5"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
              Customisable PDF Report Builder
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Includes data source attribution notes, post-cost metrics, and transparent formula calculations
            </p>
          </div>
          <div
            role="group"
            aria-label="PDF report preset"
            className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg"
          >
            {(
              [
                ['monthly', 'Monthly Summary'],
                ['year_end', 'Year-End Summary'],
                ['custom', 'Custom Template'],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => applyPreset(k)}
                className={`px-2.5 py-1 text-xs font-medium rounded-md whitespace-nowrap ${
                  preset === k
                    ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="sm:col-span-2">
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
              Report Title
            </label>
            <input
              value={reportTitle}
              onChange={(e) => setReportTitle(e.target.value)}
              className="w-full px-3 py-2 text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
              Account Scope
            </label>
            <select
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              className="w-full px-3 py-2 text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
            >
              <option value="all">All MT5 Accounts</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.friendlyName}
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                From
              </label>
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="w-full px-2 py-2 text-xs font-mono rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                To
              </label>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="w-full px-2 py-2 text-xs font-mono rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
              />
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-5 text-xs text-slate-700 dark:text-slate-300 pt-1">
          {[
            { label: 'Key Performance Metrics', checked: includeMetrics, set: setIncludeMetrics },
            { label: 'Exact Calculation Breakdowns', checked: includeFormulas, set: setIncludeFormulas },
            { label: 'Monthly Performance Table', checked: includeMonthlyTable, set: setIncludeMonthlyTable },
            { label: 'Symbol Breakdown', checked: includeSymbolBreakdown, set: setIncludeSymbolBreakdown },
            { label: 'Recent Trade Highlights', checked: includeTradeHighlights, set: setIncludeTradeHighlights },
          ].map((opt) => (
            <label key={opt.label} className="inline-flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={opt.checked}
                onChange={(e) => opt.set(e.target.checked)}
                className="rounded border-slate-300 dark:border-slate-700"
              />
              {opt.label}
            </label>
          ))}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-slate-200 dark:border-slate-800">
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Selected range contains{' '}
            <span className="font-mono font-semibold text-slate-900 dark:text-slate-100">
              {reportTrades.length}
            </span>{' '}
            closed positions (Net P/L: {reportMetrics.totalNetProfit.formatted}).
          </p>
          <button
            type="submit"
            disabled={reportTrades.length === 0}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-md bg-slate-900 dark:bg-blue-600 text-white hover:bg-slate-800 dark:hover:bg-blue-500 disabled:opacity-50 whitespace-nowrap"
          >
            <FileText className="w-3.5 h-3.5" aria-hidden="true" />
            Download PDF Report
          </button>
        </div>
      </form>

      {/* CSV & Raw Deal Exports */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5 flex flex-col justify-between space-y-4">
          <div>
            <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
              Position-Grouped Trades CSV
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
              Exports closed trades with weighted entry/exit prices, net P/L, commissions, swaps, R-multiple, and journal notes for Excel or tax review.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={allClosedTrades.length === 0}
              onClick={() => downloadTradesCsv(allClosedTrades, settings)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-md border border-slate-300 dark:border-slate-700 text-slate-800 dark:text-slate-100 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
            >
              <Download className="w-3.5 h-3.5" aria-hidden="true" />
              All Trades ({allClosedTrades.length})
            </button>
            {filteredTrades.length !== allClosedTrades.length && (
              <button
                type="button"
                onClick={() => downloadTradesCsv(filteredTrades, settings, 'ledgerfx-filtered-trades.csv')}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-md border border-slate-300 dark:border-slate-700 text-slate-800 dark:text-slate-100 hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                Filtered ({filteredTrades.length})
              </button>
            )}
          </div>
        </section>

        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5 flex flex-col justify-between space-y-4">
          <div>
            <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
              Raw MT5 Deal History CSV
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
              Exports ungrouped execution-level MT5 records (`DEAL_TICKET`, `DEAL_POSITION_ID`, `DEAL_ENTRY`, server & UTC timestamps) for external tools.
            </p>
          </div>
          <button
            type="button"
            disabled={deals.length === 0}
            onClick={() => downloadRawDealsCsv(deals)}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-md border border-slate-300 dark:border-slate-700 text-slate-800 dark:text-slate-100 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 self-start"
          >
            <Download className="w-3.5 h-3.5" aria-hidden="true" />
            Export Raw Deals ({deals.length})
          </button>
        </section>

        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5 flex flex-col justify-between space-y-4">
          <div>
            <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
              Full Local Journal Backup
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
              Download or restore a complete JSON archive of all accounts, deals, trade journals, daily psychology logs, reviews, and preferences.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleExportBackup}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-md border border-slate-300 dark:border-slate-700 text-slate-800 dark:text-slate-100 hover:bg-slate-50 dark:hover:bg-slate-800"
            >
              <Database className="w-3.5 h-3.5" aria-hidden="true" />
              Backup JSON
            </button>
            <label className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-md border border-slate-300 dark:border-slate-700 text-slate-800 dark:text-slate-100 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer">
              <Upload className="w-3.5 h-3.5" aria-hidden="true" />
              Restore
              <input
                type="file"
                accept=".json"
                onChange={handleRestoreBackupFile}
                className="sr-only"
              />
            </label>
          </div>
          {backupMessage && (
            <p role="status" className="text-xs text-emerald-700 dark:text-emerald-400">
              {backupMessage}
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
