import { injectable, inject } from 'tsyringe';
import Decimal from 'decimal.js';
import { ethers } from 'ethers';

import { Logger, ILogger } from '../../infra/logger/logger';
import { TOKENS } from '../../di/tokens';
import { ConfigService } from '../../config';
import type { ILpPositionService } from '../lp-position';
import type { IHedgeService } from '../hedge';
import type { ApiHealthStatus } from '../hedge/hedge.types';
import type { IPriceService } from '../price';
import type { IMonitoringService } from '../monitoring';
import type { IWalletService } from '../wallet';
import type { IStateStore } from '../state-store';
import { IRiskManager } from './risk.interface';
import {
  RiskFlags,
  RiskEvaluationInput,
  DrawdownCheckResult,
  MarginCheckResult,
  DexHealthResult,
  CexHealthResult,
  EmergencyExitDecision,
  EmergencyExitResult,
  RiskThresholds,
  RiskMonitoringState,
  HealthMetrics,
  RiskCheckStatus,
} from './risk.types';
import { RetryUtils } from '../../infra/utils';

const UNISWAP_V3_POOL_ABI = [
  'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
];

/**
 * Default risk thresholds
 * MVP values for Arbitrum + Uniswap v3 WETH/USDC 0.05% + Binance perps
 */
const DEFAULT_THRESHOLDS: RiskThresholds = {
  // Drawdown
  maxDrawdownPercent: new Decimal(10),
  warningDrawdownPercent: new Decimal(5),

  // Margin / Liquidation (MVP conservative values)
  minLiquidationDistancePercent: new Decimal(40), // 40% = safe
  dangerLiquidationDistancePercent: new Decimal(35), // 35% = margin danger
  emergencyLiquidationDistancePercent: new Decimal(15), // 15% = immediate exit
  maxMarginRatioPercent: new Decimal(20), // maint/equity <= 20%
  minMarginBufferPercent: new Decimal(30), // backward compat alias
  warningMarginBufferPercent: new Decimal(40), // warning threshold

  // RPC Health (L2 tolerant)
  maxRpcLatencyMs: 1500,
  maxRpcErrorRatePercent: new Decimal(30),
  maxBlockAgeSeconds: 20,
  rpcDownEmergencySeconds: 180, // 3 minutes

  // CEX Health
  cexTimeoutSeconds: 10, // last successful request threshold
  cexDownEmergencySeconds: 60, // 1 minute before emergency
  maxCexLatencyMs: 2500, // MVP: 2.5s timeout
  warningCexLatencyMs: 1000, // warn at 1s

  // Price Anomaly
  maxDexCexSpreadPercent: new Decimal(0.003), // 0.30%
  maxPriceSpreadBps: new Decimal(0.003).mul(10000), // 0.30% = 30 bps
  twapWindowSeconds: 300, // 5 minutes
  maxTwapDeviationPercent: new Decimal(0.0065), // 0.65%
  cexPriceStaleSeconds: 15,
  dexPriceStaleSeconds: 30,

  // Gas
  maxGasPriceGwei: new Decimal(200),

  // Failures
  maxConsecutiveFailures: 5,

  // Reset Limits
  minTimeBetweenResetsSec: 1800, // 30 minutes
  maxResetsPer24h: 3,

  // Rehedge Limits
  minRehedgeIntervalSec: 900, // 15 minutes cooldown
};

/**
 * Risk Manager
 * Veto layer - blocks dangerous actions and triggers emergency exit
 */
@injectable()
export class RiskManager implements IRiskManager {
  private readonly logger: ILogger;
  private readonly provider: ethers.JsonRpcProvider;
  private readonly poolContract: ethers.Contract;
  private thresholds: RiskThresholds;
  private state: RiskMonitoringState;
  private monitoringInterval: NodeJS.Timeout | null = null;

  // Downtime tracking
  private cexDownSince: number | null = null;
  private rpcDownSince: number | null = null;
  private readonly startedAt: number = Date.now();

  // Reset rate limiting
  private resetTimestamps: number[] = [];

  // RPC error tracking (last 60 seconds)
  private rpcErrors: Array<{ timestamp: number; success: boolean }> = [];
  private slot0Latencies: Array<{
    timestamp: number;
    latencyMs: number;
    success: boolean;
  }> = [];
  private lastBlockNumber: number | null = null;
  private lastBlockUpdateAt: number | null = null;

  constructor(
    @inject(TOKENS.LOGGER) logger: Logger,
    @inject(TOKENS.CONFIG_SERVICE)
    private readonly configService: ConfigService,
    @inject(TOKENS.LP_POSITION_SERVICE)
    private readonly lpService: ILpPositionService,
    @inject(TOKENS.HEDGE_SERVICE) private readonly hedgeService: IHedgeService,
    @inject(TOKENS.PRICE_SERVICE) private readonly priceService: IPriceService,
    @inject(TOKENS.MONITORING_SERVICE)
    private readonly monitoringService: IMonitoringService,
    @inject(TOKENS.WALLET_SERVICE)
    private readonly walletService: IWalletService,
    @inject(TOKENS.STATE_STORE) private readonly stateStore: IStateStore,
  ) {
    this.logger = logger.child('RiskManager');

    this.provider = new ethers.JsonRpcProvider(this.configService.web3.rpcUrl);
    this.poolContract = new ethers.Contract(
      this.configService.pool.poolAddress,
      UNISWAP_V3_POOL_ABI,
      this.provider,
    );

    this.thresholds = this.initializeThresholds();

    this.state = {
      isMonitoring: false,
      overallRiskLevel: 'unknown',
      checkResults: [],
      consecutiveFailures: 0,
      peakValue: new Decimal(0),
      valueHistory: [],
      inEmergencyExit: false,
      operationInProgress: false,
    };

    // Track downtime and reset counts
    this.cexDownSince = null;
    this.rpcDownSince = null;
    this.resetTimestamps = [];

    this.logger.info('RiskManager initialized', {
      maxDrawdown: this.thresholds.maxDrawdownPercent.toString(),
      minMarginBuffer: this.thresholds.minMarginBufferPercent.toString(),
      maxPriceSpread: this.thresholds.maxPriceSpreadBps.toString(),
    });
  }

