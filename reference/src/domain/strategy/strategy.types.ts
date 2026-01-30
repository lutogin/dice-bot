import Decimal from 'decimal.js';
import type { RiskFlags } from '../risk/risk.types';
import type {
  CompositionResult,
  PositionInfo,
} from '../lp-position/lp-position.types';
import type { HedgeSnapshot } from '../hedge/hedge.types';

/**
 * Action plan type
 */
export type ActionPlanType =
  | 'NONE'
  | 'REHEDGE'
  | 'RESET_RANGE'
  | 'EMERGENCY_EXIT';

/**
 * LP Composition input for strategy
 */
export interface LpCompositionInput {
  /** WETH amount in LP */
  wethAmount: Decimal;
  /** USDC amount in LP */
  usdcAmount: Decimal;
  /** Total value in USDC */
  totalValueUsdc: Decimal;
  /** Whether in range */
  inRange: boolean;
  /** Current tick */
  currentTick: number;
  /** Lower tick */
  tickLower: number;
  /** Upper tick */
  tickUpper: number;
  /** Distance to lower bound percent */
  distanceToLowerPercent: Decimal;
  /** Distance to upper bound percent */
  distanceToUpperPercent: Decimal;
}

/**
 * Hedge input for strategy
 */
export interface HedgeInput {
  /** Has position */
  hasPosition: boolean;
  /** Current short notional in USDC */
  shortNotionalUsdc: Decimal;
  /** Short size in ETH */
  shortSizeEth: Decimal;
  /** Mark price */
  markPrice: Decimal;
  /** Margin info */
  equity: Decimal;
  /** Liquidation distance */
  liquidationDistancePercent: Decimal;
}

/**
 * Range bounds in ticks
 */
export interface RangeBounds {
  tickLower: number;
  tickUpper: number;
}

/**
 * New range bounds with prices and sanity check result
 */
export interface NewRangeBounds {
  tickLower: number;
  tickUpper: number;
  priceLower: Decimal;
  priceUpper: Decimal;
  /** Whether the new range passes sanity check */
  isValid: boolean;
  /** Current pool tick (for sanity check) */
  currentPoolTick?: number;
  /** Reason if invalid */
  invalidReason?: string;
}

/**
 * Reset decision with reason and priority
 */
export interface ResetDecision {
  shouldReset: boolean;
  reason: string;
  /** Whether price is completely out of range */
  isOutOfRange: boolean;
  /** Which boundary is at risk */
  boundaryAtRisk: 'lower' | 'upper' | 'none';
  /** Distance to boundary in percent */
  distancePercent: Decimal;
  /** Whether reset is blocked by rate limit */
  blockedByRateLimit: boolean;
  /** Priority: out-of-range is critical, near-boundary is medium */
  priority: 'low' | 'medium' | 'high' | 'critical';
}

/**
 * Action plan returned by buildPlan
 */
export interface ActionPlan {
  /** Plan type */
  type: ActionPlanType;
  /** Timestamp */
  timestamp: number;
  /** Reference price used */
  referencePrice: Decimal;
  /** Actions to execute (for detailed plans) */
  actions: StrategyAction[];
  /** Whether critical */
  isCritical: boolean;
  /** Summary */
  summary: string;
  /** Emergency reasons (if EMERGENCY_EXIT) */
  emergencyReasons?: string[];
  /** Rehedge parameters (if REHEDGE) */
  rehedgeParams?: {
    currentShortUsdc: Decimal;
    targetShortUsdc: Decimal;
    deltaUsdc: Decimal;
    direction: 'increase' | 'decrease';
    mode: 'makerPrefer' | 'iocMarket';
    /** Current LP WETH amount for delta drift tracking */
    lpWethAmount: Decimal;
    /** Delta drift percentage that triggered rehedge (for event reporting) */
    deltaDriftPercent?: Decimal;
    /** Effective threshold used for decision (for event reporting) */
    effectiveThreshold?: Decimal;
    /** Rehedge mode from decision (for cooldown tracking: 'gap_soft' uses longer cooldown) */
    rehedgeMode?: string;
    /** Human-readable reason for rehedge (for telegram notification) */
    reason?: string;
  };
  /** Reset range parameters (if RESET_RANGE) - per runbook A0 */
  resetRangeParams?: {
    /** Current NFT token ID */
    oldTokenId: string;
    /** New lower tick (±10% rounded to tickSpacing=10) */
    newTickLower: number;
    /** New upper tick */
    newTickUpper: number;
    /** New lower price */
    priceLower: Decimal;
    /** New upper price */
    priceUpper: Decimal;
    /** Reason for reset (near boundary / out of range) */
    reason?: string;
    /** Whether out of range (mandatory reset) */
    isOutOfRange?: boolean;
  };
  /** LP metrics snapshot */
  lpMetrics?: LpMetrics;
  /** Hedge metrics snapshot */
  hedgeMetrics?: HedgeMetrics;
}

