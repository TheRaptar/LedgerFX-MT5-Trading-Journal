import type { SessionWindowConfig, UserSettings } from './types.ts';

export const AVAILABLE_TIMEZONES = [
  { value: 'Europe/London', label: 'Europe/London (GMT / BST)' },
  { value: 'UTC', label: 'UTC (Coordinated Universal Time)' },
  { value: 'Europe/Athens', label: 'Europe/Athens (MT5 Server GMT+2 / GMT+3)' },
  { value: 'Europe/Frankfurt', label: 'Europe/Frankfurt (CET / CEST)' },
  { value: 'America/New_York', label: 'America/New_York (EST / EDT)' },
  { value: 'Asia/Tokyo', label: 'Asia/Tokyo (JST)' },
  { value: 'Asia/Singapore', label: 'Asia/Singapore (SGT)' },
  { value: 'Australia/Sydney', label: 'Australia/Sydney (AEST / AEDT)' },
];

export function getShortTimeZoneName(date: Date, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      timeZoneName: 'short',
    }).formatToParts(date);
    const tzPart = parts.find((p) => p.type === 'timeZoneName');
    return tzPart ? tzPart.value : timeZone;
  } catch {
    return 'UTC';
  }
}

export function formatDateOnly(isoUtc: string, settings: UserSettings): string {
  const d = new Date(isoUtc);
  if (Number.isNaN(d.getTime())) return isoUtc;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: settings.displayTimeZone,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }).formatToParts(d);
    const day = parts.find((p) => p.type === 'day')?.value ?? '01';
    const month = parts.find((p) => p.type === 'month')?.value ?? '01';
    const year = parts.find((p) => p.type === 'year')?.value ?? '2026';
    return settings.dateFormat === 'DD/MM/YYYY'
      ? `${day}/${month}/${year}`
      : `${month}/${day}/${year}`;
  } catch {
    return isoUtc.slice(0, 10);
  }
}

export function formatTimeOnly(isoUtc: string, settings: UserSettings): string {
  const d = new Date(isoUtc);
  if (Number.isNaN(d.getTime())) return '';
  try {
    const timeStr = new Intl.DateTimeFormat('en-GB', {
      timeZone: settings.displayTimeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: settings.timeFormat === '12h',
    }).format(d);
    const tzName = getShortTimeZoneName(d, settings.displayTimeZone);
    return `${timeStr} ${tzName}`;
  } catch {
    return `${isoUtc.slice(11, 16)} UTC`;
  }
}

export function formatTimestampWithServer(
  isoUtc: string,
  serverTimeRaw: string | undefined,
  serverTzLabel: string | undefined,
  settings: UserSettings,
): string {
  const datePart = formatDateOnly(isoUtc, settings);
  const localTimePart = formatTimeOnly(isoUtc, settings);
  if (settings.showDualTimeZones && serverTimeRaw && serverTzLabel) {
    const serverClock = serverTimeRaw.slice(11, 16);
    if (serverClock) {
      return `${datePart} ${localTimePart} (${serverClock} ${serverTzLabel})`;
    }
  }
  return `${datePart} ${localTimePart}`;
}

export function getIsoDayInZone(isoUtc: string, timeZone: string): string {
  const d = new Date(isoUtc);
  if (Number.isNaN(d.getTime())) return isoUtc.slice(0, 10);
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(d);
    const y = parts.find((p) => p.type === 'year')?.value ?? '2026';
    const m = parts.find((p) => p.type === 'month')?.value ?? '01';
    const day = parts.find((p) => p.type === 'day')?.value ?? '01';
    return `${y}-${m}-${day}`;
  } catch {
    return isoUtc.slice(0, 10);
  }
}

export function classifyTradingSession(
  isoUtc: string,
  windows: SessionWindowConfig,
): 'Asia' | 'London' | 'New York' | 'London/NY Overlap' | 'Off-Hours' {
  const d = new Date(isoUtc);
  const hour = d.getUTCHours();
  const inLondon = hour >= windows.londonStartUtc && hour < windows.londonEndUtc;
  const inNY = hour >= windows.newYorkStartUtc && hour < windows.newYorkEndUtc;
  const inAsia = hour >= windows.asiaStartUtc && hour < windows.asiaEndUtc;

  if (inLondon && inNY) return 'London/NY Overlap';
  if (inLondon) return 'London';
  if (inNY) return 'New York';
  if (inAsia) return 'Asia';
  return 'Off-Hours';
}

export function formatCurrency(
  amount: number,
  settings: UserSettings,
  options?: { signed?: boolean; currencyOverride?: string },
): string {
  const decimals = settings.decimalPlaces ?? 2;
  const symbolMap: Record<string, string> = {
    GBP: '£',
    USD: '$',
    EUR: '€',
    CHF: 'CHF ',
    AUD: 'A$',
    JPY: '¥',
  };
  const sym = options?.currencyOverride
    ? symbolMap[options.currencyOverride] ?? `${options.currencyOverride} `
    : settings.currencySymbol;
  const absFormatted = Math.abs(amount).toLocaleString('en-GB', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  const sign = amount < 0 ? '-' : options?.signed && amount > 0 ? '+' : '';
  if (settings.currencyPosition === 'suffix') {
    return `${sign}${absFormatted} ${sym.trim()}`;
  }
  return `${sign}${sym}${absFormatted}`;
}

export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))}m`;
  const hours = Math.floor(minutes / 60);
  const mins = Math.round(minutes % 60);
  if (hours < 24) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}
