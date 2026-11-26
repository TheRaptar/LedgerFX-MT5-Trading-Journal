import React, { useMemo, useState } from 'react';
import { FileEdit, Search } from 'lucide-react';
import type { ClosedTrade, UserSettings } from '../shared/types.ts';
import { formatCurrency, formatTimestampWithServer } from '../shared/timeUtils.ts';

interface JournalViewProps {
  closedTrades: ClosedTrade[];
  settings: UserSettings;
  onSelectTrade: (trade: ClosedTrade) => void;
}

export function JournalView({ closedTrades, settings, onSelectTrade }: JournalViewProps) {
  const [filterMode, setFilterMode] = useState<'all' | 'journalled' | 'needs_review'>('all');
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    return closedTrades.filter((t) => {
      const hasNotes = Boolean(
        t.journal && (t.journal.strategy || t.journal.rationale || t.journal.notes),
      );
      if (filterMode === 'journalled' && !hasNotes) return false;
      if (filterMode === 'needs_review' && hasNotes) return false;
      if (query.trim()) {
        const q = query.toLowerCase();
        const hay = [
          String(t.positionId),
          t.symbol,
          t.journal?.strategy ?? '',
          (t.journal?.tags ?? []).join(' '),
          t.journal?.rationale ?? '',
          t.journal?.emotions ?? '',
          t.journal?.mistakes ?? '',
          t.journal?.notes ?? '',
        ]
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [closedTrades, filterMode, query]);

  const reviewedCount = closedTrades.filter(
    (t) => t.journal && (t.journal.strategy || t.journal.rationale || t.journal.notes),
  ).length;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4 pb-4 border-b border-slate-200 dark:border-slate-800">
        <div>
          <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-slate-100">
            Trade Journal
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            {reviewedCount} of {closedTrades.length} closed trades annotated · Record strategy, initial risk, mistakes, and lessons
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="relative">
            <Search
              className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2"
              aria-hidden="true"
            />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search notes, strategy, mistakes..."
              aria-label="Search journal entries"
              className="pl-8 pr-3 py-1.5 text-xs rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 w-60"
            />
          </div>

          <div
            role="group"
            aria-label="Filter trade journal status"
            className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg"
          >
            {(
              [
                ['all', `All (${closedTrades.length})`],
                ['needs_review', `Needs Review (${closedTrades.length - reviewedCount})`],
                ['journalled', `Reviewed (${reviewedCount})`],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setFilterMode(key)}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                  filterMode === key
                    ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-10 text-center text-xs text-slate-500 dark:text-slate-400">
          No trades match this journal filter.
        </div>
      ) : (
        <div className="divide-y divide-slate-200 dark:divide-slate-800 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
          {filtered.map((t) => {
            const j = t.journal;
            return (
              <article
                key={t.key}
                className="p-5 hover:bg-slate-50/70 dark:hover:bg-slate-800/30 transition-colors"
              >
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                      <span className="font-mono">#{t.positionId}</span>
                      <span aria-hidden="true">·</span>
                      <span>{t.accountName}</span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono tabular-nums">
                        {formatTimestampWithServer(
                          t.closeTimeUtc,
                          t.closeServerTimeRaw,
                          t.closeServerTzLabel,
                          settings,
                        )}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>{t.session}</span>
                    </div>

                    <div className="flex flex-wrap items-baseline gap-3">
                      <h2 className="font-display text-base font-bold text-slate-900 dark:text-slate-100">
                        {t.symbol} {t.direction} ({t.totalVolume.toFixed(2)} lots)
                      </h2>
                      <span
                        className={`font-mono tabular-nums text-sm font-semibold ${
                          t.netProfit > 0
                            ? 'text-emerald-700 dark:text-emerald-400'
                            : t.netProfit < 0
                              ? 'text-red-700 dark:text-red-400'
                              : 'text-slate-600 dark:text-slate-400'
                        }`}
                      >
                        {formatCurrency(t.netProfit, settings, { signed: true })}
                      </span>
                      {t.rMultiple !== null && (
                        <span className="font-mono tabular-nums text-xs text-slate-600 dark:text-slate-400">
                          {t.rMultiple >= 0 ? '+' : ''}
                          {t.rMultiple.toFixed(2)}R
                        </span>
                      )}
                      <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
                        · {j?.strategy || 'Strategy Untagged'}
                      </span>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => onSelectTrade(t)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap"
                  >
                    <FileEdit className="w-3.5 h-3.5" aria-hidden="true" />
                    {j?.notes || j?.rationale ? 'Edit Notes' : 'Add Review'}
                  </button>
                </div>

                {j && (j.rationale || j.emotions || j.mistakes || j.notes || j.tags.length > 0) ? (
                  <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-4 text-xs text-slate-600 dark:text-slate-300">
                    <div>
                      <p className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                        Rationale
                      </p>
                      <p className="mt-0.5 leading-relaxed">{j.rationale || '—'}</p>
                    </div>
                    <div>
                      <p className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                        Emotions & Mistakes
                      </p>
                      <p className="mt-0.5 leading-relaxed">
                        {j.emotions || '—'}
                        {j.mistakes ? ` · Mistakes: ${j.mistakes}` : ''}
                      </p>
                    </div>
                    <div>
                      <p className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                        Post-Trade Notes
                      </p>
                      <p className="mt-0.5 leading-relaxed">{j.notes || '—'}</p>
                    </div>
                  </div>
                ) : (
                  <p className="mt-2.5 text-xs text-slate-400 dark:text-slate-500 italic">
                    No post-trade review recorded yet. Click "Add Review" to assign strategy, initial risk, and lessons.
                  </p>
                )}

                {j && j.tags.length > 0 && (
                  <p className="mt-2.5 text-[11px] text-slate-500 dark:text-slate-400">
                    Tags: {j.tags.join(' · ')}
                  </p>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
