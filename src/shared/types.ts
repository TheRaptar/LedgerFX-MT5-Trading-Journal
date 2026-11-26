export type AccountMode = 'hedging' | 'netting';
export type AccountEnvironment = 'live' | 'demo';
export type ConnectionType = 'bridge_https' | 'mt5_sandbox' | 'csv_import';

export interface MT5Account {
  id: string;
  friendlyName: string;
  accountLogin: string;
  brokerName: string;
  brokerServer: string;
  environment: AccountEnvironment;
  accountMode: AccountMode;
  currency: string;
  leverage: number;
  serverTimeZone: string; // e.g. 'Europe/Athens' (GMT+2/GMT+3) or 'UTC'
  serverUtcOffsetLabel: string; // e.g. 'GMT+2'
  connectionType: ConnectionType;
  bridgeUrl?: string;
  hasCredentials: boolean;
  initialBalance: number;
  balance: number;
  equity: number;
  lastSyncUtc: string | null;
  highestDealTicket: number;
  earliestAvailableUtc: string | null;
  expectedStartUtc: string | null;
  syncNotice: string | null;
  integrityWarnings: string[];
  createdAtUtc: string;
}

export type MT5DealType =
  | 'DEAL_TYPE_BUY'
  | 'DEAL_TYPE_SELL'
  | 'DEAL_TYPE_BALANCE'
  | 'DEAL_TYPE_CREDIT'
  | 'DEAL_TYPE_CHARGE'
  | 'DEAL_TYPE_CORRECTION'
  | 'DEAL_TYPE_DIVIDEND'
  | 'DEAL_TYPE_TAX';

export type MT5DealEntry =
  | 'DEAL_ENTRY_IN'
  | 'DEAL_ENTRY_OUT'
  | 'DEAL_ENTRY_INOUT'
  | 'DEAL_ENTRY_OUT_BY';

export interface MT5Deal {
  ticket: number;
  accountId: string;
  orderId: number;
  positionId: number;
  symbol: string;
  dealType: MT5DealType;
  dealEntry: MT5DealEntry;
  volume: number; // lots
  price: number;
  profit: number; // gross deal profit in account currency
  commission: number; // typically negative or 0
  swap: number; // signed
  sl: number | null;
  tp: number | null;
  utcTime: string; // ISO-8601 UTC
  serverTimeRaw: string; // original MT5 server timestamp string
  serverTzLabel: string; // e.g. 'GMT+2' or 'GMT+3'
  magicNumber: number;
  comment: string;
}

export interface MT5OpenPosition {
  ticket: number;
  accountId: string;
  symbol: string;
  direction: 'BUY' | 'SELL';
  volume: number;
  openPrice: number;
  currentPrice: number;
  sl: number | null;
  tp: number | null;
  swap: number;
  commission: number;
  unrealisedProfit: number;
  openTimeUtc: string;
  serverTimeRaw: string;
  serverTzLabel: string;
  magicNumber: number;
  comment: string;
}

export interface BalanceOperation {
  ticket: number;
  accountId: string;
  dealType: 'DEAL_TYPE_BALANCE' | 'DEAL_TYPE_CREDIT' | 'DEAL_TYPE_CHARGE' | 'DEAL_TYPE_CORRECTION';
  amount: number; // positive for deposit/credit, negative for withdrawal/charge
  utcTime: string;
  serverTimeRaw: string;
  serverTzLabel: string;
  comment: string;
}

export interface TradeJournalEntry {
  accountId: string;
  positionId: number;
  strategy: string;
  tags: string[];
  initialRiskCurrency: number | null;
  manualSlOverride: number | null;
  manualEntryOverride: number | null;
  outcomeOverride: 'auto' | 'win' | 'loss' | 'breakeven';
  rationale: string;
  emotions: string;
  mistakes: string;
  notes: string;
  sessionOverride: string;
  updatedAtUtc: string;
}

export interface ClosedTrade {
  key: string; // `${accountId}:${positionId}`
  accountId: string;
  accountName: string;
  accountCurrency: string;
  positionId: number;
  symbol: string;
  direction: 'BUY' | 'SELL';
  totalVolume: number;
  weightedEntryPrice: number;
  weightedExitPrice: number;
  openTimeUtc: string;
  closeTimeUtc: string;
  openServerTimeRaw: string;
  openServerTzLabel: string;
  closeServerTimeRaw: string;
  closeServerTzLabel: string;
  durationMinutes: number;
  grossProfit: number;
  commission: number;
  swap: number;
  netProfit: number; // grossProfit + commission + swap
  sl: number | null;
  tp: number | null;
  isPartial: boolean;
  entryFillsCount: number;
  exitFillsCount: number;
  deals: MT5Deal[];
  session: 'Asia' | 'London' | 'New York' | 'London/NY Overlap' | 'Off-Hours';
  journal: TradeJournalEntry | null;
  initialRiskCurrency: number | null;
  rMultiple: number | null;
  outcome: 'win' | 'loss' | 'breakeven';
}

export interface DailyJournalEntry {
  date: string; // YYYY-MM-DD
  narrative: string;
  mood: number; // 1-5
  discipline: number; // 1-5
  stress: number; // 1-5
  confidence: number; // 1-5
  sessionLabel: string;
  lessons: string;
  updatedAtUtc: string;
}