  private initializeThresholds(): RiskThresholds {
    const { strategy, risk, web3 } = this.configService;

    const thresholds: RiskThresholds = {
      ...DEFAULT_THRESHOLDS,
      // Use web3 policy for gas ceiling
      maxGasPriceGwei: new Decimal(web3.maxGasPriceGwei),
    };

    // Override from strategy config if available
    if (strategy?.minTimeBetweenResetsSec) {
      thresholds.minTimeBetweenResetsSec = strategy.minTimeBetweenResetsSec;
    }
    if (strategy?.maxResetsPer24h) {
      thresholds.maxResetsPer24h = strategy.maxResetsPer24h;
    }
    if (strategy?.minRehedgeIntervalSec !== undefined) {
      thresholds.minRehedgeIntervalSec = strategy.minRehedgeIntervalSec;
    }

    // Override from risk config if available (MVP values)
    // NOTE: Config values are fractions (0.30 = 30%), but internal thresholds are percentages (30)
    // We multiply by 100 to convert fractions to percentages for comparison
    if (risk) {
      // Margin / Liquidation (config is fraction, internal is percent)
      if (risk.minLiquidationDistancePercent) {
        thresholds.minLiquidationDistancePercent = new Decimal(
          risk.minLiquidationDistancePercent,
        ).mul(100);
      }
      if (risk.dangerLiquidationDistancePercent) {
        thresholds.dangerLiquidationDistancePercent = new Decimal(
          risk.dangerLiquidationDistancePercent,
        ).mul(100);
      }
      if (risk.emergencyLiquidationDistancePercent) {
        thresholds.emergencyLiquidationDistancePercent = new Decimal(
          risk.emergencyLiquidationDistancePercent,
        ).mul(100);
      }
      if (risk.maxMarginRatioPercent) {
        thresholds.maxMarginRatioPercent = new Decimal(
          risk.maxMarginRatioPercent,
        ).mul(100);
      }

      // Price anomaly (already stored as fraction internally, no conversion needed)
      if (risk.maxDexCexSpreadPercent) {
        thresholds.maxDexCexSpreadPercent = new Decimal(
          risk.maxDexCexSpreadPercent,
        );
      }
      if (risk.twapWindowSeconds) {
        thresholds.twapWindowSeconds = risk.twapWindowSeconds;
      }

      // Max TWAP deviation from price config (already fraction, no conversion)
      const priceConfig = this.configService.price;
      if (priceConfig?.maxTwapDeviationPercent) {
        thresholds.maxTwapDeviationPercent = new Decimal(
          priceConfig.maxTwapDeviationPercent,
        );
      }

      if (risk.cexPriceStaleSeconds) {
        thresholds.cexPriceStaleSeconds = risk.cexPriceStaleSeconds;
      }
      if (risk.dexPriceStaleSeconds) {
        thresholds.dexPriceStaleSeconds = risk.dexPriceStaleSeconds;
      }

      // RPC health (config is fraction, internal is percent)
      if (risk.maxRpcLatencyMs) {
        thresholds.maxRpcLatencyMs = risk.maxRpcLatencyMs;
      }
      if (risk.maxRpcErrorRatePercent) {
        thresholds.maxRpcErrorRatePercent = new Decimal(
          risk.maxRpcErrorRatePercent,
        ).mul(100);
      }
      if (risk.maxBlockAgeSeconds) {
        thresholds.maxBlockAgeSeconds = risk.maxBlockAgeSeconds;
      }
      if (risk.rpcDownEmergencySeconds) {
        thresholds.rpcDownEmergencySeconds = risk.rpcDownEmergencySeconds;
      }

      // CEX health
      if (risk.cexTimeoutSeconds) {
        thresholds.cexTimeoutSeconds = risk.cexTimeoutSeconds;
      }
      if (risk.cexDownEmergencySeconds) {
        thresholds.cexDownEmergencySeconds = risk.cexDownEmergencySeconds;
      }

      // Drawdown (config is fraction, internal is percent)
      if (risk.maxDrawdownPercent) {
        thresholds.maxDrawdownPercent = new Decimal(
          risk.maxDrawdownPercent,
        ).mul(100);
      }
      if (risk.warningDrawdownPercent) {
        thresholds.warningDrawdownPercent = new Decimal(
          risk.warningDrawdownPercent,
        ).mul(100);
      }
    }

    thresholds.maxPriceSpreadBps = thresholds.maxDexCexSpreadPercent.mul(10000);

    return thresholds;
  }

  // ==================== Main Methods (per spec) ====================