/**
 * LP Position metrics computed from current state
 */
export interface LpMetrics {
  lpTotalUsdc: Decimal;
  lpEthNotionalUsdc: Decimal;
  lpEthAmount: Decimal;
  lpUsdcAmount: Decimal;
  currentTick: number;
  tickLower: number;
  tickUpper: number;
  inRange: boolean;
  distanceToLowerPercent: Decimal;
  distanceToUpperPercent: Decimal;
  currentPrice: Decimal;
  priceLower: Decimal;
  priceUpper: Decimal;
  uncollectedFees0?: Decimal;
  uncollectedFees1?: Decimal;
}

/**
 * Hedge position metrics
 */
export interface HedgeMetrics {
  shortNotionalUsdc: Decimal;
  shortEthAmount: Decimal;
  entryPrice: Decimal;
  markPrice: Decimal;
  unrealizedPnl: Decimal;
  leverage: number;
  marginRatio: Decimal;
  liquidationDistance: Decimal;
  hasPosition: boolean;
}

/**
 * Target hedge calculation result
 */
export interface TargetHedge {
  targetNotionalUsdc: Decimal;
  targetEthAmount: Decimal;
  currentNotionalUsdc: Decimal;
  differenceUsdc: Decimal;
  hedgeRatio: Decimal;
}

/**
 * Rehedge decision
 */
export interface RehedgeDecision {
  shouldRehedge: boolean;
  reason: string;
  deviationPercent: Decimal;
  direction: 'increase' | 'decrease' | 'none';
  adjustmentUsdc: Decimal;
  priority: 'low' | 'medium' | 'high' | 'critical';
}

/**
 * Range reset decision
 */
export interface RangeResetDecision {
  shouldReset: boolean;
  reason: string;
  boundaryAtRisk: 'lower' | 'upper' | 'none';
  distancePercent: Decimal;
  suggestedTickLower?: number;
  suggestedTickUpper?: number;
  priority: 'low' | 'medium' | 'high' | 'critical';
}

/**
 * Action types in the strategy
 */
export type ActionType =
  | 'rehedge_increase'
  | 'rehedge_decrease'
  | 'reset_range'
  | 'collect_fees'
  | 'emergency_close_hedge'
  | 'emergency_close_lp'
  | 'emergency_exit'
  | 'increase_margin'
  | 'decrease_leverage'
  | 'noop';

/**
 * Single action in the plan
 */
export interface StrategyAction {
  type: ActionType;
  priority: number;
  reason: string;
  params: Record<string, any>;
  estimatedGas?: Decimal;
  isCritical: boolean;
}

/**
 * Strategy configuration thresholds
 */
export interface StrategyThresholds {
  /** Hedge ratio (0.8 = 80% hedge) */
  hedgeRatio: Decimal;
  /** Rehedge threshold percent (e.g., 0.20 = 20%) */
  rehedgeThresholdPercent: Decimal;
  /** Range reset threshold percent from boundary (e.g., 0.025 = 2.5%) */
  resetNearBoundaryPercent: Decimal;
  /** Range width percent for new positions (e.g., 10 = ±10%) */
  rangeWidthPercent: number;
  /** Tick spacing for the pool (e.g., 10 for 0.05% fee tier) */
  tickSpacing: number;
  /** Minimum rehedge amount in USDC */
  minRehedgeAmountUsdc: Decimal;
  /** Minimum liquidation distance percent */
  minLiquidationDistancePercent: Decimal;
  /** Fee collection threshold in USDC */
  feeCollectionThresholdUsdc: Decimal;
}

/**
 * Strategy state snapshot
 */
export interface StrategyState {
  price: Decimal;
  lpMetrics: LpMetrics | null;
  hedgeMetrics: HedgeMetrics | null;
  lastActionPlan: ActionPlan | null;
  lastUpdateTimestamp: number;
  isHealthy: boolean;
  healthIssues: string[];
}
