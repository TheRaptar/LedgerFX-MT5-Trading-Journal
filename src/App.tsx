import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  LayoutDashboard,
  Landmark,
  History,
  BookOpen,
  NotebookPen,
  BarChart3,
  Sparkles,
  CalendarDays,
  FileSpreadsheet,
  Settings,
  RefreshCw,
  HelpCircle,
  LogOut,
  Menu,
  X,
  Sun,
  Moon,
} from 'lucide-react';
import {
  DEFAULT_SETTINGS,
  type BootstrapPayload,
  type CalendarEventMarker,
  type ClosedTrade,
  type DailyJournalEntry,
  type FilterState,
  type PeriodicReview,
  type TradeJournalEntry,
  type UserSettings,
} from './shared/types.ts';
import { buildClosedTrades } from './shared/mt5Engine.ts';
import { computePerformanceMetrics } from './shared/metricsEngine.ts';
import { getIsoDayInZone } from './shared/timeUtils.ts';
import {
  api,
  setAuthToken,
  setUnauthorizedHandler,
  type AuthStatusResponse,
} from './lib/api.ts';
import { AuthGate } from './components/AuthGate.tsx';
import { EMPTY_FILTERS } from './components/FilterBar.tsx';
import { TradeDetailDrawer } from './components/TradeDetailDrawer.tsx';
import { OnboardingModal } from './components/OnboardingModal.tsx';
import { DashboardView } from './views/DashboardView.tsx';
import { AccountsView } from './views/AccountsView.tsx';
import { TradeHistoryView } from './views/TradeHistoryView.tsx';
import { JournalView } from './views/JournalView.tsx';
import { DailyJournalView } from './views/DailyJournalView.tsx';
import { AnalyticsView } from './views/AnalyticsView.tsx';
import { AIInsightsView } from './views/AIInsightsView.tsx';
import { CalendarView } from './views/CalendarView.tsx';
import { ReportsView } from './views/ReportsView.tsx';
import { SettingsView } from './views/SettingsView.tsx';

type NavKey =
  | 'dashboard'
  | 'accounts'
  | 'history'
  | 'journal'
  | 'daily'
  | 'analytics'
  | 'ai'
  | 'calendar'
  | 'reports'
  | 'settings';

const NAV_ITEMS: Array<{ key: NavKey; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { key: 'accounts', label: 'Accounts', icon: Landmark },
  { key: 'history', label: 'Trade History', icon: History },
  { key: 'journal', label: 'Journal', icon: BookOpen },
  { key: 'daily', label: 'Daily Journal', icon: NotebookPen },
  { key: 'analytics', label: 'Analytics', icon: BarChart3 },
  { key: 'ai', label: 'AI Insights', icon: Sparkles },
  { key: 'calendar', label: 'Calendar', icon: CalendarDays },
  { key: 'reports', label: 'Reports', icon: FileSpreadsheet },
  { key: 'settings', label: 'Settings', icon: Settings },
];

