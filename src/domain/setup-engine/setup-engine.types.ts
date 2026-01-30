export type TradeSide = 'LONG' | 'SHORT';
export type PlanStatus =
  | 'PENDING'
  | 'ARMED'
  | 'TRIGGERED'
  | 'FILLED'
  | 'EXPIRED'
  | 'CANCELLED';
export type EntryType = 'STOP' | 'LIMIT' | 'MARKET';

/**
 * Trade plan created from forced event + stall detection
 */
export interface TradePlan {
  id: string;
  eventId: string;
  symbol: string;
  side: TradeSide;

  // Entry configuration
  entryTriggerPrice: number;
  entryType: EntryType;

  // Exit levels
  stopPrice: number;
  tp1Price: number;
  tp2Price: number;

  // Position sizing
  qty: number;
  notionalUsdc: number;
  riskUsdc: number; // Amount at risk (distance to stop * qty)
  riskPercent: number; // Risk as % of equity

  // Stall detection snapshot
  stallHigh: number;
  stallLow: number;
  impulseExtreme: number; // The low (for LONG) or high (for SHORT) of the impulse

  // Timing
  createdAt: number;
  expiresAt: number;
  armedAt?: number;
  triggeredAt?: number;
  filledAt?: number;

  status: PlanStatus;
}

/**
 * Result of setup engine evaluation
 */
export interface SetupResult {
  shouldArm: boolean;
  plan?: TradePlan;
  reason?: string;
}

/**
 * Stall detection result
 */
export interface StallDetection {
  isStall: boolean;
  stallHigh: number;
  stallLow: number;
  rangePct: number;
  replenishScore: number;
  cvdDivergence: boolean; // CVD going one way, price flat
}