  /**
   * Evaluate current risk based on price, LP, and hedge state
   * Implements MVP checks for Arbitrum + Uniswap v3 + Binance perps
   */
  async evaluate(input: RiskEvaluationInput): Promise<RiskFlags> {
    const timestamp = Date.now();
    const reasons: string[] = [];

    const flags: RiskFlags = {
      emergency: false,
      cexDown: false,
      rpcDown: false,
      priceAnomaly: false,
      marginDanger: false,
      liquidationRisk: false,
      drawdownExceeded: false,
      priceDisagreement: false,
      lpOutOfRange: false,
      operationInProgress: this.state.operationInProgress,
      reasons,
      timestamp,
    };

    // ==================== 1. RPC Health Check ====================
    // Checks: latency < 1500ms, error rate < 30%, block age < 20s
    try {
      const dexHealth = await this.checkDexHealth();

      const isRpcDown =
        dexHealth.rpcLatencyMs > this.thresholds.maxRpcLatencyMs ||
        !dexHealth.rpcHealthy;

      if (isRpcDown) {
        flags.rpcDown = true;
        reasons.push(
          `RPC unhealthy: latency=${dexHealth.rpcLatencyMs}ms, healthy=${dexHealth.rpcHealthy}`,
        );

        // Track RPC downtime
        if (!this.rpcDownSince) {
          this.rpcDownSince = timestamp;
        }
      } else {
        this.rpcDownSince = null;
      }

      // RPC down for too long with margin risk → emergency
      if (this.rpcDownSince) {
        const downDurationSec = (timestamp - this.rpcDownSince) / 1000;
        if (downDurationSec > this.thresholds.rpcDownEmergencySeconds) {
          if (input.hedgeSnapshot?.hasPosition) {
            flags.emergency = true;
            reasons.push(
              `RPC down ${downDurationSec.toFixed(0)}s with active hedge - cannot manage LP`,
            );
          }
        }
      }
    } catch (e) {
      flags.rpcDown = true;
      reasons.push(`RPC check failed: ${(e as Error).message}`);
      if (!this.rpcDownSince) {
        this.rpcDownSince = timestamp;
      }
    }

    // ==================== 2. CEX (Binance) Health Check ====================
    // Checks: last successful request < 10s ago, errors in a row <= 3, position/margin calls ok
    if (input.hedgeSnapshot?.apiHealth) {
      const lastSuccess = input.hedgeSnapshot.apiHealth.lastSuccessTimestamp;
      const secondsSinceSuccess = (timestamp - lastSuccess) / 1000;
      const consecutiveErrors =
        input.hedgeSnapshot.apiHealth.consecutiveErrors ?? 0;
      const consecutivePositionFailures =
        input.hedgeSnapshot.apiHealth.consecutivePositionFailures ?? 0;
      const consecutiveMarginFailures =
        input.hedgeSnapshot.apiHealth.consecutiveMarginFailures ?? 0;
      const withinGrace = timestamp - this.startedAt < 30000;

      this.logger.debug('CEX health snapshot', {
        isHealthy: input.hedgeSnapshot.apiHealth.isHealthy,
        secondsSinceSuccess: secondsSinceSuccess.toFixed(0),
        consecutiveErrors,
        consecutivePositionFailures,
        consecutiveMarginFailures,
        withinGrace,
      });

      if (
        !input.hedgeSnapshot.apiHealth.isHealthy ||
        secondsSinceSuccess > this.thresholds.cexTimeoutSeconds ||
        consecutiveErrors > 3 ||
        consecutivePositionFailures >= 2 ||
        consecutiveMarginFailures >= 2
      ) {
        if (withinGrace) {
          this.logger.warn(
            'CEX unhealthy during grace period, skipping cexDown',
            {
              secondsSinceSuccess: secondsSinceSuccess.toFixed(0),
              consecutiveErrors,
              consecutivePositionFailures,
              consecutiveMarginFailures,
            },
          );
        } else {
          try {
            const cexHealth = await RetryUtils.retry(
              () => this.checkCexHealth(),
              { maxRetries: 2, baseDelay: 300, maxDelay: 1000 },
            );
            this.logger.debug('CEX health check result', {
              status: cexHealth.status,
              isConnected: cexHealth.isConnected,
              message: cexHealth.message,
            });
            if (cexHealth.status === 'critical' || !cexHealth.isConnected) {
              flags.cexDown = true;
              reasons.push(
                `CEX down: ${secondsSinceSuccess.toFixed(0)}s since last success`,
              );
              if (consecutiveErrors > 3) {
                reasons.push(`CEX errors in a row: ${consecutiveErrors}`);
              }
              if (consecutivePositionFailures >= 2) {
                reasons.push(
                  `CEX position fetch failed ${consecutivePositionFailures}x in a row`,
                );
              }
              if (consecutiveMarginFailures >= 2) {
                reasons.push(
                  `CEX margin fetch failed ${consecutiveMarginFailures}x in a row`,
                );
              }
              if (!this.cexDownSince) {
                this.cexDownSince = timestamp;
              }
            } else {
              this.cexDownSince = null;
            }
          } catch (e) {
            flags.cexDown = true;
            reasons.push(`CEX check failed: ${(e as Error).message}`);
            if (!this.cexDownSince) {
              this.cexDownSince = timestamp;
            }
          }
        }
      } else {
        this.cexDownSince = null;
      }
    } else {
      // No hedge snapshot - check directly
      try {
        const withinGrace = timestamp - this.startedAt < 30000;
        const cexHealth = await RetryUtils.retry(() => this.checkCexHealth(), {
          maxRetries: 2,
          baseDelay: 300,
          maxDelay: 1000,
        });
        this.logger.debug('CEX health check result', {
          status: cexHealth.status,
          isConnected: cexHealth.isConnected,
          message: cexHealth.message,
          withinGrace,
        });
        if (cexHealth.status === 'critical' || !cexHealth.isConnected) {
          if (withinGrace) {
            this.logger.warn(
              'CEX unhealthy during grace period, skipping cexDown',
              {
                message: cexHealth.message,
              },
            );
          } else {
            flags.cexDown = true;
            reasons.push(`CEX unhealthy: ${cexHealth.message}`);
            if (!this.cexDownSince) {
              this.cexDownSince = timestamp;
            }
          }
        } else {
          this.cexDownSince = null;
        }
      } catch (e) {
        const withinGrace = timestamp - this.startedAt < 30000;
        if (withinGrace) {
          this.logger.warn(
            'CEX check failed during grace period, skipping cexDown',
            {
              error: (e as Error).message,
            },
          );
        } else {
          flags.cexDown = true;
          reasons.push(`CEX check failed: ${(e as Error).message}`);
          if (!this.cexDownSince) {
            this.cexDownSince = timestamp;
          }
        }
      }
    }

    // CEX down with an active hedge → emergency
    if (flags.cexDown && input.hedgeSnapshot?.hasPosition) {
      flags.emergency = true;
      reasons.push('CEX down with active hedge - cannot control short');
    }

    // ==================== 3. Price Anomaly Check ====================
    // Checks: |cexMark - dexSpot| / P_ref <= 0.30%
    if (input.priceResult) {
      if (!input.priceResult.isHealthy) {
        flags.priceAnomaly = true;
        reasons.push('Price source unhealthy');
      }

      // Check spread/deviation
      // Contract: spreadBps is in basis points (60 bps = 0.6%)
      // Contract: deviationPercent is a percent number (0.6 = 0.6%)
      // We convert spreadBps to percent by dividing by 100
      const deviationPercent =
        input.priceResult.deviationPercent ??
        (input.priceResult.spreadBps
          ? input.priceResult.spreadBps.div(100)
          : undefined);

      if (deviationPercent) {
        // maxDexCexSpreadPercent is a fraction (0.003 = 0.3%)
        // Convert to percent number for comparison with deviationPercent
        const thresholdPercent =
          this.thresholds.maxDexCexSpreadPercent.mul(100);
        if (deviationPercent.greaterThan(thresholdPercent)) {
          flags.priceAnomaly = true;
          reasons.push(
            `DEX-CEX spread too wide: ${deviationPercent.toFixed(3)}%`,
          );
        }
      } else {
        try {
          const refPrice = await this.priceService.getReferencePrice();
          if (!refPrice.isConsistent) {
            flags.priceAnomaly = true;
            flags.priceDisagreement = true;
            reasons.push(
              `Price sources disagree: deviation=${refPrice.deviationPercent.toFixed(2)}%`,
            );
          }
        } catch (e) {
          flags.priceAnomaly = true;
          reasons.push(`Price check failed: ${(e as Error).message}`);
        }
      }
    } else {
      // Check price health directly
      try {
        const refPrice = await this.priceService.getReferencePrice();
        if (!refPrice.isConsistent) {
          flags.priceAnomaly = true;
          flags.priceDisagreement = true;
          reasons.push(
            `Price sources disagree: deviation=${refPrice.deviationPercent.toFixed(2)}%`,
          );
        }
      } catch (e) {
        flags.priceAnomaly = true;
        reasons.push(`Price check failed: ${(e as Error).message}`);
      }
    }

    // Confidence gate: stale/partial sources should block reset-range
    try {
      const refPrice = await this.priceService.getReferencePrice();
      const priceConfig = this.priceService.getConfig();
      const minSources = priceConfig.minSourcesForHighConfidence ?? 2;

      if (refPrice.sources.length < minSources) {
        flags.priceAnomaly = true;
        reasons.push(
          `Price confidence low: only ${refPrice.sources.length} source(s)`,
        );
      }

      const staleWarning = refPrice.warnings.find(
        (w) =>
          w.toLowerCase().includes('stale') ||
          w.toLowerCase().includes('unavailable'),
      );
      if (staleWarning) {
        flags.priceAnomaly = true;
        reasons.push(`Price confidence low: ${staleWarning}`);
      }
    } catch (e) {
      flags.priceAnomaly = true;
      reasons.push(`Price confidence check failed: ${(e as Error).message}`);
    }

    // TWAP sanity: block swaps/mints if spot deviates too much from TWAP
    try {
      const [spot, twap] = await Promise.all([
        this.priceService.getDexPoolPrice(),
        this.priceService.getTwapPrice(
          undefined,
          this.thresholds.twapWindowSeconds,
        ),
      ]);
      // Calculate deviation as fraction (e.g., 0.0065 = 0.65%)
      const twapDeviation = spot.price.sub(twap.price).abs().div(twap.price);
      const maxTwapDeviation = this.configService.price.maxTwapDeviationPercent;
      if (twapDeviation.greaterThan(maxTwapDeviation)) {
        flags.priceAnomaly = true;
        const deviationPct = twapDeviation.mul(100).toFixed(2);
        const maxPct = new Decimal(maxTwapDeviation).mul(100).toFixed(2);
        reasons.push(
          `DEX spot vs TWAP deviation ${deviationPct}% > ${maxPct}%`,
        );
      }
    } catch (e) {
      this.logger.warn('TWAP sanity check failed', {
        error: (e as Error).message,
      });
    }

    // ==================== 4. Margin / Liquidation Check ====================
    // distance_to_liq >= 30% (safe), < 25% (danger), < 15% (emergency)
    if (input.hedgeSnapshot?.hasPosition) {
      const liqDistance = input.hedgeSnapshot.liquidationDistancePercent;

      // Check against thresholds (values are in percent, e.g., 30 = 30%)
      if (
        liqDistance.lessThan(
          this.thresholds.emergencyLiquidationDistancePercent,
        )
      ) {
        // < 15% → EMERGENCY (one spike could liquidate)
        flags.liquidationRisk = true;
        flags.marginDanger = true;
        flags.emergency = true;
        reasons.push(
          `CRITICAL: Liquidation at ${liqDistance.toFixed(2)}% (< ${this.thresholds.emergencyLiquidationDistancePercent}%)`,
        );
      } else if (
        liqDistance.lessThan(this.thresholds.dangerLiquidationDistancePercent)
      ) {
        // < 25% → marginDanger (urgent rehedge needed)
        flags.liquidationRisk = true;
        flags.marginDanger = true;
        reasons.push(
          `Margin danger: liquidation at ${liqDistance.toFixed(2)}% (< ${this.thresholds.dangerLiquidationDistancePercent}%)`,
        );
      } else if (
        liqDistance.lessThan(this.thresholds.minLiquidationDistancePercent)
      ) {
        // < 30% → warning, still allowed but needs attention
        reasons.push(
          `Margin warning: liquidation at ${liqDistance.toFixed(2)}%`,
        );
      }

      // Also check margin ratio (maint/equity should be <= 20%)
      if (input.hedgeSnapshot.marginRatio) {
        const marginRatioPercent = input.hedgeSnapshot.marginRatio.mul(100);
        if (
          marginRatioPercent.greaterThan(this.thresholds.maxMarginRatioPercent)
        ) {
          flags.marginDanger = true;
          reasons.push(
            `Margin ratio too high: ${marginRatioPercent.toFixed(2)}%`,
          );
        }
      }
    }

    // ==================== 5. LP Out of Range Check ====================
    if (input.lpComposition) {
      if (!input.lpComposition.inRange) {
        flags.lpOutOfRange = true;
        reasons.push('LP position out of range');
      }
    }

    // ==================== 6. Drawdown Check ====================
    try {
      const drawdown = await this.checkMaxDrawdown();
      if (drawdown.status === 'critical') {
        flags.drawdownExceeded = true;
        flags.emergency = true;
        reasons.push(
          `Drawdown exceeded: ${drawdown.drawdownPercent.toFixed(2)}%`,
        );
      }
    } catch (e) {
      this.logger.warn('Drawdown check failed', {
        error: (e as Error).message,
      });
    }

    // ==================== 7. Operation in Progress Check ====================
    if (this.state.operationInProgress) {
      reasons.push('Operation already in progress');
    }

    if (flags.rpcDown && this.state.operationInProgress) {
      flags.emergency = true;
      reasons.push(
        'RPC down during active operation - cannot complete reset safely',
      );
    }

    // ==================== Log and Alert ====================
    if (flags.emergency) {
      this.logger.error('RISK: EMERGENCY FLAGS SET', undefined, {
        flags,
        reasons,
      });

      await this.monitoringService.alertCritical(
        '⚠️ EMERGENCY: Risk evaluation triggered',
        {
          component: 'RiskManager',
          flags,
          reasons,
        },
      );
    } else if (
      flags.marginDanger ||
      flags.priceAnomaly ||
      flags.cexDown ||
      flags.rpcDown
    ) {
      this.logger.warn('RISK: Warning flags set', { flags, reasons });

      await this.monitoringService.alertWarn('Risk warning', {
        component: 'RiskManager',
        flags,
        reasons,
      });
    }

    // Update state
    this.state.lastRiskFlags = flags;

    return flags;
  }