export interface PeriodicReview {
  id: string;
  periodType: 'weekly' | 'monthly';
  periodLabel: string; // e.g. '2026-W46' or '2026-10'
  startDate: string;
  endDate: string;
  lessonsLearned: string;
  goalsNextPeriod: string;
  psychologicalTriggers: string;
  rating: number; // 1-5
  updatedAtUtc: string;
}

export interface CalendarEventMarker {
  id: string;
  date: string; // YYYY-MM-DD
  title: string;
  category: 'News Announcement' | 'Session Note' | 'Personal Reminder' | 'Broker Notice';
  impact: 'High' | 'Medium' | 'Low';
  notes: string;
}

export interface SessionWindowConfig {
  asiaStartUtc: number;
  asiaEndUtc: number;
  londonStartUtc: number;
  londonEndUtc: number;
  newYorkStartUtc: number;
  newYorkEndUtc: number;
}

export interface UserSettings {
  displayTimeZone: string; // IANA e.g. 'Europe/London'
  showDualTimeZones: boolean;
  dateFormat: 'DD/MM/YYYY' | 'MM/DD/YYYY';
  timeFormat: '24h' | '12h';
  baseCurrency: string;
  currencySymbol: string;
  currencyPosition: 'prefix' | 'suffix';
  decimalPlaces: number;
  breakEvenHandling: 'exclude' | 'count_total';
  includeUnrealisedInDrawdown: boolean;
  defaultRiskPercent: number;
  defaultRiskCurrency: number;
  defaultLeverage: number;
  theme: 'light' | 'dark';
  fontSize: 'sm' | 'md' | 'lg';
  autoSyncIntervalMinutes: number;
  sessionTimeoutMinutes: number;
  notifyNewTrade: boolean;
  notifyDrawdownAlert: boolean;
  drawdownAlertThresholdPct: number;
  notifyWeeklySummary: boolean;
  benchmarkName: string;
  benchmarkReturnPct: number;
  sessionWindows: SessionWindowConfig;
  currencyRatesToBase: Record<string, number>;
  onboardingCompleted: boolean;
}

export interface AuditLogEntry {
  id: number;
  utcTime: string;
  action: string;
  entity: string;
  details: string;
}

export interface AIInsightItem {
  title: string;
  category: 'Performance Pattern' | 'Risk & Drawdown' | 'Behaviour & Psychology' | 'Execution & Costs';
  severity: 'positive' | 'caution' | 'critical' | 'neutral';
  summary: string;
  evidenceTradeIds: number[];
  supportingMetric: string;
  actionableReflection: string;
}

export interface AIInsightsResponse {
  generatedAtUtc: string;
  model: string;
  disclaimer: string;
  sampleSize: number;
  overallObservation: string;
  insights: AIInsightItem[];
}

export interface BootstrapPayload {
  accounts: MT5Account[];
  deals: MT5Deal[];
  openPositions: MT5OpenPosition[];
  balanceOperations: BalanceOperation[];
  journals: TradeJournalEntry[];
  dailyJournals: DailyJournalEntry[];
  periodicReviews: PeriodicReview[];
  calendarEvents: CalendarEventMarker[];
  settings: UserSettings;
  auditLogs: AuditLogEntry[];
}

export interface FilterState {
  accountId: string; // 'all' or account.id
  symbol: string; // 'all' or symbol
  strategy: string; // 'all' or strategy
  session: string; // 'all' or session
  outcome: 'all' | 'win' | 'loss' | 'breakeven';
  dateFrom: string; // YYYY-MM-DD or ''
  dateTo: string; // YYYY-MM-DD or ''
  search: string;
}

export const DEFAULT_SETTINGS: UserSettings = {
  displayTimeZone: 'Europe/London',
  showDualTimeZones: true,
  dateFormat: 'DD/MM/YYYY',
  timeFormat: '24h',
  baseCurrency: 'GBP',
  currencySymbol: '£',
  currencyPosition: 'prefix',
  decimalPlaces: 2,
  breakEvenHandling: 'count_total',
  includeUnrealisedInDrawdown: true,
  defaultRiskPercent: 1.0,
  defaultRiskCurrency: 150,
  defaultLeverage: 30,
  theme: 'light',
  fontSize: 'md',
  autoSyncIntervalMinutes: 15,
  sessionTimeoutMinutes: 60,
  notifyNewTrade: true,
  notifyDrawdownAlert: true,
  drawdownAlertThresholdPct: 5,
  notifyWeeklySummary: false,
  benchmarkName: 'FTSE 100 (Annualised Benchmark)',
  benchmarkReturnPct: 7.5,
  sessionWindows: {
    asiaStartUtc: 0,
    asiaEndUtc: 8,
    londonStartUtc: 8,
    londonEndUtc: 16,
    newYorkStartUtc: 13,
    newYorkEndUtc: 21,
  },
  currencyRatesToBase: {
    GBP: 1.0,
    USD: 0.79,
    EUR: 0.85,
  },
  onboardingCompleted: false,
};