export default function App() {
  const [authStatus, setAuthStatus] = useState<AuthStatusResponse | null>(null);
  const [isUnlocked, setIsUnlocked] = useState(false);
  const [data, setData] = useState<BootstrapPayload | null>(null);
  const [loadingData, setLoadingData] = useState(false);

  const [activeTab, setActiveTab] = useState<NavKey>('dashboard');
  const [openLinkFormOnAccounts, setOpenLinkFormOnAccounts] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
  const [selectedTradeKey, setSelectedTradeKey] = useState<string | null>(null);
  const [selectedDailyDate, setSelectedDailyDate] = useState('2026-11-18');
  const [showOnboarding, setShowOnboarding] = useState(false);

  const [syncingAccountId, setSyncingAccountId] = useState<string | null>(null);
  const [syncingAll, setSyncingAll] = useState(false);
  const [banner, setBanner] = useState<{ type: 'info' | 'error'; text: string } | null>(null);

  const settings = data?.settings ?? DEFAULT_SETTINGS;

  // Apply theme & font-size accessibility classes cleanly to <html>
  useEffect(() => {
    const html = document.documentElement;
    html.classList.toggle('dark', settings.theme === 'dark');
    html.classList.remove('font-size-sm', 'font-size-md', 'font-size-lg');
    html.classList.add(`font-size-${settings.fontSize || 'md'}`);
  }, [settings.theme, settings.fontSize]);

  const checkAuth = useCallback(async () => {
    try {
      const status = await api.getAuthStatus();
      setAuthStatus(status);
      setIsUnlocked(status.authenticated);
    } catch {
      setAuthStatus({
        initialized: false,
        envProtected: false,
        authenticated: false,
        sessionTimeoutMinutes: 60,
      });
    }
  }, []);

  const loadBootstrap = useCallback(async () => {
    setLoadingData(true);
    try {
      const payload = await api.bootstrap();
      setData(payload);
    } catch (err) {
      setBanner({
        type: 'error',
        text: err instanceof Error ? err.message : 'Unable to load trading journal data.',
      });
    } finally {
      setLoadingData(false);
    }
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setIsUnlocked(false);
      setData(null);
      checkAuth();
    });
    checkAuth();
  }, [checkAuth]);

  useEffect(() => {
    if (isUnlocked && !data) {
      loadBootstrap();
    }
  }, [isUnlocked, data, loadBootstrap]);

  // Reconstruct all closed trades from raw MT5 deals grouped by Position ID
  const { closedTrades: allClosedTrades } = useMemo(() => {
    if (!data) return { closedTrades: [], unsupportedDealNotices: [] };
    return buildClosedTrades(
      data.deals,
      data.accounts,
      data.journals,
      data.openPositions,
      data.settings,
    );
  }, [data]);

  const availableSymbols = useMemo(
    () => Array.from(new Set(allClosedTrades.map((t) => t.symbol))).sort(),
    [allClosedTrades],
  );

  const availableStrategies = useMemo(() => {
    const set = new Set<string>();
    for (const t of allClosedTrades) {
      set.add(t.journal?.strategy?.trim() || 'Untagged');
    }
    return Array.from(set).sort();
  }, [allClosedTrades]);

  // Apply real-time filters
  const filteredClosedTrades = useMemo(() => {
    return allClosedTrades.filter((t) => {
      if (filters.accountId !== 'all' && t.accountId !== filters.accountId) return false;
      if (filters.symbol !== 'all' && t.symbol !== filters.symbol) return false;
      const strat = t.journal?.strategy?.trim() || 'Untagged';
      if (filters.strategy !== 'all' && strat !== filters.strategy) return false;
      if (filters.session !== 'all' && t.session !== filters.session) return false;
      if (filters.outcome !== 'all' && t.outcome !== filters.outcome) return false;
      const day = getIsoDayInZone(t.closeTimeUtc, settings.displayTimeZone);
      if (filters.dateFrom && day < filters.dateFrom) return false;
      if (filters.dateTo && day > filters.dateTo) return false;
      if (filters.search.trim()) {
        const q = filters.search.toLowerCase();
        const hay = [
          String(t.positionId),
          t.symbol,
          t.direction,
          t.accountName,
          strat,
          (t.journal?.tags ?? []).join(' '),
          t.journal?.notes ?? '',
          t.journal?.rationale ?? '',
        ]
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [allClosedTrades, filters, settings.displayTimeZone]);

  const filteredOpenPositions = useMemo(() => {
    if (!data) return [];
    return data.openPositions.filter((p) => {
      if (filters.accountId !== 'all' && p.accountId !== filters.accountId) return false;
      if (filters.symbol !== 'all' && p.symbol !== filters.symbol) return false;
      return true;
    });
  }, [data, filters.accountId, filters.symbol]);

  const filteredBalanceOps = useMemo(() => {
    if (!data) return [];
    return data.balanceOperations.filter((op) => {
      if (filters.accountId !== 'all' && op.accountId !== filters.accountId) return false;
      const day = getIsoDayInZone(op.utcTime, settings.displayTimeZone);
      if (filters.dateFrom && day < filters.dateFrom) return false;
      if (filters.dateTo && day > filters.dateTo) return false;
      return true;
    });
  }, [data, filters.accountId, filters.dateFrom, filters.dateTo, settings.displayTimeZone]);

  const filteredAccounts = useMemo(() => {
    if (!data) return [];
    return filters.accountId === 'all'
      ? data.accounts
      : data.accounts.filter((a) => a.id === filters.accountId);
  }, [data, filters.accountId]);

  const computedMetrics = useMemo(() => {
    return computePerformanceMetrics(
      filteredClosedTrades,
      filteredBalanceOps,
      filteredOpenPositions,
      filteredAccounts,
      settings,
    );
  }, [filteredClosedTrades, filteredBalanceOps, filteredOpenPositions, filteredAccounts, settings]);

  const selectedTrade: ClosedTrade | null = useMemo(() => {
    if (!selectedTradeKey) return null;
    return allClosedTrades.find((t) => t.key === selectedTradeKey) ?? null;
  }, [allClosedTrades, selectedTradeKey]);

  const handleRefreshBootstrap = useCallback((payload?: unknown) => {
    if (payload && typeof payload === 'object' && 'accounts' in payload) {
      setData(payload as BootstrapPayload);
    } else {
      loadBootstrap();
    }
  }, [loadBootstrap]);

  async function handleSyncSingleAccount(
    accountId: string,
    opts?: { mode?: 'incremental' | 'reimport'; simulatePartialFailure?: boolean },
  ) {
    setSyncingAccountId(accountId);
    setBanner(null);
    try {
      const res = await api.syncAccount(accountId, opts);
      setData(res.payload);
      setBanner({ type: 'info', text: res.message });
    } catch (err) {
      const e = err as Error & { payload?: BootstrapPayload };
      if (e.payload) setData(e.payload);
      setBanner({ type: 'error', text: e.message || 'Synchronisation failed.' });
    } finally {
      setSyncingAccountId(null);
    }
  }

  async function handleSyncAllActive() {
    if (!data || data.accounts.length === 0 || syncingAll) return;
    setSyncingAll(true);
    setBanner(null);
    const targets =
      filters.accountId === 'all'
        ? data.accounts
        : data.accounts.filter((a) => a.id === filters.accountId);
    try {
      let lastMessage = 'All linked MT5 accounts synchronised.';
      let latestPayload = data;
      for (const acc of targets) {
        const res = await api.syncAccount(acc.id, { mode: 'incremental' });
        latestPayload = res.payload;
        lastMessage = `${acc.friendlyName}: ${res.message}`;
      }
      setData(latestPayload);
      setBanner({
        type: 'info',
        text:
          targets.length > 1
            ? `Synchronised ${targets.length} MT5 accounts cleanly (idempotent check passed).`
            : lastMessage,
      });
    } catch (err) {
      setBanner({
        type: 'error',
        text: err instanceof Error ? err.message : 'MT5 synchronisation error.',
      });
    } finally {
      setSyncingAll(false);
    }
  }

  async function handleSaveTradeJournal(
    accountId: string,
    positionId: number,
    entry: Omit<TradeJournalEntry, 'accountId' | 'positionId' | 'updatedAtUtc'>,
  ) {
    try {
      const payload = await api.saveTradeJournal(accountId, positionId, entry);
      setData(payload);
    } catch (err) {
      setBanner({
        type: 'error',
        text: err instanceof Error ? err.message : 'Unable to save trade journal.',
      });
      throw err;
    }
  }

  async function handleSaveDailyJournal(
    date: string,
    entry: Omit<DailyJournalEntry, 'date' | 'updatedAtUtc'>,
  ) {
    try {
      const payload = await api.saveDailyJournal(date, entry);
      setData(payload);
    } catch (err) {
      setBanner({
        type: 'error',
        text: err instanceof Error ? err.message : 'Unable to save daily journal.',
      });
      throw err;
    }
  }

  async function handleSaveReview(id: string, review: Omit<PeriodicReview, 'id' | 'updatedAtUtc'>) {
    try {
      const payload = await api.savePeriodicReview(id, review);
      setData(payload);
    } catch (err) {
      setBanner({
        type: 'error',
        text: err instanceof Error ? err.message : 'Unable to save periodic review.',
      });
      throw err;
    }
  }

  async function handleAddCalendarEvent(ev: Omit<CalendarEventMarker, 'id'>) {
    try {
      const payload = await api.addCalendarEvent(ev);
      setData(payload);
    } catch (err) {
      setBanner({
        type: 'error',
        text: err instanceof Error ? err.message : 'Unable to add calendar event.',
      });
      throw err;
    }
  }

  async function handleDeleteCalendarEvent(id: string) {
    try {
      const payload = await api.deleteCalendarEvent(id);
      setData(payload);
    } catch (err) {
      setBanner({
        type: 'error',
        text: err instanceof Error ? err.message : 'Unable to delete calendar event.',
      });
    }
  }

  async function handleSaveSettings(next: Partial<UserSettings>) {
    try {
      const payload = await api.saveSettings(next);
      setData(payload);
    } catch (err) {
      setBanner({
        type: 'error',
        text: err instanceof Error ? err.message : 'Unable to save preferences.',
      });
    }
  }

  async function handleLockSession() {
    try {
      await api.logout();
    } finally {
      setAuthToken(null);
      setIsUnlocked(false);
      setData(null);
      checkAuth();
    }
  }

  if (!authStatus) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex items-center justify-center text-xs text-slate-500">
        Initialising LedgerFX vault...
      </div>
    );
  }

  if (!isUnlocked) {
    return (
      <AuthGate
        status={authStatus}
        onAuthenticated={() => {
          setIsUnlocked(true);
          loadBootstrap();
        }}
      />
    );
  }

  const activeNavLabel = NAV_ITEMS.find((n) => n.key === activeTab)?.label ?? 'Dashboard';

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 flex">
      {/* Desktop Sidebar */}
      <aside
        aria-label="Primary portal navigation"
        className="hidden lg:flex lg:flex-col w-60 shrink-0 bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800 sticky top-0 h-screen"
      >
        <div className="h-14 px-5 flex items-center border-b border-slate-200 dark:border-slate-800">
          <span className="font-display text-lg font-bold tracking-tight text-slate-900 dark:text-slate-100 whitespace-nowrap">
            LedgerFX
          </span>
        </div>

        <nav className="flex-1 overflow-y-auto p-3 space-y-1">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.key;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => setActiveTab(item.key)}
                aria-current={active ? 'page' : undefined}
                className={`w-full flex items-center gap-3 px-3 py-2 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                  active
                    ? 'bg-slate-900 dark:bg-blue-600 text-white'
                    : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="p-3 border-t border-slate-200 dark:border-slate-800 space-y-1">
          <button
            type="button"
            onClick={() =>
              handleSaveSettings({ theme: settings.theme === 'dark' ? 'light' : 'dark' })
            }
            className="w-full flex items-center gap-2.5 px-3 py-2 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md whitespace-nowrap"
          >
            {settings.theme === 'dark' ? (
              <Sun className="w-4 h-4 shrink-0" aria-hidden="true" />
            ) : (
              <Moon className="w-4 h-4 shrink-0" aria-hidden="true" />
            )}
            <span>{settings.theme === 'dark' ? 'Light Theme' : 'Dark Theme'}</span>
          </button>

          <button
            type="button"
            onClick={() => setShowOnboarding(true)}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md whitespace-nowrap"
          >
            <HelpCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span>MT5 Guide</span>
          </button>

          <button
            type="button"
            onClick={handleLockSession}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md whitespace-nowrap"
          >
            <LogOut className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span>Lock Vault</span>
          </button>
        </div>
      </aside>

      {/* Mobile Navigation Drawer */}
      {mobileNavOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-slate-950/50"
            onClick={() => setMobileNavOpen(false)}
            aria-hidden="true"
          />
          <aside className="relative z-10 w-64 bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800 h-full flex flex-col">
            <div className="h-14 px-4 flex items-center justify-between border-b border-slate-200 dark:border-slate-800">
              <span className="font-display text-lg font-bold">LedgerFX</span>
              <button
                type="button"
                onClick={() => setMobileNavOpen(false)}
                aria-label="Close navigation menu"
                className="p-2 text-slate-500"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <nav className="flex-1 overflow-y-auto p-3 space-y-1">
              {NAV_ITEMS.map((item) => {
                const Icon = item.icon;
                const active = activeTab === item.key;
                return (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => {
                      setActiveTab(item.key);
                      setMobileNavOpen(false);
                    }}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 text-xs font-medium rounded-md whitespace-nowrap ${
                      active
                        ? 'bg-slate-900 dark:bg-blue-600 text-white'
                        : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                    }`}
                  >
                    <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </nav>
            <div className="p-3 border-t border-slate-200 dark:border-slate-800">
              <button
                type="button"
                onClick={handleLockSession}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-xs font-medium text-slate-700 dark:text-slate-300"
              >
                <LogOut className="w-4 h-4" />
                <span>Lock Vault</span>
              </button>
            </div>
          </aside>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Clean SaaS Top Bar */}
        <header className="sticky top-0 z-30 h-14 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 px-4 lg:px-8 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              aria-label="Open navigation menu"
              className="lg:hidden p-2 -ml-2 text-slate-600 dark:text-slate-300"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 truncate">
              <span className="font-display font-semibold text-slate-900 dark:text-slate-100 lg:hidden">
                LedgerFX
              </span>
              <span className="lg:hidden" aria-hidden="true">/</span>
              <span className="hidden lg:inline">Personal MT5 Journal</span>
              <span className="hidden lg:inline" aria-hidden="true">/</span>
              <span className="font-medium text-slate-900 dark:text-slate-100 truncate">
                {activeNavLabel}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            {data && data.accounts.length > 0 && (
              <select
                aria-label="Active MT5 account scope"
                value={filters.accountId}
                onChange={(e) => setFilters((f) => ({ ...f, accountId: e.target.value }))}
                className="hidden sm:block px-2.5 py-1.5 text-xs rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-100 max-w-[200px] truncate"
              >
                <option value="all">All Accounts ({data.accounts.length})</option>
                {data.accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.friendlyName}
                  </option>
                ))}
              </select>
            )}

            <button
              type="button"
              disabled={syncingAll || !data || data.accounts.length === 0}
              onClick={handleSyncAllActive}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium rounded-md bg-slate-900 hover:bg-slate-800 dark:bg-blue-600 dark:hover:bg-blue-500 text-white disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${syncingAll ? 'animate-spin' : ''}`}
                aria-hidden="true"
              />
              <span>{syncingAll ? 'Syncing...' : 'Sync Data'}</span>
            </button>
          </div>
        </header>

        {/* Status / Sync Toast Banner */}
        {banner && (
          <div
            role={banner.type === 'error' ? 'alert' : 'status'}
            className={`px-4 lg:px-8 py-2.5 text-xs flex items-center justify-between gap-4 border-b ${
              banner.type === 'error'
                ? 'bg-red-50 dark:bg-red-950/50 border-red-200 dark:border-red-900 text-red-800 dark:text-red-300'
                : 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-900 text-emerald-800 dark:text-emerald-300'
            }`}
          >
            <span>{banner.text}</span>
            <button
              type="button"
              onClick={() => setBanner(null)}
              aria-label="Dismiss message"
              className="p-0.5 opacity-75 hover:opacity-100"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Viewport Content */}
        <main className="flex-1 p-4 lg:p-8 max-w-[1440px] w-full mx-auto">
          {loadingData && !data ? (
            <div className="space-y-4 animate-pulse" aria-busy="true">
              <div className="h-8 w-64 bg-slate-200 dark:bg-slate-800 rounded" />
              <div className="grid grid-cols-2 lg:grid-cols-6 gap-4">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="h-24 bg-slate-200 dark:bg-slate-800 rounded-lg" />
                ))}
              </div>
              <div className="h-72 bg-slate-200 dark:bg-slate-800 rounded-lg" />
            </div>
          ) : data ? (
            <>
              {activeTab === 'dashboard' && (
                <DashboardView
                  accounts={filteredAccounts}
                  closedTrades={filteredClosedTrades}
                  openPositions={filteredOpenPositions}
                  metrics={computedMetrics}
                  settings={settings}
                  onSelectTrade={(t) => setSelectedTradeKey(t.key)}
                  onNavigate={(tab) => {
                    if (tab === 'accounts:link') {
                      setOpenLinkFormOnAccounts(true);
                      setActiveTab('accounts');
                    } else {
                      setActiveTab(tab as NavKey);
                    }
                  }}
                />
              )}

              {activeTab === 'accounts' && (
                <AccountsView
                  accounts={data.accounts}
                  closedTrades={allClosedTrades}
                  openPositions={data.openPositions}
                  balanceOperations={data.balanceOperations}
                  settings={settings}
                  onRefreshBootstrap={handleRefreshBootstrap}
                  onSyncAccount={handleSyncSingleAccount}
                  syncingAccountId={syncingAccountId}
                  initialOpenLinkForm={openLinkFormOnAccounts}
                  onConsumeInitialOpenLinkForm={() => setOpenLinkFormOnAccounts(false)}
                />
              )}

              {activeTab === 'history' && (
                <TradeHistoryView
                  closedTrades={filteredClosedTrades}
                  openPositions={filteredOpenPositions}
                  accounts={data.accounts}
                  symbols={availableSymbols}
                  strategies={availableStrategies}
                  filters={filters}
                  onFiltersChange={setFilters}
                  settings={settings}
                  onSelectTrade={(t) => setSelectedTradeKey(t.key)}
                />
              )}

              {activeTab === 'journal' && (
                <JournalView
                  closedTrades={filteredClosedTrades}
                  settings={settings}
                  onSelectTrade={(t) => setSelectedTradeKey(t.key)}
                />
              )}

              {activeTab === 'daily' && (
                <DailyJournalView
                  selectedDate={selectedDailyDate}
                  onSelectDate={setSelectedDailyDate}
                  dailyJournals={data.dailyJournals}
                  periodicReviews={data.periodicReviews}
                  closedTrades={allClosedTrades}
                  settings={settings}
                  onSaveDaily={handleSaveDailyJournal}
                  onSaveReview={handleSaveReview}
                  onSelectTrade={(t) => setSelectedTradeKey(t.key)}
                />
              )}

              {activeTab === 'analytics' && (
                <AnalyticsView
                  closedTrades={filteredClosedTrades}
                  metrics={computedMetrics}
                  accounts={data.accounts}
                  symbols={availableSymbols}
                  strategies={availableStrategies}
                  filters={filters}
                  onFiltersChange={setFilters}
                  settings={settings}
                />
              )}

              {activeTab === 'ai' && (
                <AIInsightsView
                  accounts={data.accounts}
                  closedTrades={filteredClosedTrades}
                  metrics={computedMetrics}
                  settings={settings}
                  onSelectTrade={(t) => setSelectedTradeKey(t.key)}
                />
              )}

              {activeTab === 'calendar' && (
                <CalendarView
                  closedTrades={filteredClosedTrades}
                  dailyJournals={data.dailyJournals}
                  calendarEvents={data.calendarEvents}
                  settings={settings}
                  onOpenDayJournal={(date) => {
                    setSelectedDailyDate(date);
                    setActiveTab('daily');
                  }}
                  onAddEvent={handleAddCalendarEvent}
                  onDeleteEvent={handleDeleteCalendarEvent}
                />
              )}

              {activeTab === 'reports' && (
                <ReportsView
                  accounts={data.accounts}
                  allClosedTrades={allClosedTrades}
                  filteredTrades={filteredClosedTrades}
                  deals={data.deals}
                  balanceOperations={data.balanceOperations}
                  openPositions={data.openPositions}
                  settings={settings}
                  onRefreshBootstrap={handleRefreshBootstrap}
                />
              )}

              {activeTab === 'settings' && (
                <SettingsView
                  settings={settings}
                  auditLogs={data.auditLogs}
                  onSaveSettings={handleSaveSettings}
                  onRefreshBootstrap={handleRefreshBootstrap}
                />
              )}
            </>
          ) : null}
        </main>
      </div>

      {/* Trade Detail & Journal Drawer */}
      <TradeDetailDrawer
        trade={selectedTrade}
        settings={settings}
        onClose={() => setSelectedTradeKey(null)}
        onSaveJournal={handleSaveTradeJournal}
      />

      {/* On-Demand MT5 Onboarding Guide */}
      <OnboardingModal open={showOnboarding} onClose={() => setShowOnboarding(false)} />
    </div>
  );
}