  /**
   * Check if LP range reset is allowed
   * Blocks reset when conditions are unsafe
   */
  canExecuteReset(riskFlags: RiskFlags): boolean {
    const now = Date.now();

    // Block reset when:
    // - cexDown: can't safely hedge after reset
    // - rpcDown: can't guarantee on-chain steps
    // - priceAnomaly: might build incorrect range
    // - operationInProgress: avoid conflicts

    if (riskFlags.cexDown) {
      this.logger.warn('Reset blocked: CEX is down');
      return false;
    }

    if (riskFlags.rpcDown) {
      this.logger.warn('Reset blocked: RPC is down');
      return false;
    }

    if (riskFlags.priceAnomaly) {
      this.logger.warn('Reset blocked: Price anomaly detected');
      return false;
    }

    if (riskFlags.operationInProgress) {
      this.logger.warn('Reset blocked: Operation in progress');
      return false;
    }

    // Check rate limiting: minTimeBetweenResets (unless out-of-range)
    if (!riskFlags.lpOutOfRange) {
      const recentResets = this.resetTimestamps.filter(
        (ts) => now - ts < this.thresholds.minTimeBetweenResetsSec * 1000,
      );
      if (recentResets.length > 0) {
        const lastReset = Math.max(...recentResets);
        const secondsSinceReset = (now - lastReset) / 1000;
        this.logger.warn('Reset blocked: Too soon since last reset', {
          secondsSinceReset,
          minInterval: this.thresholds.minTimeBetweenResetsSec,
        });
        return false;
      }

      // Check rate limiting: maxResetsPer24h
      const resetsIn24h = this.resetTimestamps.filter(
        (ts) => now - ts < 24 * 60 * 60 * 1000,
      );
      if (resetsIn24h.length >= this.thresholds.maxResetsPer24h) {
        this.logger.warn('Reset blocked: Max resets per 24h reached', {
          resetsIn24h: resetsIn24h.length,
          max: this.thresholds.maxResetsPer24h,
        });
        return false;
      }
    }

    return true;
  }

  /**
   * Record that a reset was executed (for rate limiting)
   */
  recordReset(): void {
    const now = Date.now();
    this.resetTimestamps.push(now);

    // Cleanup old timestamps (older than 24h)
    this.resetTimestamps = this.resetTimestamps.filter(
      (ts) => now - ts < 24 * 60 * 60 * 1000,
    );

    this.logger.info('Reset recorded', {
      resetsIn24h: this.resetTimestamps.length,
    });
  }

  /**
   * Record that a rehedge was executed (for cooldown and delta tracking)
   * Persisted to MongoDB via StateStore for survival across restarts
   * @param lpWethAmount - Current WETH amount in LP at time of rehedge
   * @param rehedgeMode - Mode of rehedge ('gap_soft' triggers separate cooldown tracking)
   */
  recordRehedge(lpWethAmount: Decimal, rehedgeMode?: string): void {
    // Fire and forget - StateStore handles persistence
    this.stateStore
      .recordRehedge(lpWethAmount.toString(), rehedgeMode)
      .catch((error) => {
        this.logger.error(
          'Failed to persist rehedge to StateStore',
          error as Error,
        );
      });

    this.logger.info('Rehedge recorded', {
      cooldownSec: this.thresholds.minRehedgeIntervalSec,
      softGapCooldownSec:
        this.configService.strategy?.softGapRehedgeIntervalSec ?? 3600,
      wethAtLastHedge: lpWethAmount.toFixed(6),
      rehedgeMode: rehedgeMode || 'normal',
    });
  }

  /**
   * Get the LP WETH amount at last hedge (reference point for drift calculation)
   * Retrieved from StateStore (persisted in MongoDB)
   */
  getWethAtLastHedge(): Decimal | null {
    const wethStr = this.stateStore.getWethAtLastHedge();
    if (!wethStr) return null;
    try {
      return new Decimal(wethStr);
    } catch {
      return null;
    }
  }

  /**
   * Initialize WETH reference point (for bot startup when hedge already exists)
   * Only sets reference if not already set
   * @param lpWethAmount - Current WETH amount in LP
   */
  initializeWethReference(lpWethAmount: Decimal): void {
    // Fire and forget - StateStore handles persistence
    this.stateStore
      .initializeWethReference(lpWethAmount.toString())
      .catch((error) => {
        this.logger.error(
          'Failed to initialize WETH reference in StateStore',
          error as Error,
        );
      });
  }

