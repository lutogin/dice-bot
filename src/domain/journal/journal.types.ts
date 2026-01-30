export type TradeResult = 'WIN' | 'LOSS' | 'BREAKEVEN';

export interface TradeRecord {
  id: string;
  planId: string;
  eventId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';

  // Execution
  entryPrice: number;
  exitPrice: number;
  stopPrice: number;
  tpPrice: number;
  qty: number;

  // Financials
  notionalUsdc: number;
  pnlUsdc: number;
  pnlR: number; // Risk multiples
  feesUsdc: number;
  slippageUsdc: number;

  // Metrics
  mfe: number; // Max favorable excursion (%)
  mae: number; // Max adverse excursion (%)
  holdTimeMs: number;

  // Timestamps
  createdAt: number;
  filledAt: number;
  closedAt: number;

  // Context
  exitReason: 'TP' | 'SL' | 'MANUAL' | 'KILL_SWITCH' | 'TIME_STOP';
  result: TradeResult;
}

export interface DailyMetrics {
  date: string;
  tradesCount: number;
  wins: number;
  losses: number;
  winRate: number;
  pnlUsdc: number;
  pnlR: number;
  avgR: number;
  maxDrawdown: number;
  sharpeRatio?: number;
}

export interface DetectionMetrics {
  totalEvents: number;
  passedClassification: number;
  setupsCreated: number;
  entriesTriggered: number;
  filterRate: number;
}
