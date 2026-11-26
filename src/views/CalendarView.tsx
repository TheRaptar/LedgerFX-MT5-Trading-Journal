import React, { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Plus, Trash2 } from 'lucide-react';
import type {
  CalendarEventMarker,
  ClosedTrade,
  DailyJournalEntry,
  UserSettings,
} from '../shared/types.ts';
import { formatCurrency, getIsoDayInZone } from '../shared/timeUtils.ts';

interface CalendarViewProps {
  closedTrades: ClosedTrade[];
  dailyJournals: DailyJournalEntry[];
  calendarEvents: CalendarEventMarker[];
  settings: UserSettings;
  onOpenDayJournal: (date: string) => void;
  onAddEvent: (ev: Omit<CalendarEventMarker, 'id'>) => Promise<void>;
  onDeleteEvent: (id: string) => Promise<void>;
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function CalendarView({
  closedTrades,
  dailyJournals,
  calendarEvents,
  settings,
  onOpenDayJournal,
  onAddEvent,
  onDeleteEvent,
}: CalendarViewProps) {
  const [cursor, setCursor] = useState(() => new Date(Date.UTC(2026, 10, 1))); // Nov 2026
  const [showAddEvent, setShowAddEvent] = useState(false);
  const [evDate, setEvDate] = useState('2026-11-21');
  const [evTitle, setEvTitle] = useState('');
  const [evCategory, setEvCategory] = useState<CalendarEventMarker['category']>('News Announcement');
  const [evImpact, setEvImpact] = useState<CalendarEventMarker['impact']>('High');
  const [evNotes, setEvNotes] = useState('');

  const year = cursor.getUTCFullYear();
  const month = cursor.getUTCMonth();

  const dayMap = useMemo(() => {
    const map = new Map<string, { pnl: number; count: number }>();
    for (const t of closedTrades) {
      const day = getIsoDayInZone(t.closeTimeUtc, settings.displayTimeZone);
      const cur = map.get(day) ?? { pnl: 0, count: 0 };
      cur.pnl += t.netProfit;
      cur.count += 1;
      map.set(day, cur);
    }
    return map;
  }, [closedTrades, settings.displayTimeZone]);

  const journalDates = useMemo(() => new Set(dailyJournals.map((d) => d.date)), [dailyJournals]);

  const eventsByDate = useMemo(() => {
    const map = new Map<string, CalendarEventMarker[]>();
    for (const ev of calendarEvents) {
      const list = map.get(ev.date) ?? [];
      list.push(ev);
      map.set(ev.date, list);
    }
    return map;
  }, [calendarEvents]);

  // Build Monday-first calendar grid
  const firstDayOfMonth = new Date(Date.UTC(year, month, 1));
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const mondayStartOffset = (firstDayOfMonth.getUTCDay() + 6) % 7;

  const cells: Array<{ iso: string | null; dayNum: number | null }> = [];
  for (let i = 0; i < mondayStartOffset; i++) cells.push({ iso: null, dayNum: null });
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    cells.push({ iso, dayNum: d });
  }
  while (cells.length % 7 !== 0) cells.push({ iso: null, dayNum: null });

