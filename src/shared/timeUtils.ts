import type { SessionWindowConfig, UserSettings } from './types.ts';

/**
 * Pseudo-zone for the very common MT5 broker convention: server clock is GMT+2 in winter and
 * GMT+3 while US daylight saving time is active (the FX "New York close" convention).
 * Note this differs from Europe/Athens for ~3 weeks each spring and autumn.
 */
export const MT5_EET_US_DST_ZONE = 'MT5/EET-US-DST';

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

/** Zones that may be chosen as the *broker server* clock (never used as a display zone). */
export const SERVER_TIMEZONE_OPTIONS = [
  { value: MT5_EET_US_DST_ZONE, label: 'GMT+2 winter / GMT+3 summer, US DST schedule (most FX brokers)' },
  { value: 'Europe/Athens', label: 'Europe/Athens (GMT+2 / GMT+3, EU DST schedule)' },
  { value: 'Europe/London', label: 'Europe/London (GMT / BST)' },
  { value: 'Europe/Frankfurt', label: 'Europe/Frankfurt (CET / CEST)' },
  { value: 'UTC', label: 'UTC' },
];

/** UTC offset (ms) of an IANA zone at a given instant. */
function ianaOffsetMs(timeZone: string, utcMs: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Offset of the broker server clock from UTC (ms) at a given UTC instant. */
export function serverOffsetMsAt(utcMs: number, serverTimeZone: string | null | undefined, fallbackLabel = 'GMT+2'): number {
  const zone = (serverTimeZone ?? '').trim();
  if (zone === MT5_EET_US_DST_ZONE) {
    return ianaOffsetMs('America/New_York', utcMs) === -4 * 3600_000 ? 3 * 3600_000 : 2 * 3600_000;
  }
  if (zone) {
    try {
      return ianaOffsetMs(zone, utcMs);
    } catch {
      // fall through to the fixed label
    }
  }
  const match = fallbackLabel.match(/GMT\s*([+-]\d+(?::?\d+)?)/i);
  const hours = match ? Number(match[1].replace(':', '.')) : 2;
  return (Number.isFinite(hours) ? hours : 2) * 3600_000;
}

/**
 * Converts an MT5 server wall-clock string ("2026.11.10 09:15:01" or ISO-like) to a UTC ISO string,
 * honouring daylight saving for the account's server zone. Returns null when the text is not a valid time
 * (callers must skip/warn — never substitute "now").
 */
export function serverWallClockToUtcIso(
  raw: string,
  serverTimeZone: string | null | undefined,
  fallbackLabel = 'GMT+2',
): string | null {
  const text = (raw ?? '').trim();
  if (!text) return null;
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(text) && text.includes('T')) {
    const direct = new Date(text);
    return Number.isNaN(direct.getTime()) ? null : direct.toISOString();
  }
  const m = text.match(/^(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const wall = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0));
  if (Number.isNaN(wall)) return null;
  // Two-pass resolution handles instants near a DST transition.
  let utc = wall - serverOffsetMsAt(wall, serverTimeZone, fallbackLabel);
  utc = wall - serverOffsetMsAt(utc, serverTimeZone, fallbackLabel);
  return new Date(utc).toISOString();
}

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