  /**
   * Get rehedge cooldown status
   * Uses StateStore for persisted lastRehedgeAt
   */
  getRehedgeCooldownStatus(): {
    lastRehedgeAt: number | null;
    cooldownSec: number;
    canRehedge: boolean;
    secondsUntilNextAllowed: number;
  } {
    const now = Date.now();
    const cooldownMs = this.thresholds.minRehedgeIntervalSec * 1000;
    const lastRehedgeAt = this.stateStore.getLastRehedgeAt();

    let secondsUntilNextAllowed = 0;
    let canRehedge = true;

    if (lastRehedgeAt !== null) {
      const timeSinceLastRehedge = now - lastRehedgeAt;
      if (timeSinceLastRehedge < cooldownMs) {
        secondsUntilNextAllowed = Math.ceil(
          (cooldownMs - timeSinceLastRehedge) / 1000,
        );
        canRehedge = false;
      }
    }

    return {
      lastRehedgeAt,
      cooldownSec: this.thresholds.minRehedgeIntervalSec,
      canRehedge,
      secondsUntilNextAllowed,
    };
  }

  /**
   * Get reset rate limiting status
   */
  getResetRateLimitStatus(): {
    resetsIn24h: number;
    maxResetsAllowed: number;
    canReset: boolean;
    secondsUntilNextAllowed: number;
  } {
    const now = Date.now();
    const resetsIn24h = this.resetTimestamps.filter(
      (ts) => now - ts < 24 * 60 * 60 * 1000,
    );

    const recentResets = this.resetTimestamps.filter(
      (ts) => now - ts < this.thresholds.minTimeBetweenResetsSec * 1000,
    );

    let secondsUntilNextAllowed = 0;
    if (recentResets.length > 0) {
      const lastReset = Math.max(...recentResets);
      secondsUntilNextAllowed = Math.max(
        0,
        this.thresholds.minTimeBetweenResetsSec - (now - lastReset) / 1000,
      );
    }

    return {
      resetsIn24h: resetsIn24h.length,
      maxResetsAllowed: this.thresholds.maxResetsPer24h,
      canReset:
        resetsIn24h.length < this.thresholds.maxResetsPer24h &&
        secondsUntilNextAllowed <= 0,
      secondsUntilNextAllowed,
    };
  }

  /**
   * Check if rehedge is allowed
   * Note: If marginDanger is true, rehedge is allowed even with priceAnomaly
   * and cooldown is bypassed (risk reduction takes priority)
   *
   * @param bypassCooldown - If true, bypasses cooldown check (for gap_hard safety trigger)
   * @param bypassPriceAnomaly - If true, bypasses price anomaly check (for margin danger or gap_hard)
   * @param rehedgeMode - Rehedge mode for cooldown selection ('gap_soft' uses longer cooldown)
   */
  canExecuteRehedge(
    riskFlags: RiskFlags,
    bypassCooldown = false,
    bypassPriceAnomaly = false,
    rehedgeMode?: string,
  ): boolean {
    // Block rehedge when:
    // - cexDown: can't execute CEX orders (NEVER bypass)
    // - priceAnomaly: might use wrong price (bypass for marginDanger or explicit flag)
    // - operationInProgress: avoid conflicts (NEVER bypass)
    // - cooldown not expired (bypass for marginDanger or explicit flag)

    if (riskFlags.cexDown) {
      this.logger.warn('Rehedge blocked: CEX is down');
      return false;
    }

    // Allow rehedge during priceAnomaly ONLY if margin is in danger OR explicit bypass
    // Risk reduction takes priority over price accuracy
    if (
      riskFlags.priceAnomaly &&
      !riskFlags.marginDanger &&
      !bypassPriceAnomaly
    ) {
      this.logger.warn(
        'Rehedge blocked: Price anomaly (and no margin danger or bypass)',
      );
      return false;
    }

    if (riskFlags.operationInProgress) {
      this.logger.warn('Rehedge blocked: Operation in progress');
      return false;
    }

    // Check cooldown (bypass if margin is in danger OR explicit bypass)
    // Cooldown logic:
    // - gap_soft: must respect BOTH standard cooldown AND soft gap cooldown
    //   (uses the more restrictive of the two)
    // - normal/protective: uses standard cooldown from lastRehedgeAt
    if (!riskFlags.marginDanger && !bypassCooldown) {
      const now = Date.now();
      const isGapSoft = rehedgeMode === 'gap_soft';

      // Standard cooldown check (applies to ALL rehedge modes)
      const lastRehedgeAt = this.stateStore.getLastRehedgeAt();
      const standardCooldownSec = this.thresholds.minRehedgeIntervalSec;

      if (lastRehedgeAt !== null) {
        const standardCooldownMs = standardCooldownSec * 1000;
        const timeSinceLastRehedge = now - lastRehedgeAt;

        if (timeSinceLastRehedge < standardCooldownMs) {
          const secondsRemaining = Math.ceil(
            (standardCooldownMs - timeSinceLastRehedge) / 1000,
          );
          this.logger.info('Rehedge blocked: Standard cooldown active', {
            secondsSinceLastRehedge: Math.floor(timeSinceLastRehedge / 1000),
            cooldownSec: standardCooldownSec,
            secondsRemaining,
            rehedgeMode: rehedgeMode || 'normal',
          });
          return false;
        }
      }

      // Additional soft gap cooldown check (only for gap_soft mode)
      // This is a LONGER cooldown specifically for soft gap triggers
      if (isGapSoft) {
        const lastSoftGapRehedgeAt = this.stateStore.getLastSoftGapRehedgeAt();
        const softGapCooldownSec =
          this.configService.strategy?.softGapRehedgeIntervalSec ?? 3600;

        if (lastSoftGapRehedgeAt !== null) {
          const softGapCooldownMs = softGapCooldownSec * 1000;
          const timeSinceLastSoftGap = now - lastSoftGapRehedgeAt;

          if (timeSinceLastSoftGap < softGapCooldownMs) {
            const secondsRemaining = Math.ceil(
              (softGapCooldownMs - timeSinceLastSoftGap) / 1000,
            );
            this.logger.info('Rehedge blocked: Soft gap cooldown active', {
              secondsSinceLastSoftGap: Math.floor(timeSinceLastSoftGap / 1000),
              cooldownSec: softGapCooldownSec,
              secondsRemaining,
              rehedgeMode: 'gap_soft',
            });
            return false;
          }
        }
      }
    }

    if (bypassCooldown || bypassPriceAnomaly) {
      this.logger.warn('Rehedge risk checks BYPASSED', {
        bypassCooldown,
        bypassPriceAnomaly,
        reason: 'gap_hard safety trigger or margin danger',
      });
    }

    return true;
  }

  /**
   * Check if swap is allowed (per spec section 5)
   *
   * Blocks swap when:
   * - priceAnomaly: DEX-CEX spread too wide
   * - rpcDown: can't execute on-chain tx reliably
   * - dexTwap stale (implied by priceAnomaly check)
   *
   * If swap is blocked, ExecutionOrchestrator should abort reset
   * and stay in wallet (USDC/WETH) until conditions normalize.
   */
  canSwap(riskFlags: RiskFlags): boolean {
    // Block swap when price is unreliable
    if (riskFlags.priceAnomaly) {
      this.logger.warn('Swap blocked: Price anomaly (DEX-CEX spread or stale)');
      return false;
    }

    // Block swap when RPC is down
    if (riskFlags.rpcDown) {
      this.logger.warn('Swap blocked: RPC is down');
      return false;
    }

    // Block swap when already in emergency mode
    if (riskFlags.emergency) {
      this.logger.warn('Swap blocked: Emergency mode active');
      return false;
    }

    this.logger.debug('Swap allowed', {
      priceAnomaly: riskFlags.priceAnomaly,
      rpcDown: riskFlags.rpcDown,
    });

    return true;
  }

  // ==================== Check Methods ====================

