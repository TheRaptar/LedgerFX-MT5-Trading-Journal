import React from 'react';
import { RotateCcw, Search } from 'lucide-react';
import type { FilterState, MT5Account } from '../shared/types.ts';

interface FilterBarProps {
  filters: FilterState;
  onChange: (next: FilterState) => void;
  accounts: MT5Account[];
  symbols: string[];
  strategies: string[];
  showSearch?: boolean;
}

export const EMPTY_FILTERS: FilterState = {
  accountId: 'all',
  symbol: 'all',
  strategy: 'all',
  session: 'all',
  outcome: 'all',
  dateFrom: '',
  dateTo: '',
  search: '',
};

export function FilterBar({
  filters,
  onChange,
  accounts,
  symbols,
  strategies,
  showSearch = true,
}: FilterBarProps) {
  const hasActiveFilter =
    filters.accountId !== 'all' ||
    filters.symbol !== 'all' ||
    filters.strategy !== 'all' ||
    filters.session !== 'all' ||
    filters.outcome !== 'all' ||
    Boolean(filters.dateFrom) ||
    Boolean(filters.dateTo) ||
    Boolean(filters.search.trim());

  const update = <K extends keyof FilterState>(key: K, value: FilterState[K]) => {
    onChange({ ...filters, [key]: value });
  };

  return (
    <div
      className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-3.5"
      role="region"
      aria-label="Trade and analytics filters"
    >
      <div className="flex flex-wrap items-center gap-2.5">
        {showSearch && (
          <div className="relative flex-1 min-w-[180px] max-w-xs">
            <Search
              className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
              aria-hidden="true"
            />
            <input
              type="search"
              value={filters.search}
              onChange={(e) => update('search', e.target.value)}
              placeholder="Search symbol, ID, notes..."
              aria-label="Search trades"
              className="w-full pl-8 pr-3 py-1.5 text-xs rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
            />
          </div>
        )}

        <select
          aria-label="Filter by MT5 account"
          value={filters.accountId}
          onChange={(e) => update('accountId', e.target.value)}
          className="px-2.5 py-1.5 text-xs rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
        >
          <option value="all">All MT5 Accounts</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.friendlyName} (#{a.accountLogin})
            </option>
          ))}
        </select>

        <select
          aria-label="Filter by symbol"
          value={filters.symbol}
          onChange={(e) => update('symbol', e.target.value)}
          className="px-2.5 py-1.5 text-xs rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
        >
          <option value="all">All Symbols</option>
          {symbols.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>

        <select
          aria-label="Filter by strategy"
          value={filters.strategy}
          onChange={(e) => update('strategy', e.target.value)}
          className="px-2.5 py-1.5 text-xs rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
        >
          <option value="all">All Strategies</option>
          {strategies.map((st) => (
            <option key={st} value={st}>
              {st}
            </option>
          ))}
        </select>

        <select
          aria-label="Filter by market session"
          value={filters.session}
          onChange={(e) => update('session', e.target.value)}
          className="px-2.5 py-1.5 text-xs rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
        >
          <option value="all">All Sessions</option>
          <option value="Asia">Asia</option>
          <option value="London">London</option>
          <option value="London/NY Overlap">London/NY Overlap</option>
          <option value="New York">New York</option>
          <option value="Off-Hours">Off-Hours</option>
        </select>

        <select
          aria-label="Filter by trade outcome"
          value={filters.outcome}
          onChange={(e) => update('outcome', e.target.value as FilterState['outcome'])}
          className="px-2.5 py-1.5 text-xs rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
        >
          <option value="all">All Outcomes</option>
          <option value="win">Winning Trades</option>
          <option value="loss">Losing Trades</option>
          <option value="breakeven">Break-Even</option>
        </select>

        <div className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
          <input
            type="date"
            aria-label="Filter from date"
            value={filters.dateFrom}
            onChange={(e) => update('dateFrom', e.target.value)}
            className="px-2 py-1.5 text-xs font-mono rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-100"
          />
          <span aria-hidden="true">–</span>
          <input
            type="date"
            aria-label="Filter to date"
            value={filters.dateTo}
            onChange={(e) => update('dateTo', e.target.value)}
            className="px-2 py-1.5 text-xs font-mono rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-100"
          />
        </div>

        {hasActiveFilter && (
          <button
            type="button"
            onClick={() => onChange(EMPTY_FILTERS)}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white border border-slate-200 dark:border-slate-700 rounded-md hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
          >
            <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
            Reset
          </button>
        )}
      </div>
    </div>
  );
}
