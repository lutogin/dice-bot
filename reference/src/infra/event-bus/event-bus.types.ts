import Decimal from 'decimal.js';

export interface EventMap {
  'test.event': {
    timestamp: Date;
  };

  /** LP Range reset operation completed */
  'reset.completed': {
    timestamp: number;
    success: boolean;
    /** Old LP token ID */
    oldTokenId: string;
    /** New LP token ID */
    newTokenId: string;
    /** Old tick bounds */
    oldTickLower: number;
    oldTickUpper: number;
    /** New tick bounds */
    newTickLower: number;
    newTickUpper: number;
    /** Old price bounds (USDC) */
    oldPriceLower: string;
    oldPriceUpper: string;
    /** New price bounds (USDC) */
    newPriceLower: string;
    newPriceUpper: string;
    /** Reference price at reset */
    referencePrice: string;
    /** New LP total value in USDC */
    newTotalValueUsdc: string;
    /** Collected fees (WETH, USDC) */
    collectedWeth: string;
    collectedUsdc: string;
    /** Duration of the operation in ms */
    durationMs: number;
    /** Reason for reset (if provided) */
    reason?: string;
    /** Error message if failed */
    error?: string;
  };

  /** Rehedge operation completed */
  'rehedge.completed': {
    timestamp: number;
    success: boolean;
    /** increase = opened/added short, decrease = reduced short */
    direction: 'increase' | 'decrease';
    /** Amount of the rehedge in USDC */
    deltaUsdc: string;
    /** Amount of the rehedge in ETH */
    deltaEth: string;
    /** New hedge position size in USDC */
    newShortUsdc: string;
    /** Target short position in USDC */
    targetUsdc: string;
    /** Average execution price */
    avgPrice: string;
    /** Fees paid in USDC */
    feesUsdc: string;
    /** Current dynamic threshold (or static if dynamic disabled) */
    thresholdPercent: string;
    /** Source of threshold: decision (from strategy), dynamic, or static */
    thresholdSource: 'decision' | 'dynamic' | 'static';
    /** LP delta drift that triggered the rehedge (may be undefined for gap triggers) */
    deviationPercent?: string;
    /** Hedge adjustment as % of target (always available) */
    hedgeAdjustmentPercent?: string;
    /** Duration of the operation in ms */
    durationMs: number;
    /** Error message if failed */
    error?: string;
    /** Rehedge mode: normal, protective, gap_soft, gap_hard */
    rehedgeMode?: string;
    /** Human-readable reason for rehedge */
    reason?: string;
  };

  /** Rebalance operation completed (swap before mint) */
  'rebalance.completed': {
    timestamp: number;
    performed: boolean;
    direction: 'WETH_TO_USDC' | 'USDC_TO_WETH' | 'NONE';
    targetWethPercent: number;
    amountIn?: string;
    amountOut?: string;
    txHash?: string;
    reason: string;
    balancesBefore: {
      weth: string;
      usdc: string;
      wethPercent: string;
    };
    balancesAfter?: {
      weth: string;
      usdc: string;
      wethPercent: string;
    };
    error?: string;
  };

  'balances.get.request': {
    source: string;
    timestamp?: number;
  };
  'balances.get.response': {
    balances: {
      exchangeId: string;
      asset: string;
      free: number;
      used: number;
      total: number;
    }[];
    timestamp: number;
  };

  error: {
    source: string;
    message: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    timestamp?: number;
    error?: Error;
    ctx?: Record<string, unknown>;
  };

  /** Request to close all positions (LP + hedge) */
  'positions.close-all.request': {
    source: string;
    timestamp?: number;
  };

  /** Response after closing all positions */
  'positions.close-all.response': {
    timestamp: number;
    success: boolean;
    lp: {
      closed: boolean;
      tokenId?: string;
      collectedUsdc?: string;
      collectedWeth?: string;
      error?: string;
    };
    hedge: {
      closed: boolean;
      closedUsdc?: string;
      closedEth?: string;
      error?: string;
    };
    error?: string;
  };

  /** Request current LP and hedge positions */
  'positions.current.request': {
    source: string;
    timestamp?: number;
  };

  /** Response with current LP and hedge positions */
  'positions.current.response': {
    timestamp: number;
    lp: {
      tokenId: string;
      inRange: boolean;
      wethAmount: string;
      usdcAmount: string;
      totalValueUsdc: string;
      wethPercent: string;
      usdcPercent: string;
      tickLower: number;
      tickUpper: number;
      currentTick: number;
      priceLower: string;
      priceUpper: string;
      distanceToLowerPercent: string;
      distanceToUpperPercent: string;
    } | null;
    hedge: {
      hasPosition: boolean;
      shortSizeEth: string;
      shortNotionalUsdc: string;
      entryPrice: string;
      markPrice: string;
      unrealizedPnl: string;
      leverage: number;
      equity: string;
      availableBalance: string;
      maintenanceMargin: string;
      liquidationPrice: string;
      liquidationDistancePercent: string;
      marginRatioPercent: string;
    } | null;
    referencePrice: string;
    hedgeRatio: string;
    error?: string;
  };
}

export type EventName = keyof EventMap;
export type EventData<T extends EventName> = EventMap[T];
export type EventListener<T extends EventName> = (
  data: EventData<T>,
) => void | Promise<void>;
