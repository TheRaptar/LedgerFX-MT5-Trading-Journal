import React, { useMemo, useState } from 'react';
import {
  ArrowUpDown,
  ChevronDown,
  ChevronRight,
  Download,
  FileEdit,
} from 'lucide-react';
import type {
  ClosedTrade,
  FilterState,
  MT5Account,
  MT5OpenPosition,
  UserSettings,
} from '../shared/types.ts';
import {
  formatCurrency,
  formatDuration,
  formatTimestampWithServer,
} from '../shared/timeUtils.ts';
import { FilterBar } from '../components/FilterBar.tsx';
import { downloadTradesCsv } from '../lib/exportUtils.ts';

interface TradeHistoryViewProps {
  closedTrades: ClosedTrade[];
  openPositions: MT5OpenPosition[];
  accounts: MT5Account[];
  symbols: string[];
  strategies: string[];
  filters: FilterState;
  onFiltersChange: (next: FilterState) => void;
  settings: UserSettings;
  onSelectTrade: (trade: ClosedTrade) => void;
}

type SortKey = 'closeTime' | 'netProfit' | 'symbol' | 'duration' | 'rMultiple' | 'volume';

export function TradeHistoryView({
  closedTrades,
  openPositions,
  accounts,
  symbols,
  strategies,
  filters,
  onFiltersChange,
  settings,
  onSelectTrade,
}: TradeHistoryViewProps) {
  const [sortKey, setSortKey] = useState<SortKey>('closeTime');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(1);
  const pageSize = 25;

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
    setPage(1);
  };

  const toggleExpand = (key: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const sortedTrades = useMemo(() => {
    const arr = [...closedTrades];
    arr.sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'closeTime') {
        cmp = new Date(a.closeTimeUtc).getTime() - new Date(b.closeTimeUtc).getTime();
      } else if (sortKey === 'netProfit') {
        cmp = a.netProfit - b.netProfit;
      } else if (sortKey === 'symbol') {
        cmp = a.symbol.localeCompare(b.symbol);
      } else if (sortKey === 'duration') {
        cmp = a.durationMinutes - b.durationMinutes;
      } else if (sortKey === 'rMultiple') {
        cmp = (a.rMultiple ?? -999) - (b.rMultiple ?? -999);
      } else if (sortKey === 'volume') {
        cmp = a.totalVolume - b.totalVolume;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return arr;
  }, [closedTrades, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sortedTrades.length / pageSize));
  const pagedTrades = sortedTrades.slice((page - 1) * pageSize, page * pageSize);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4 pb-4 border-b border-slate-200 dark:border-slate-800">
        <div>
          <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-slate-100">
            Trade History
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            One entry per closed MT5 Position ID · Expand partial-fill rows to inspect individual deal executions
          </p>
        </div>
        <button
          type="button"
          disabled={sortedTrades.length === 0}
          onClick={() => downloadTradesCsv(sortedTrades, settings)}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap"
        >
          <Download className="w-3.5 h-3.5" aria-hidden="true" />
          Export Filtered CSV ({sortedTrades.length})
        </button>
      </div>

      <FilterBar
        filters={filters}
        onChange={(next) => {
          onFiltersChange(next);
          setPage(1);
        }}
        accounts={accounts}
        symbols={symbols}
        strategies={strategies}
      />

      {/* Open Positions Compact Section */}
      {openPositions.length > 0 && (
        <section
          aria-label="Open MT5 positions"
          className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden"
        >
          <div className="px-4 py-2.5 bg-slate-50 dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
            <h2 className="text-xs font-semibold text-slate-800 dark:text-slate-200">
              Currently Open Positions ({openPositions.length}) — Incomplete Trades
            </h2>
            <span className="text-[11px] text-slate-500 dark:text-slate-400">
              Not counted in realised P/L until final close
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left">
              <thead className="text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800">
                <tr>
                  <th className="py-2 px-4 font-medium">Position</th>
                  <th className="py-2 px-3 font-medium">Symbol</th>
                  <th className="py-2 px-3 font-medium">Direction</th>
                  <th className="py-2 px-3 font-medium text-right">Volume</th>
                  <th className="py-2 px-3 font-medium text-right">Open Price</th>
                  <th className="py-2 px-3 font-medium text-right">Current Price</th>
                  <th className="py-2 px-3 font-medium text-right">SL / TP</th>
                  <th className="py-2 px-3 font-medium">Open Time</th>
                  <th className="py-2 px-4 font-medium text-right">Unrealised P/L</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {openPositions.map((p) => {
                  const net = p.unrealisedProfit + p.swap + p.commission;
                  return (
                    <tr key={`${p.accountId}-${p.ticket}`} className="text-slate-800 dark:text-slate-200">
                      <td className="py-2 px-4 font-mono tabular-nums">#{p.ticket}</td>
                      <td className="py-2 px-3 font-semibold">{p.symbol}</td>
                      <td
                        className={`py-2 px-3 font-medium ${
                          p.direction === 'BUY'
                            ? 'text-emerald-700 dark:text-emerald-400'
                            : 'text-red-700 dark:text-red-400'
                        }`}
                      >
                        {p.direction}
                      </td>
                      <td className="py-2 px-3 font-mono tabular-nums text-right">{p.volume.toFixed(2)}</td>
                      <td className="py-2 px-3 font-mono tabular-nums text-right">{p.openPrice}</td>
                      <td className="py-2 px-3 font-mono tabular-nums text-right">{p.currentPrice}</td>
                      <td className="py-2 px-3 font-mono tabular-nums text-right text-slate-500 dark:text-slate-400">
                        {p.sl ?? '—'} / {p.tp ?? '—'}
                      </td>
                      <td className="py-2 px-3 font-mono tabular-nums text-[11px] text-slate-500 dark:text-slate-400">
                        {formatTimestampWithServer(p.openTimeUtc, p.serverTimeRaw, p.serverTzLabel, settings)}
                      </td>
                      <td
                        className={`py-2 px-4 font-mono tabular-nums text-right font-semibold ${
                          net >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400'
                        }`}
                      >
                        {formatCurrency(net, settings, { signed: true })}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Closed Trades Table */}
      <section
        aria-label="Closed trades history table"
        className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden"
      >
        {sortedTrades.length === 0 ? (
          <div className="p-10 text-center text-xs text-slate-500 dark:text-slate-400">
            No closed trades match your active filters.
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left">
                <thead className="bg-slate-50 dark:bg-slate-950 text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800">
                  <tr>
                    <th className="py-2.5 pl-3 pr-1 w-8" aria-label="Expand fills" />
                    <th className="py-2.5 px-3 font-medium">Position ID</th>
                    <th className="py-2.5 px-3 font-medium">
                      <button
                        type="button"
                        onClick={() => toggleSort('symbol')}
                        className="inline-flex items-center gap-1 hover:text-slate-900 dark:hover:text-white whitespace-nowrap"
                      >
                        Symbol
                        <ArrowUpDown className="w-3 h-3" aria-hidden="true" />
                      </button>
                    </th>
                    <th className="py-2.5 px-3 font-medium">Side</th>
                    <th className="py-2.5 px-3 font-medium text-right">
                      <button
                        type="button"
                        onClick={() => toggleSort('volume')}
                        className="inline-flex items-center gap-1 hover:text-slate-900 dark:hover:text-white whitespace-nowrap"
                      >
                        Volume
                        <ArrowUpDown className="w-3 h-3" aria-hidden="true" />
                      </button>
                    </th>
                    <th className="py-2.5 px-3 font-medium text-right">Entry → Exit</th>
                    <th className="py-2.5 px-3 font-medium">
                      <button
                        type="button"
                        onClick={() => toggleSort('closeTime')}
                        className="inline-flex items-center gap-1 hover:text-slate-900 dark:hover:text-white whitespace-nowrap"
                      >
                        Exit Time
                        <ArrowUpDown className="w-3 h-3" aria-hidden="true" />
                      </button>
                    </th>
                    <th className="py-2.5 px-3 font-medium text-right">
                      <button
                        type="button"
                        onClick={() => toggleSort('duration')}
                        className="inline-flex items-center gap-1 hover:text-slate-900 dark:hover:text-white whitespace-nowrap"
                      >
                        Duration
                        <ArrowUpDown className="w-3 h-3" aria-hidden="true" />
                      </button>
                    </th>
                    <th className="py-2.5 px-3 font-medium">Strategy / Notes</th>
                    <th className="py-2.5 px-3 font-medium text-right">
                      <button
                        type="button"
                        onClick={() => toggleSort('rMultiple')}
                        className="inline-flex items-center gap-1 hover:text-slate-900 dark:hover:text-white whitespace-nowrap"
                      >
                        R-Mult
                        <ArrowUpDown className="w-3 h-3" aria-hidden="true" />
                      </button>
                    </th>
                    <th className="py-2.5 px-4 font-medium text-right">
                      <button
                        type="button"
                        onClick={() => toggleSort('netProfit')}
                        className="inline-flex items-center gap-1 hover:text-slate-900 dark:hover:text-white whitespace-nowrap"
                      >
                        Net P/L
                        <ArrowUpDown className="w-3 h-3" aria-hidden="true" />
                      </button>
                    </th>
                    <th className="py-2.5 pr-3 font-medium text-right">Journal</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {pagedTrades.map((t) => {
                    const expanded = expandedKeys.has(t.key);
                    return (
                      <React.Fragment key={t.key}>
                        <tr
                          onClick={() => onSelectTrade(t)}
                          className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/40 text-slate-800 dark:text-slate-200"
                        >
                          <td className="py-2.5 pl-3 pr-1">
                            <button
                              type="button"
                              onClick={(e) => toggleExpand(t.key, e)}
                              aria-label={expanded ? `Collapse fills for position ${t.positionId}` : `Expand fills for position ${t.positionId}`}
                              aria-expanded={expanded}
                              className="p-1 text-slate-400 hover:text-slate-800 dark:hover:text-white"
                            >
                              {expanded ? (
                                <ChevronDown className="w-3.5 h-3.5" />
                              ) : (
                                <ChevronRight className="w-3.5 h-3.5" />
                              )}
                            </button>
                          </td>
                          <td className="py-2.5 px-3 font-mono tabular-nums">
                            <div className="font-medium text-slate-900 dark:text-slate-100">
                              #{t.positionId}
                            </div>
                            <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate max-w-[130px]">
                              {t.accountName}
                            </div>
                          </td>
                          <td className="py-2.5 px-3 font-semibold text-slate-900 dark:text-slate-100">
                            <div>{t.symbol}</div>
                            {t.isPartial && (
                              <div className="text-[11px] font-normal text-slate-500 dark:text-slate-400">
                                {t.entryFillsCount} in · {t.exitFillsCount} out
                              </div>
                            )}
                          </td>
                          <td
                            className={`py-2.5 px-3 font-medium ${
                              t.direction === 'BUY'
                                ? 'text-emerald-700 dark:text-emerald-400'
                                : 'text-red-700 dark:text-red-400'
                            }`}
                          >
                            {t.direction}
                          </td>
                          <td className="py-2.5 px-3 font-mono tabular-nums text-right">
                            {t.totalVolume.toFixed(2)}
                          </td>
                          <td className="py-2.5 px-3 font-mono tabular-nums text-right text-slate-700 dark:text-slate-300">
                            {t.weightedEntryPrice} → {t.weightedExitPrice}
                          </td>
                          <td className="py-2.5 px-3 font-mono tabular-nums text-[11px] text-slate-600 dark:text-slate-400">
                            {formatTimestampWithServer(
                              t.closeTimeUtc,
                              t.closeServerTimeRaw,
                              t.closeServerTzLabel,
                              settings,
                            )}
                          </td>
                          <td className="py-2.5 px-3 font-mono tabular-nums text-right text-slate-600 dark:text-slate-400">
                            {formatDuration(t.durationMinutes)}
                          </td>
                          <td className="py-2.5 px-3 max-w-[200px]">
                            <div className="font-medium text-slate-800 dark:text-slate-200 truncate">
                              {t.journal?.strategy || 'Untagged'}
                            </div>
                            <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                              {t.journal?.notes || t.session}
                            </div>
                          </td>
                          <td className="py-2.5 px-3 font-mono tabular-nums text-right">
                            {t.rMultiple !== null
                              ? `${t.rMultiple >= 0 ? '+' : ''}${t.rMultiple.toFixed(2)}R`
                              : '—'}
                          </td>
                          <td
                            className={`py-2.5 px-4 font-mono tabular-nums text-right font-semibold ${
                              t.netProfit > 0
                                ? 'text-emerald-700 dark:text-emerald-400'
                                : t.netProfit < 0
                                  ? 'text-red-700 dark:text-red-400'
                                  : 'text-slate-600 dark:text-slate-400'
                            }`}
                          >
                            <div>{formatCurrency(t.netProfit, settings, { signed: true })}</div>
                            <div className="text-[10px] font-normal text-slate-500 dark:text-slate-400">
                              Fees {formatCurrency(t.commission + t.swap, settings, { signed: true })}
                            </div>
                          </td>
                          <td className="py-2.5 pr-3 text-right">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onSelectTrade(t);
                              }}
                              aria-label={`Edit journal for position ${t.positionId}`}
                              className="p-1.5 text-slate-500 hover:text-blue-700 dark:text-slate-400 dark:hover:text-blue-400"
                            >
                              <FileEdit className="w-3.5 h-3.5" />
                            </button>
                          </td>
                        </tr>

                        {expanded && (
                          <tr className="bg-slate-50/70 dark:bg-slate-950/60">
                            <td colSpan={12} className="px-8 py-3">
                              <p className="text-[11px] font-semibold text-slate-600 dark:text-slate-300 mb-2">
                                Underlying MT5 Deal Fills for Position #{t.positionId} ({t.deals.length} events)
                              </p>
                              <div className="overflow-x-auto">
                                <table className="w-full text-[11px]">
                                  <thead className="text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800">
                                    <tr>
                                      <th className="py-1.5 pr-3 text-left font-medium">Deal Ticket</th>
                                      <th className="py-1.5 px-3 text-left font-medium">Entry / Type</th>
                                      <th className="py-1.5 px-3 text-left font-medium">Timestamp (Local & Server)</th>
                                      <th className="py-1.5 px-3 text-right font-medium">Volume</th>
                                      <th className="py-1.5 px-3 text-right font-medium">Fill Price</th>
                                      <th className="py-1.5 px-3 text-right font-medium">Gross</th>
                                      <th className="py-1.5 px-3 text-right font-medium">Comm / Swap</th>
                                      <th className="py-1.5 pl-3 text-left font-medium">Comment</th>
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y divide-slate-200/60 dark:divide-slate-800/60">
                                    {t.deals.map((d) => (
                                      <tr key={d.ticket} className="text-slate-700 dark:text-slate-300">
                                        <td className="py-1.5 pr-3 font-mono tabular-nums">#{d.ticket}</td>
                                        <td className="py-1.5 px-3">
                                          {d.dealEntry.replace('DEAL_ENTRY_', '')} · {d.dealType.replace('DEAL_TYPE_', '')}
                                        </td>
                                        <td className="py-1.5 px-3 font-mono tabular-nums">
                                          {formatTimestampWithServer(d.utcTime, d.serverTimeRaw, d.serverTzLabel, settings)}
                                        </td>
                                        <td className="py-1.5 px-3 font-mono tabular-nums text-right">
                                          {d.volume.toFixed(2)}
                                        </td>
                                        <td className="py-1.5 px-3 font-mono tabular-nums text-right">{d.price}</td>
                                        <td className="py-1.5 px-3 font-mono tabular-nums text-right">
                                          {formatCurrency(d.profit, settings, { signed: true })}
                                        </td>
                                        <td className="py-1.5 px-3 font-mono tabular-nums text-right">
                                          {formatCurrency(d.commission, settings, { signed: true })} /{' '}
                                          {formatCurrency(d.swap, settings, { signed: true })}
                                        </td>
                                        <td className="py-1.5 pl-3 text-slate-500 dark:text-slate-400">
                                          {d.comment || '—'}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {totalPages > 1 && (
              <div className="flex items-center justify-between px-4 py-3 border-t border-slate-200 dark:border-slate-800 text-xs text-slate-600 dark:text-slate-400">
                <span>
                  Showing {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, sortedTrades.length)} of{' '}
                  {sortedTrades.length} trades
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={page === 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    className="px-2.5 py-1 rounded border border-slate-300 dark:border-slate-700 disabled:opacity-40"
                  >
                    Previous
                  </button>
                  <span className="font-mono">
                    {page} / {totalPages}
                  </span>
                  <button
                    type="button"
                    disabled={page === totalPages}
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    className="px-2.5 py-1 rounded border border-slate-300 dark:border-slate-700 disabled:opacity-40"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