  async checkMaxDrawdown(): Promise<DrawdownCheckResult> {
    const timestamp = Date.now();

    try {
      const currentValue = await this.getSystemEquity();

      if (currentValue.greaterThan(this.state.peakValue)) {
        this.state.peakValue = currentValue;
      }

      const drawdownPercent = this.state.peakValue.isZero()
        ? new Decimal(0)
        : this.state.peakValue
            .sub(currentValue)
            .div(this.state.peakValue.abs())
            .mul(100);

      let status: RiskCheckStatus = 'ok';
      if (
        drawdownPercent.greaterThanOrEqualTo(this.thresholds.maxDrawdownPercent)
      ) {
        status = 'critical';
      } else if (
        drawdownPercent.greaterThanOrEqualTo(
          this.thresholds.warningDrawdownPercent,
        )
      ) {
        status = 'warning';
      }

      return {
        name: 'max_drawdown',
        status,
        value: drawdownPercent,
        threshold: this.thresholds.maxDrawdownPercent,
        message: `Drawdown: ${drawdownPercent.toFixed(2)}%`,
        timestamp,
        currentPnl: currentValue,
        peakValue: this.state.peakValue,
        currentValue,
        drawdownPercent,
        maxDrawdownPercent: this.thresholds.maxDrawdownPercent,
      };
    } catch (error) {
      this.logger.error('Drawdown check failed', error as Error);
      return {
        name: 'max_drawdown',
        status: 'unknown',
        value: new Decimal(0),
        message: `Check failed: ${(error as Error).message}`,
        timestamp,
        currentPnl: new Decimal(0),
        peakValue: this.state.peakValue,
        currentValue: new Decimal(0),
        drawdownPercent: new Decimal(0),
        maxDrawdownPercent: this.thresholds.maxDrawdownPercent,
      };
    }
  }

  private async getSystemEquity(): Promise<Decimal> {
    const priceReference = await this.priceService.getReferencePrice();
    const referencePrice = priceReference.price;

    const [lpComposition, walletBalances, hedgeSnapshot] = await Promise.all([
      this.lpService.getComposition(referencePrice),
      this.walletService.getBalancesWithValue(referencePrice),
      this.hedgeService.getPosition(),
    ]);

    const walletEthValueUsdc = walletBalances.ethForGas.mul(referencePrice);
    return lpComposition.totalValueUsdc
      .add(walletBalances.totalValueUsdc || new Decimal(0))
      .add(walletEthValueUsdc)
      .add(hedgeSnapshot.equity);
  }

  async checkMarginBuffer(): Promise<MarginCheckResult> {
    const timestamp = Date.now();

    try {
      const hedgeSnapshot = await this.hedgeService.getPosition();
      const liqDistancePercent = hedgeSnapshot.liquidationDistancePercent;

      let status: RiskCheckStatus = 'ok';
      // MVP thresholds: 30% safe, 25% danger, 15% emergency
      if (
        liqDistancePercent.lessThan(
          this.thresholds.emergencyLiquidationDistancePercent,
        )
      ) {
        status = 'critical'; // < 15%
      } else if (
        liqDistancePercent.lessThan(
          this.thresholds.dangerLiquidationDistancePercent,
        )
      ) {
        status = 'critical'; // < 25% - urgent rehedge
      } else if (
        liqDistancePercent.lessThan(
          this.thresholds.minLiquidationDistancePercent,
        )
      ) {
        status = 'warning'; // < 30%
      }

      return {
        name: 'margin_buffer',
        status,
        value: liqDistancePercent,
        threshold: this.thresholds.minLiquidationDistancePercent,
        message: `Liq distance: ${liqDistancePercent.toFixed(2)}% (min: ${this.thresholds.minLiquidationDistancePercent}%)`,
        timestamp,
        marginRatio: hedgeSnapshot.marginRatio || new Decimal(0),
        availableMargin: hedgeSnapshot.availableBalance,
        maintenanceMargin: hedgeSnapshot.maintenanceMargin,
        liquidationDistance: liqDistancePercent,
        minBufferPercent: this.thresholds.minLiquidationDistancePercent,
      };
    } catch (error) {
      this.logger.error('Margin check failed', error as Error);
      return {
        name: 'margin_buffer',
        status: 'unknown',
        value: new Decimal(0),
        message: `Check failed: ${(error as Error).message}`,
        timestamp,
        marginRatio: new Decimal(0),
        availableMargin: new Decimal(0),
        maintenanceMargin: new Decimal(0),
        liquidationDistance: new Decimal(0),
        minBufferPercent: this.thresholds.minLiquidationDistancePercent,
      };
    }
  }

