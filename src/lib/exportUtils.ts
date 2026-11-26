import { jsPDF } from 'jspdf';
import type { ClosedTrade, MT5Deal, UserSettings } from '../shared/types.ts';
import type { ComputedMetrics } from '../shared/metricsEngine.ts';
import { formatCurrency, formatDuration, formatTimestampWithServer } from '../shared/timeUtils.ts';

function escapeCsvCell(val: unknown): string {
  const s = val === null || val === undefined ? '' : String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function triggerFileDownload(content: string | Blob, filename: string, mimeType: string): void {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function downloadTradesCsv(
  trades: ClosedTrade[],
  settings: UserSettings,
  filename = `ledgerfx-trades-${new Date().toISOString().slice(0, 10)}.csv`,
): void {
  const headers = [
    'Position_ID',
    'Account',
    'Symbol',
    'Direction',
    'Volume_Lots',
    'Open_Time_Display',
    'Close_Time_Display',
    'Open_Time_UTC',
    'Close_Time_UTC',
    'Duration_Mins',
    'Weighted_Entry_Price',
    'Weighted_Exit_Price',
    'SL',
    'TP',
    'Gross_PL',
    'Commission',
    'Swap',
    'Net_PL',
    'Initial_Risk',
    'R_Multiple',
    'Fills_Count',
    'Session',
    'Strategy',
    'Tags',
    'Outcome',
    'Notes',
  ];

  const rows = trades.map((t) => [
    t.positionId,
    t.accountName,
    t.symbol,
    t.direction,
    t.totalVolume,
    formatTimestampWithServer(t.openTimeUtc, t.openServerTimeRaw, t.openServerTzLabel, settings),
    formatTimestampWithServer(t.closeTimeUtc, t.closeServerTimeRaw, t.closeServerTzLabel, settings),
    t.openTimeUtc,
    t.closeTimeUtc,
    t.durationMinutes,
    t.weightedEntryPrice,
    t.weightedExitPrice,
    t.sl ?? '',
    t.tp ?? '',
    t.grossProfit,
    t.commission,
    t.swap,
    t.netProfit,
    t.initialRiskCurrency ?? '',
    t.rMultiple ?? '',
    t.deals.length,
    t.session,
    t.journal?.strategy ?? '',
    (t.journal?.tags ?? []).join('; '),
    t.outcome,
    t.journal?.notes ?? '',
  ]);

  const csv = [headers, ...rows].map((row) => row.map(escapeCsvCell).join(',')).join('\n');
  triggerFileDownload(csv, filename, 'text/csv;charset=utf-8;');
}

export function downloadRawDealsCsv(
  deals: MT5Deal[],
  filename = `ledgerfx-raw-mt5-deals-${new Date().toISOString().slice(0, 10)}.csv`,
): void {
  const headers = [
    'DEAL_TICKET',
    'ACCOUNT_ID',
    'DEAL_ORDER',
    'DEAL_POSITION_ID',
    'DEAL_SYMBOL',
    'DEAL_TYPE',
    'DEAL_ENTRY',
    'DEAL_VOLUME',
    'DEAL_PRICE',
    'DEAL_PROFIT',
    'DEAL_COMMISSION',
    'DEAL_SWAP',
    'SL',
    'TP',
    'DEAL_TIME_UTC',
    'SERVER_TIME_RAW',
    'SERVER_TZ',
    'DEAL_COMMENT',
  ];

  const rows = deals.map((d) => [
    d.ticket,
    d.accountId,
    d.orderId,
    d.positionId,
    d.symbol,
    d.dealType,
    d.dealEntry,
    d.volume,
    d.price,
    d.profit,
    d.commission,
    d.swap,
    d.sl ?? '',
    d.tp ?? '',
    d.utcTime,
    d.serverTimeRaw,
    d.serverTzLabel,
    d.comment,
  ]);

  const csv = [headers, ...rows].map((row) => row.map(escapeCsvCell).join(',')).join('\n');
  triggerFileDownload(csv, filename, 'text/csv;charset=utf-8;');
}

export function downloadJsonBackup(payload: unknown): void {
  const json = JSON.stringify(payload, null, 2);
  triggerFileDownload(
    json,
    `ledgerfx-backup-${new Date().toISOString().slice(0, 10)}.json`,
    'application/json;charset=utf-8;',
  );
}

export interface PdfReportOptions {
  title: string;
  subtitle: string;
  includeMetrics: boolean;
  includeSymbolBreakdown: boolean;
  includeMonthlyTable: boolean;
  includeTradeHighlights: boolean;
  includeFormulas: boolean;
}

export function generatePdfSummaryReport(
  trades: ClosedTrade[],
  metrics: ComputedMetrics,
  settings: UserSettings,
  options: PdfReportOptions,
): void {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 44;
  let y = 52;

  const ensureSpace = (needed: number) => {
    if (y + needed > 780) {
      doc.addPage();
      y = 52;
    }
  };

  // Header
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.setTextColor(15, 23, 42);
  doc.text(options.title, margin, y);
  y += 18;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(71, 85, 105);
  doc.text(options.subtitle, margin, y);
  y += 14;
  doc.text(
    `Generated: ${new Date().toUTCString()} · Display Zone: ${settings.displayTimeZone} · Sample: ${trades.length} closed trades`,
    margin,
    y,
  );
  y += 12;

  doc.setDrawColor(203, 213, 225);
  doc.line(margin, y, pageWidth - margin, y);
  y += 22;

  if (options.includeMetrics) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(15, 23, 42);
    doc.text('Key Performance Metrics (Post-Cost Net)', margin, y);
    y += 16;

    const rows = [
      ['Net Realised P/L', metrics.totalNetProfit.formatted, metrics.totalNetProfit.exactCalculation],
      ['Win Rate', metrics.winRate.formatted, metrics.winRate.exactCalculation],
      ['Profit Factor', metrics.profitFactor.formatted, metrics.profitFactor.exactCalculation],
      ['Expectancy per Trade', metrics.expectancy.formatted, metrics.expectancy.exactCalculation],
      ['Max Drawdown', metrics.maxDrawdown.formatted, metrics.maxDrawdown.exactCalculation],
      ['Average R / Total R', `${metrics.averageR.formatted} / ${metrics.totalR.formatted}`, metrics.averageR.exactCalculation],
      [
        'Trading Costs (Comm + Swap)',
        formatCurrency(metrics.totalCosts, settings),
        `Commissions ${formatCurrency(metrics.totalCommissions, settings)} + Swaps ${formatCurrency(metrics.totalSwaps, settings)}`,
      ],
      ['Average Trade Duration', formatDuration(metrics.avgDurationMinutes), `${metrics.wins} Wins · ${metrics.losses} Losses · ${metrics.breakevens} Break-even`],
    ];

    doc.setFontSize(9.5);
    for (const [label, value, calc] of rows) {
      ensureSpace(options.includeFormulas ? 28 : 16);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(30, 41, 59);
      doc.text(label, margin, y);
      doc.setFont('courier', 'bold');
      doc.text(value, margin + 175, y);
      y += 12;
      if (options.includeFormulas) {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8.5);
        doc.setTextColor(100, 116, 139);
        const wrapped = doc.splitTextToSize(calc, pageWidth - margin * 2 - 12);
        doc.text(wrapped, margin + 10, y);
        y += wrapped.length * 10 + 5;
        doc.setFontSize(9.5);
      } else {
        y += 4;
      }
    }
    y += 12;
  }

  if (options.includeMonthlyTable && metrics.monthlyPerformance.length > 0) {
    ensureSpace(80);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(15, 23, 42);
    doc.text('Monthly Performance Breakdown', margin, y);
    y += 16;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(71, 85, 105);
    doc.text('Month', margin, y);
    doc.text('Trades', margin + 110, y);
    doc.text('Win Rate', margin + 170, y);
    doc.text('Net P/L', margin + 245, y);
    doc.text('Avg Trade', margin + 335, y);
    doc.text('PF', margin + 430, y);
    y += 12;

    doc.setFont('courier', 'normal');
    doc.setTextColor(15, 23, 42);
    for (const m of metrics.monthlyPerformance) {
      ensureSpace(16);
      doc.text(m.monthLabel, margin, y);
      doc.text(String(m.tradesCount), margin + 110, y);
      doc.text(`${m.winRatePct.toFixed(1)}%`, margin + 170, y);
      doc.text(formatCurrency(m.netProfit, settings, { signed: true }), margin + 245, y);
      doc.text(formatCurrency(m.avgTrade, settings, { signed: true }), margin + 335, y);
      doc.text(m.profitFactor !== null ? m.profitFactor.toFixed(2) : '∞', margin + 430, y);
      y += 14;
    }
    y += 14;
  }

  if (options.includeSymbolBreakdown && metrics.symbolBreakdown.length > 0) {
    ensureSpace(80);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(15, 23, 42);
    doc.text('Performance by Symbol', margin, y);
    y += 16;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(71, 85, 105);
    doc.text('Symbol', margin, y);
    doc.text('Trades', margin + 95, y);
    doc.text('Win Rate', margin + 155, y);
    doc.text('Volume', margin + 225, y);
    doc.text('Net P/L', margin + 305, y);
    doc.text('Avg R', margin + 410, y);
    y += 12;

    doc.setFont('courier', 'normal');
    doc.setTextColor(15, 23, 42);
    for (const s of metrics.symbolBreakdown) {
      ensureSpace(16);
      doc.text(s.symbol, margin, y);
      doc.text(String(s.tradesCount), margin + 95, y);
      doc.text(`${s.winRatePct.toFixed(1)}%`, margin + 155, y);
      doc.text(`${s.totalVolume.toFixed(2)} lots`, margin + 225, y);
      doc.text(formatCurrency(s.netProfit, settings, { signed: true }), margin + 305, y);
      doc.text(s.avgR !== null ? `${s.avgR >= 0 ? '+' : ''}${s.avgR.toFixed(2)}R` : '—', margin + 410, y);
      y += 14;
    }
    y += 14;
  }

  if (options.includeTradeHighlights && trades.length > 0) {
    ensureSpace(80);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(15, 23, 42);
    doc.text('Recent Closed Positions (Top 15)', margin, y);
    y += 16;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    doc.setTextColor(71, 85, 105);
    doc.text('Pos ID', margin, y);
    doc.text('Symbol', margin + 62, y);
    doc.text('Side', margin + 122, y);
    doc.text('Lots', margin + 162, y);
    doc.text('Closed', margin + 205, y);
    doc.text('Net P/L', margin + 320, y);
    doc.text('Strategy', margin + 405, y);
    y += 12;

    doc.setFont('courier', 'normal');
    doc.setTextColor(15, 23, 42);
    for (const t of trades.slice(0, 15)) {
      ensureSpace(15);
      doc.text(`#${t.positionId}`, margin, y);
      doc.text(t.symbol, margin + 62, y);
      doc.text(t.direction, margin + 122, y);
      doc.text(t.totalVolume.toFixed(2), margin + 162, y);
      doc.text(t.closeTimeUtc.slice(0, 10), margin + 205, y);
      doc.text(formatCurrency(t.netProfit, settings, { signed: true }), margin + 320, y);
      doc.text((t.journal?.strategy || 'Untagged').slice(0, 18), margin + 405, y);
      y += 13;
    }
    y += 16;
  }

  ensureSpace(40);
  doc.setDrawColor(203, 213, 225);
  doc.line(margin, y, pageWidth - margin, y);
  y += 14;
  doc.setFont('helvetica', 'italic');
  doc.setFontSize(8);
  doc.setTextColor(100, 116, 139);
  doc.text(
    'Data Source Note: All figures reconstructed from MetaTrader 5 read-only deal history grouped by Position ID. Net P/L includes broker commissions and swaps. Personal self-review document only.',
    margin,
    y,
    { maxWidth: pageWidth - margin * 2 },
  );

  doc.save(`ledgerfx-report-${new Date().toISOString().slice(0, 10)}.pdf`);
}
