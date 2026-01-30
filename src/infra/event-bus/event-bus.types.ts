import { Features } from '../../domain/features/features.types';
import { ForcedEvent } from '../../domain/detectors/detector.types';
import { TradePlan } from '../../domain/setup-engine/setup-engine.types';
import {
  NormalizedTick,
  OrderBookSnap,
  LiqPrint,
} from '../../domain/market-data/market-data.types';

export interface EventMap {
  // ==================== Market Data ====================
  'tick.normalized': NormalizedTick;
  'book.snapshot': OrderBookSnap;
  'liq.print': LiqPrint;

  // ==================== Features ====================
  'features.updated': {
    symbol: string;
    features: Features;
  };

  // ==================== Forced Events ====================
  'forced-event.detected': ForcedEvent;

  'signal.classified': {
    event: ForcedEvent;
    passed: boolean;
    reason?: string;
  };

  // ==================== Trade Plans ====================
  'trade-plan.created': TradePlan;
  'trade-plan.armed': TradePlan;
  'trade-plan.triggered': TradePlan;
  'trade-plan.filled': TradePlan;
  'trade-plan.expired': TradePlan;
  'trade-plan.cancelled': {
    planId: string;
    reason: string;
  };

  // ==================== Execution ====================
  'order.placed': {
    planId: string;
    orderId: string;
    symbol: string;
    side: 'BUY' | 'SELL';
    price: number;
    qty: number;
  };

  'order.filled': {
    planId: string;
    orderId: string;
    symbol: string;
    price: number;
    qty: number;
    feesUsdc: number;
  };

  'order.cancelled': {
    planId: string;
    orderId: string;
    reason: string;
  };

  'position.opened': {
    planId: string;
    symbol: string;
    side: 'LONG' | 'SHORT';
    entryPrice: number;
    triggerPrice: number;
    qty: number;
    notionalUsdc: number;
    slippageUsdc: number;
    feesUsdc: number;
    simulation?: boolean;
  };

  'position.closed': {
    planId: string;
    symbol: string;
    side: 'LONG' | 'SHORT';
    entryPrice: number;
    exitPrice: number;
    qty: number;
    pnlUsdc: number;
    pnlR: number;
    reason: 'TP' | 'SL' | 'MANUAL' | 'KILL_SWITCH';
    feesUsdc: number;
    slippageUsdc: number;
    mfe: number;
    mae: number;
    holdTimeMs: number;
    simulation?: boolean;
  };

  'position.stop-moved': {
    planId: string;
    symbol: string;
    oldStop: number;
    newStop: number;
    reason: 'tp1_hit' | 'trailing';
    simulation?: boolean;
  };

  // ==================== Risk ====================
  'risk.daily-limit-hit': {
    date: string;
    lossUsdc: number;
    limit: number;
  };

  'risk.trading-halted': {
    reason: string;
    timestamp: number;
  };

  'risk.trading-resumed': {
    timestamp: number;
  };

  // ==================== Telegram Commands ====================
  'telegram.positions.request': {
    source: string;
    timestamp: number;
  };

  'telegram.positions.response': {
    timestamp: number;
    activePositions: number;
    pendingPlans: number;
    dailyPnl: number;
    equity: number;
  };

  'telegram.metrics.request': {
    source: string;
    timestamp: number;
  };

  'telegram.stats.request': {
    source: string;
    timestamp: number;
  };

  'telegram.trades.request': {
    source: string;
    timestamp: number;
  };

  'telegram.kill-switch.request': {
    source: string;
    timestamp: number;
  };

  // ==================== Errors ====================
  error: {
    source: string;
    message: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    timestamp?: number;
    error?: Error;
    ctx?: Record<string, unknown>;
  };

  // ==================== System ====================
  'system.started': {
    timestamp: number;
    symbols: string[];
    mode: 'LIVE' | 'PAPER';
  };

  'system.stopped': {
    timestamp: number;
    reason: string;
  };
}

export type EventName = keyof EventMap;
export type EventData<T extends EventName> = EventMap[T];
export type EventListener<T extends EventName> = (
  data: EventData<T>,
) => void | Promise<void>;