  async checkDexHealth(): Promise<DexHealthResult> {
    const timestamp = Date.now();
    const now = Date.now();

    try {
      const rpcStart = Date.now();
      let blockNumber: number | undefined;
      let blockTimestamp: number | undefined;
      let rpcHealthy = false;

      // Track RPC call success/failure for error rate
      try {
        blockNumber = await this.provider.getBlockNumber();
        rpcHealthy = true;

        // Record success
        this.rpcErrors.push({ timestamp: now, success: true });
        if (
          this.lastBlockNumber === null ||
          blockNumber > this.lastBlockNumber
        ) {
          this.lastBlockNumber = blockNumber;
          this.lastBlockUpdateAt = now;
        }
      } catch (e) {
        this.logger.warn('RPC call failed', { error: (e as Error).message });
        // Record failure
        this.rpcErrors.push({ timestamp: now, success: false });
      }

      const rpcLatencyMs = Date.now() - rpcStart;

      // Slot0 latency check (DEX eth_call)
      let avgSlot0LatencyMs: number | undefined;
      const slot0Start = Date.now();
      try {
        await this.poolContract.slot0();
        const latencyMs = Date.now() - slot0Start;
        this.slot0Latencies.push({ timestamp: now, latencyMs, success: true });
        this.rpcErrors.push({ timestamp: now, success: true });
      } catch (e) {
        const latencyMs = Date.now() - slot0Start;
        this.slot0Latencies.push({ timestamp: now, latencyMs, success: false });
        this.rpcErrors.push({ timestamp: now, success: false });
      }

      // Keep recent slot0 samples (last 60s, max 5)
      const slot0Cutoff = now - 60000;
      this.slot0Latencies = this.slot0Latencies.filter(
        (e) => e.timestamp > slot0Cutoff,
      );
      const recentSlot0 = this.slot0Latencies.slice(-5);
      const successfulSlot0 = recentSlot0.filter((e) => e.success);
      if (successfulSlot0.length >= 3) {
        const total = successfulSlot0.reduce((sum, e) => sum + e.latencyMs, 0);
        avgSlot0LatencyMs = total / successfulSlot0.length;
      }

      // Get block timestamp to check block age
      let blockAgeSeconds: number | undefined;
      let secondsSinceBlockUpdate: number | undefined;
      if (blockNumber && rpcHealthy) {
        try {
          const block = await this.provider.getBlock(blockNumber);
          if (block?.timestamp) {
            blockTimestamp = block.timestamp;
            blockAgeSeconds = Math.floor(now / 1000) - blockTimestamp;
          }
        } catch (e) {
          this.logger.warn('Block timestamp fetch failed');
        }
      }
      if (this.lastBlockUpdateAt) {
        secondsSinceBlockUpdate = Math.floor(
          (now - this.lastBlockUpdateAt) / 1000,
        );
      }

      // Calculate error rate over last 60 seconds
      const cutoff = now - 60000;
      this.rpcErrors = this.rpcErrors.filter((e) => e.timestamp > cutoff);
      const totalCalls = this.rpcErrors.length;
      const failedCalls = this.rpcErrors.filter((e) => !e.success).length;
      const errorRatePercent =
        totalCalls > 0 ? (failedCalls / totalCalls) * 100 : 0;

      let gasPriceGwei: Decimal | undefined;
      try {
        const feeData = await this.provider.getFeeData();
        if (feeData.gasPrice) {
          gasPriceGwei = new Decimal(feeData.gasPrice.toString()).div(1e9);
        }
      } catch (e) {
        this.logger.warn('Gas price fetch failed');
      }

      let status: RiskCheckStatus = 'ok';
      const reasons: string[] = [];

      // Check RPC connectivity
      if (!rpcHealthy) {
        status = 'critical';
        reasons.push('RPC not responding');
      }

      // Check latency (< 1500ms for L2)
      if (rpcLatencyMs > this.thresholds.maxRpcLatencyMs) {
        status = 'critical';
        reasons.push(
          `Latency ${rpcLatencyMs}ms > ${this.thresholds.maxRpcLatencyMs}ms`,
        );
      }

      if (
        avgSlot0LatencyMs &&
        avgSlot0LatencyMs > this.thresholds.maxRpcLatencyMs
      ) {
        status = 'critical';
        reasons.push(
          `slot0 latency ${avgSlot0LatencyMs.toFixed(0)}ms > ${this.thresholds.maxRpcLatencyMs}ms`,
        );
      }

      // Check error rate (< 10%)
      if (
        errorRatePercent > this.thresholds.maxRpcErrorRatePercent.toNumber()
      ) {
        status = 'critical';
        reasons.push(
          `Error rate ${errorRatePercent.toFixed(1)}% > ${this.thresholds.maxRpcErrorRatePercent}%`,
        );
      }

      // Check block age (< 15s)
      if (
        blockAgeSeconds !== undefined &&
        blockAgeSeconds > this.thresholds.maxBlockAgeSeconds
      ) {
        status = status === 'critical' ? 'critical' : 'warning';
        reasons.push(
          `Block age ${blockAgeSeconds}s > ${this.thresholds.maxBlockAgeSeconds}s`,
        );
      }

      // Check block number freshness
      if (
        secondsSinceBlockUpdate !== undefined &&
        secondsSinceBlockUpdate > this.thresholds.maxBlockAgeSeconds
      ) {
        status = 'critical';
        reasons.push(`Block number stale for ${secondsSinceBlockUpdate}s`);
      }

      // Check gas price
      if (
        gasPriceGwei &&
        gasPriceGwei.greaterThan(this.thresholds.maxGasPriceGwei)
      ) {
        status = status === 'critical' ? 'critical' : 'warning';
        reasons.push(
          `Gas ${gasPriceGwei.toFixed(1)} gwei > ${this.thresholds.maxGasPriceGwei} gwei`,
        );
      }

      const message =
        reasons.length > 0
          ? reasons.join(', ')
          : `RPC: ${rpcLatencyMs}ms, Block age: ${blockAgeSeconds ?? 'N/A'}s, Gas: ${gasPriceGwei?.toFixed(1) || 'N/A'} gwei`;

      return {
        name: 'dex_health',
        status,
        value: rpcLatencyMs,
        threshold: this.thresholds.maxRpcLatencyMs,
        message,
        timestamp,
        rpcLatencyMs,
        lastBlockNumber: blockNumber,
        blockLag: blockAgeSeconds,
        avgSlot0LatencyMs,
        secondsSinceBlockUpdate,
        revertRate: new Decimal(errorRatePercent),
        gasPriceGwei,
        rpcHealthy: status !== 'critical',
      };
    } catch (error) {
      this.logger.error('DEX health check failed', error as Error);
      return {
        name: 'dex_health',
        status: 'critical',
        value: 0,
        message: `Check failed: ${(error as Error).message}`,
        timestamp,
        rpcLatencyMs: 0,
        rpcHealthy: false,
      };
    }
  }

  async checkCexHealth(): Promise<CexHealthResult> {
    const timestamp = Date.now();

    try {
      const isConnected = this.hedgeService.isConnected();

      const apiStart = Date.now();
      let apiSuccess = false;
      let apiHealth: ApiHealthStatus | undefined;

      try {
        const snapshot = await this.hedgeService.getPosition();
        apiSuccess = true;
        apiHealth = snapshot.apiHealth;
      } catch (e) {
        this.logger.warn('CEX API call failed');
      }

      const apiLatencyMs = Date.now() - apiStart;

      let status: RiskCheckStatus = 'ok';

      if (!isConnected || !apiSuccess) {
        status = 'critical';
      } else if (apiLatencyMs > this.thresholds.maxCexLatencyMs) {
        status = 'critical';
      } else if (apiLatencyMs > this.thresholds.warningCexLatencyMs) {
        status = 'warning';
      }

      if (apiHealth?.consecutiveErrors && apiHealth.consecutiveErrors > 3) {
        status = 'critical';
      }

      if (
        (apiHealth?.consecutivePositionFailures ?? 0) >= 2 ||
        (apiHealth?.consecutiveMarginFailures ?? 0) >= 2
      ) {
        status = 'critical';
      }

      return {
        name: 'cex_health',
        status,
        value: apiLatencyMs,
        threshold: this.thresholds.maxCexLatencyMs,
        message: `API: ${apiLatencyMs}ms, Connected: ${isConnected}`,
        timestamp,
        apiLatencyMs,
        recentErrorCount: this.state.consecutiveFailures,
        errorRatePercent: new Decimal(0),
        isConnected: isConnected && apiSuccess,
        lastSuccessfulRequest: apiSuccess ? timestamp : undefined,
      };
    } catch (error) {
      this.logger.error('CEX health check failed', error as Error);
      return {
        name: 'cex_health',
        status: 'critical',
        value: 0,
        message: `Check failed: ${(error as Error).message}`,
        timestamp,
        apiLatencyMs: 0,
        recentErrorCount: this.state.consecutiveFailures,
        errorRatePercent: new Decimal(100),
        isConnected: false,
      };
    }
  }

  async runAllChecks(): Promise<HealthMetrics> {
    const [dex, cex, margin, drawdown] = await Promise.all([
      this.checkDexHealth(),
      this.checkCexHealth(),
      this.checkMarginBuffer(),
      this.checkMaxDrawdown(),
    ]);

    const statuses = [dex.status, cex.status, margin.status, drawdown.status];
    let overall: RiskCheckStatus = 'ok';

    if (statuses.includes('critical')) {
      overall = 'critical';
    } else if (statuses.includes('warning')) {
      overall = 'warning';
    } else if (statuses.includes('unknown')) {
      overall = 'unknown';
    }

    this.state.overallRiskLevel = overall;
    this.state.lastFullCheck = Date.now();
    this.state.checkResults = [dex, cex, margin, drawdown];

    return { dex, cex, margin, drawdown, overall, timestamp: Date.now() };
  }

  // ==================== Emergency ====================