  const monthTitle = firstDayOfMonth.toLocaleDateString('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

  const monthEvents = calendarEvents.filter((e) =>
    e.date.startsWith(`${year}-${String(month + 1).padStart(2, '0')}`),
  );

  async function handleAddEvent(e: React.FormEvent) {
    e.preventDefault();
    if (!evTitle.trim()) return;
    try {
      await onAddEvent({
        date: evDate,
        title: evTitle.trim(),
        category: evCategory,
        impact: evImpact,
        notes: evNotes.trim(),
      });
      setEvTitle('');
      setEvNotes('');
      setShowAddEvent(false);
    } catch {
      // Handled globally by App banner / auth gate
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4 pb-4 border-b border-slate-200 dark:border-slate-800">
        <div>
          <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-slate-100">
            Trading Calendar & Schedule
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Daily P/L heatmap and macro news event markers · Click any day to open its Daily Journal
          </p>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md p-1">
            <button
              type="button"
              aria-label="Previous month"
              onClick={() => setCursor(new Date(Date.UTC(year, month - 1, 1)))}
              className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="px-3 text-xs font-semibold text-slate-900 dark:text-slate-100 min-w-[130px] text-center">
              {monthTitle}
            </span>
            <button
              type="button"
              aria-label="Next month"
              onClick={() => setCursor(new Date(Date.UTC(year, month + 1, 1)))}
              className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>

          <button
            type="button"
            onClick={() => setShowAddEvent((v) => !v)}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-md bg-slate-900 dark:bg-blue-600 text-white hover:bg-slate-800 dark:hover:bg-blue-500 whitespace-nowrap"
          >
            <Plus className="w-3.5 h-3.5" aria-hidden="true" />
            Add Event Marker
          </button>
        </div>
      </div>

      {showAddEvent && (
        <form
          onSubmit={handleAddEvent}
          className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-3"
        >
          <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
            Create Calendar Event Marker
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
            <input
              type="date"
              required
              value={evDate}
              onChange={(e) => setEvDate(e.target.value)}
              className="px-3 py-2 text-xs font-mono rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
            />
            <input
              required
              value={evTitle}
              onChange={(e) => setEvTitle(e.target.value)}
              placeholder="e.g. BoE Rate Decision / NFP"
              className="px-3 py-2 text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
            />
            <select
              value={evCategory}
              onChange={(e) => setEvCategory(e.target.value as CalendarEventMarker['category'])}
              className="px-3 py-2 text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
            >
              <option value="News Announcement">News Announcement</option>
              <option value="Session Note">Session Note</option>
              <option value="Personal Reminder">Personal Reminder</option>
              <option value="Broker Notice">Broker Notice</option>
            </select>
            <select
              value={evImpact}
              onChange={(e) => setEvImpact(e.target.value as CalendarEventMarker['impact'])}
              className="px-3 py-2 text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
            >
              <option value="High">High Impact</option>
              <option value="Medium">Medium Impact</option>
              <option value="Low">Low Impact</option>
            </select>
          </div>
          <input
            value={evNotes}
            onChange={(e) => setEvNotes(e.target.value)}
            placeholder="Context or risk plan note..."
            className="w-full px-3 py-2 text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowAddEvent(false)}
              className="px-3 py-1.5 text-xs rounded-md border border-slate-300 dark:border-slate-700"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-1.5 text-xs font-medium rounded-md bg-slate-900 dark:bg-blue-600 text-white"
            >
              Save Marker
            </button>
          </div>
        </form>
      )}

      {/* Calendar Grid */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
        <div className="grid grid-cols-7 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950">
          {WEEKDAYS.map((w) => (
            <div
              key={w}
              className="py-2.5 px-3 text-xs font-semibold text-slate-600 dark:text-slate-400 text-center"
            >
              {w}
            </div>
          ))}
        </div>

        <div className="grid grid-cols-7 divide-x divide-y divide-slate-200 dark:divide-slate-800">
          {cells.map((cell, idx) => {
            if (!cell.iso || !cell.dayNum) {
              return <div key={idx} className="min-h-[104px] bg-slate-50/50 dark:bg-slate-950/40" />;
            }
            const stats = dayMap.get(cell.iso);
            const hasJournal = journalDates.has(cell.iso);
            const evs = eventsByDate.get(cell.iso) ?? [];

            const bgTone =
              stats && stats.pnl > 0
                ? 'bg-emerald-50/70 dark:bg-emerald-950/25'
                : stats && stats.pnl < 0
                  ? 'bg-red-50/70 dark:bg-red-950/25'
                  : 'bg-white dark:bg-slate-900';

            return (
              <button
                key={cell.iso}
                type="button"
                onClick={() => onOpenDayJournal(cell.iso!)}
                aria-label={`${cell.iso}: ${stats ? `${stats.count} trades, ${formatCurrency(stats.pnl, settings, { signed: true })}` : 'No trades'}`}
                className={`min-h-[104px] p-2.5 text-left flex flex-col justify-between hover:bg-slate-100/70 dark:hover:bg-slate-800/60 transition-colors focus-visible:outline-2 focus-visible:outline-blue-600 ${bgTone}`}
              >
                <div className="flex items-center justify-between w-full">
                  <span className="font-mono text-xs font-semibold text-slate-800 dark:text-slate-200">
                    {cell.dayNum}
                  </span>
                  {hasJournal && (
                    <span className="text-[10px] text-blue-700 dark:text-blue-400 font-medium">
                      Logged
                    </span>
                  )}
                </div>

                <div className="space-y-1 my-1">
                  {stats && (
                    <div>
                      <p
                        className={`font-mono tabular-nums text-xs font-bold ${
                          stats.pnl >= 0
                            ? 'text-emerald-700 dark:text-emerald-400'
                            : 'text-red-700 dark:text-red-400'
                        }`}
                      >
                        {formatCurrency(stats.pnl, settings, { signed: true })}
                      </p>
                      <p className="text-[10px] text-slate-500 dark:text-slate-400">
                        {stats.count} {stats.count === 1 ? 'trade' : 'trades'}
                      </p>
                    </div>
                  )}
                  {evs.slice(0, 2).map((ev) => (
                    <p
                      key={ev.id}
                      className="text-[10px] text-amber-800 dark:text-amber-300 truncate font-medium"
                    >
                      {ev.title}
                    </p>
                  ))}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Scheduled Events List for Active Month */}
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-200 dark:border-slate-800">
          <h2 className="text-xs font-semibold text-slate-800 dark:text-slate-200">
            Event Markers & Reminders in {monthTitle} ({monthEvents.length})
          </h2>
        </div>
        {monthEvents.length === 0 ? (
          <p className="p-5 text-xs text-slate-500 dark:text-slate-400">
            No macro news markers or personal reminders scheduled for this month.
          </p>
        ) : (
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {monthEvents.map((ev) => (
              <div
                key={ev.id}
                className="px-5 py-3 flex items-center justify-between gap-4 text-xs"
              >
                <div>
                  <div className="flex items-center gap-2 text-slate-500 dark:text-slate-400">
                    <span className="font-mono font-semibold text-slate-800 dark:text-slate-200">
                      {ev.date}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>{ev.category}</span>
                    <span aria-hidden="true">·</span>
                    <span>{ev.impact} Impact</span>
                  </div>
                  <p className="font-medium text-slate-900 dark:text-slate-100 mt-0.5">{ev.title}</p>
                  {ev.notes && <p className="text-slate-500 dark:text-slate-400 mt-0.5">{ev.notes}</p>}
                </div>
                <button
                  type="button"
                  onClick={() => onDeleteEvent(ev.id)}
                  aria-label={`Delete event ${ev.title}`}
                  className="p-1.5 text-slate-400 hover:text-red-600 dark:hover:text-red-400"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