  async shouldEmergencyExit(): Promise<EmergencyExitDecision> {
    const timestamp = Date.now();
    const reasons: string[] = [];
    const failedChecks: (
      | DrawdownCheckResult
      | MarginCheckResult
      | DexHealthResult
      | CexHealthResult
    )[] = [];

    const [drawdown, margin, dex, cex] = await Promise.all([
      this.checkMaxDrawdown(),
      this.checkMarginBuffer(),
      this.checkDexHealth(),
      this.checkCexHealth(),
    ]);

    if (drawdown.status === 'critical') {
      reasons.push(
        `Critical drawdown: ${drawdown.drawdownPercent.toFixed(2)}%`,
      );
      failedChecks.push(drawdown);
    }

    if (margin.status === 'critical') {
      reasons.push(
        `Critical margin: ${margin.liquidationDistance.toFixed(2)}%`,
      );
      failedChecks.push(margin);
    }

    if (dex.status === 'critical') {
      reasons.push(`DEX unhealthy: ${dex.message}`);
      failedChecks.push(dex);
    }

    if (cex.status === 'critical') {
      reasons.push(`CEX unhealthy: ${cex.message}`);
      failedChecks.push(cex);
    }

    if (
      this.state.consecutiveFailures >= this.thresholds.maxConsecutiveFailures
    ) {
      reasons.push(`Too many failures: ${this.state.consecutiveFailures}`);
    }

    let urgency: 'low' | 'medium' | 'high' | 'critical' = 'low';
    if (margin.status === 'critical' || drawdown.status === 'critical') {
      urgency = 'critical';
    } else if (failedChecks.length >= 2) {
      urgency = 'high';
    } else if (failedChecks.length === 1) {
      urgency = 'medium';
    }

    const shouldExit = reasons.length > 0 && urgency !== 'low';

    if (shouldExit) {
      this.logger.warn('Emergency exit recommended', { urgency, reasons });

      await this.monitoringService.alertCritical('Emergency exit recommended', {
        component: 'RiskManager',
        urgency,
        reasons,
      });
    }

    return {
      shouldExit,
      urgency,
      reasons,
      failedChecks,
      recommendedActions: this.getRecommendedActions(failedChecks),
      timestamp,
    };
  }

  private getRecommendedActions(
    failedChecks: (
      | DrawdownCheckResult
      | MarginCheckResult
      | DexHealthResult
      | CexHealthResult
    )[],
  ): string[] {
    const actions: string[] = [];

    for (const check of failedChecks) {
      switch (check.name) {
        case 'max_drawdown':
          actions.push('Close hedge to stop losses');
          break;
        case 'margin_buffer':
          actions.push('Reduce hedge size or add margin');
          break;
        case 'dex_health':
          actions.push('Switch RPC or pause LP ops');
          break;
        case 'cex_health':
          actions.push('Check exchange status');
          break;
      }
    }

    if (failedChecks.length > 0) {
      actions.push('Consider full emergency exit');
    }

    return [...new Set(actions)];
  }

  async emergencyExit(): Promise<EmergencyExitResult> {
    const startTime = Date.now();
    this.state.inEmergencyExit = true;

    this.logger.error('🚨 EXECUTING EMERGENCY EXIT');

    await this.monitoringService.alertCritical('🚨 EMERGENCY EXIT STARTED', {
      component: 'RiskManager',
    });

    const actionsTaken: string[] = [];
    const actionsFailed: string[] = [];
    const errors: Error[] = [];
    let finalUsdc = new Decimal(0);
    let finalEth = new Decimal(0);

    try {
      // Step 1: Close hedge position
      this.logger.info('Step 1: Closing hedge...');
      try {
        const closeResult = await this.hedgeService.reduceOnlyCloseAll();
        if (closeResult.success) {
          actionsTaken.push(
            `Closed hedge: ${closeResult.closedUsdc.toFixed(2)} USDC`,
          );
        } else {
          actionsFailed.push('Close hedge');
          if (closeResult.error) {
            errors.push(new Error(closeResult.error));
          }
        }
      } catch (error) {
        this.logger.error('Failed to close hedge', error as Error);
        errors.push(error as Error);
        actionsFailed.push('Close hedge');
      }

      // Step 2: Collect LP fees
      this.logger.info('Step 2: Collecting LP fees...');
      try {
        const tokenId = this.lpService.getTokenId();
        if (tokenId) {
          await this.lpService.collectFees();
          actionsTaken.push('Collected LP fees');
        } else {
          actionsTaken.push('No LP position to collect');
        }
      } catch (error) {
        this.logger.error('Failed to collect fees', error as Error);
        errors.push(error as Error);
        actionsFailed.push('Collect LP fees');
      }

      // Step 3: Remove LP liquidity
      this.logger.info('Step 3: Removing LP liquidity...');
      try {
        const tokenId = this.lpService.getTokenId();
        if (tokenId) {
          await this.lpService.decreaseLiquidity({ percent: 100 });
          await this.lpService.collectFees(); // Collect withdrawn tokens
          actionsTaken.push('Removed LP liquidity');
        }
      } catch (error) {
        this.logger.error('Failed to remove liquidity', error as Error);
        errors.push(error as Error);
        actionsFailed.push('Remove LP liquidity');
      }

      // Get final balances
      try {
        const hedgeSnapshot = await this.hedgeService.getPosition();
        finalUsdc = hedgeSnapshot.availableBalance;
      } catch (e) {
        this.logger.warn('Could not get final balances');
      }
    } finally {
      this.state.inEmergencyExit = false;
    }

    const result: EmergencyExitResult = {
      success: errors.length === 0,
      actionsTaken,
      actionsFailed,
      finalBalances: { usdc: finalUsdc, eth: finalEth },
      durationMs: Date.now() - startTime,
      timestamp: Date.now(),
      errors,
    };

    await this.monitoringService.alertCritical('Emergency exit completed', {
      component: 'RiskManager',
      success: result.success,
      actionsTaken: actionsTaken.length,
      actionsFailed: actionsFailed.length,
    });

    this.logger.info('Emergency exit completed', {
      success: result.success,
      durationMs: result.durationMs,
    });

    return result;
  }

  isInEmergencyExit(): boolean {
    return this.state.inEmergencyExit;
  }

  // ==================== State Management ====================

  getState(): RiskMonitoringState {
    return { ...this.state };
  }

  getThresholds(): RiskThresholds {
    return { ...this.thresholds };
  }

  updateThresholds(thresholds: Partial<RiskThresholds>): void {
    this.thresholds = { ...this.thresholds, ...thresholds };
    this.logger.info('Thresholds updated', thresholds);
  }

  updatePeakValue(value: Decimal): void {
    if (value.greaterThan(this.state.peakValue)) {
      this.state.peakValue = value;
    }
  }

  setOperationInProgress(inProgress: boolean): void {
    this.state.operationInProgress = inProgress;
    this.logger.debug('Operation in progress', { inProgress });
  }

  recordFailure(error: Error): void {
    this.state.consecutiveFailures++;
    this.logger.warn('Failure recorded', {
      count: this.state.consecutiveFailures,
      error: error.message,
    });

    if (
      this.state.consecutiveFailures >= this.thresholds.maxConsecutiveFailures
    ) {
      this.logger.error('Max consecutive failures reached!', undefined, {
        count: this.state.consecutiveFailures,
      });
    }
  }

  resetFailures(): void {
    this.state.consecutiveFailures = 0;
  }

  // ==================== Monitoring ====================

  startMonitoring(intervalMs: number = 60000): void {
    if (this.monitoringInterval) {
      this.logger.warn('Monitoring already running');
      return;
    }

    this.state.isMonitoring = true;
    this.logger.info('Starting risk monitoring', { intervalMs });

    this.monitoringInterval = setInterval(async () => {
      try {
        const metrics = await this.runAllChecks();

        if (metrics.overall === 'critical') {
          this.logger.error('CRITICAL risk level detected!', undefined, {
            dex: metrics.dex.status,
            cex: metrics.cex.status,
            margin: metrics.margin.status,
            drawdown: metrics.drawdown.status,
          });

          const exitDecision = await this.shouldEmergencyExit();
          if (exitDecision.shouldExit && exitDecision.urgency === 'critical') {
            this.logger.error('Auto-triggering emergency exit!');
            await this.emergencyExit();
          }
        }
      } catch (error) {
        this.logger.error('Risk monitoring failed', error as Error);
        this.recordFailure(error as Error);
      }
    }, intervalMs);
  }

  stopMonitoring(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
      this.state.isMonitoring = false;
      this.logger.info('Risk monitoring stopped');
    }
  }
}
