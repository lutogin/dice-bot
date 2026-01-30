import { injectable, inject } from 'tsyringe';
import Decimal from 'decimal.js';

import { Logger, ILogger } from '../../infra/logger/logger';
import { TOKENS } from '../../di/tokens';
import { ConfigService } from '../../config';
import type { IMonitoringService } from '../monitoring';
import { BinanceClient } from '../../integrations/exchanges/clients/binance/binance';
import { IHedgeService } from './hedge.interface';
import {
  HedgeSnapshot,
  HedgeAdjustResult,
  HedgeOrderMode,
  HedgeOrderModeInput,
  HedgeUrgency,
  HedgeExecutionConfig,
  EmergencyCloseResult,
  ApiHealthStatus,
  ShortPosition,
  MarginInfo,
  HedgeAdjustmentResult,
  EmergencyCloseParams,
} from './hedge.types';
import type { FundingRateData } from '../../integrations/exchanges/common/exchange.types';

/**
 * Service for managing hedge (short) positions on CEX
 * Used in ADN-CLP/hedged-LP strategy to hedge LP impermanent loss
 */
@injectable()
export class HedgeService implements IHedgeService {
  private readonly logger: ILogger;
  private readonly hedgeSymbol: string;
  private readonly minTradeNotional: Decimal;

  // API health tracking
  private apiHealth: ApiHealthStatus = {
    isHealthy: true,
    lastSuccessTimestamp: Date.now(),
    avgResponseTimeMs: 0,
    errorCountLastHour: 0,
  };
  private responseTimes: number[] = [];
  private errorTimestamps: number[] = [];
  private consecutiveErrors = 0;
  private consecutivePositionFailures = 0;
  private consecutiveMarginFailures = 0;

  constructor(
    @inject(TOKENS.LOGGER) logger: Logger,
    @inject(TOKENS.CONFIG_SERVICE)
    private readonly configService: ConfigService,
    @inject(TOKENS.MONITORING_SERVICE)
    private readonly monitoringService: IMonitoringService,
    @inject(TOKENS.BINANCE_CLIENT) private readonly client: BinanceClient,
  ) {
    this.logger = logger.child('HedgeService');

    const hedgeConfig = this.configService.hedgeExchange;
    this.hedgeSymbol = hedgeConfig.hedgeSymbol;
    this.minTradeNotional = new Decimal(hedgeConfig.minTradeNotional || 10);

    this.logger.info('HedgeService initialized', {
      exchange: hedgeConfig.id,
      symbol: this.hedgeSymbol,
      testnet: hedgeConfig.testnet,
      minTradeNotional: this.minTradeNotional.toString(),
    });
  }

  // ==================== Main Methods (per spec) ====================

  /**
   * Get current position snapshot including margin and API health
   */
  async getPosition(): Promise<HedgeSnapshot> {
    const startTime = Date.now();

    try {
      // Get position and margin info in parallel
      const [positionResult, marginResult, priceResult] =
        await Promise.allSettled([
          this.getShortPosition(),
          this.getMarginInfo(),
          this.getCurrentPrice(),
        ]);

      if (positionResult.status === 'rejected') {
        this.consecutivePositionFailures += 1;
      } else {
        this.consecutivePositionFailures = 0;
      }

      if (marginResult.status === 'rejected') {
        this.consecutiveMarginFailures += 1;
      } else {
        this.consecutiveMarginFailures = 0;
      }

      if (
        positionResult.status !== 'fulfilled' ||
        marginResult.status !== 'fulfilled' ||
        priceResult.status !== 'fulfilled'
      ) {
        const failures = [
          positionResult.status !== 'fulfilled' ? 'position' : null,
          marginResult.status !== 'fulfilled' ? 'margin' : null,
          priceResult.status !== 'fulfilled' ? 'price' : null,
        ]
          .filter(Boolean)
          .join(', ');

        const error = new Error(`Failed to fetch hedge snapshot: ${failures}`);
        this.recordApiError(error);
        throw error;
      }

      const position = positionResult.value;
      const marginInfo = marginResult.value;
      const markPrice = priceResult.value;

      if (position && position.contracts.greaterThan(0)) {
        if (position.markPrice.lessThanOrEqualTo(0)) {
          position.markPrice = markPrice;
        }
        if (position.sizeInUsdc.lessThanOrEqualTo(0)) {
          position.sizeInUsdc = position.contracts.mul(markPrice);
        }
      }

      this.recordApiSuccess(Date.now() - startTime);

      const hasPosition = position !== null && !position.contracts.isZero();

      const snapshot: HedgeSnapshot = {
        hasPosition,
        shortSizeEth: hasPosition ? position!.sizeInAsset : new Decimal(0),
        shortNotionalUsdc: hasPosition ? position!.sizeInUsdc : new Decimal(0),
        entryPrice: hasPosition ? position!.entryPrice : new Decimal(0),
        markPrice,
        unrealizedPnl: hasPosition ? position!.unrealizedPnl : new Decimal(0),
        leverage: hasPosition
          ? position!.leverage
          : this.configService.hedgeExchange.leverage,
        marginType: hasPosition ? position!.marginType : 'cross',

        // Margin info
        equity: marginInfo.equity,
        maintenanceMargin: marginInfo.maintenanceMargin,
        liquidationPrice: hasPosition
          ? position!.liquidationPrice
          : new Decimal(0),
        liquidationDistancePercent: marginInfo.liquidationDistance,
        availableBalance: marginInfo.availableBalance,

        // API health
        apiHealth: this.getApiHealth(),

        timestamp: Date.now(),
      };

      // this.logger.debug('Position snapshot retrieved', {
      //   hasPosition,
      //   shortEth: snapshot.shortSizeEth.toFixed(6),
      //   shortUsdc: snapshot.shortNotionalUsdc.toFixed(2),
      //   equity: snapshot.equity.toFixed(2),
      // });

      return snapshot;
    } catch (error) {
      this.recordApiError(error as Error);
      throw error;
    }
  }

  /**
   * Set target short position size in USDC notional
   */
  /**
   * Set target short position with maker-prefer + fallback strategy
   *
   * Supports both new urgency-based calls and legacy mode-based calls
   */
  async setTargetShortNotional(
    targetUsdc: Decimal,
    urgencyOrMode: HedgeUrgency | HedgeOrderModeInput,
  ): Promise<HedgeAdjustResult> {
    const startTime = Date.now();

    // Normalize to urgency
    const urgency = this.normalizeToUrgency(urgencyOrMode);
    const execConfig = this.getExecutionConfig();

    this.logger.info('Setting target short notional', {
      targetUsdc: targetUsdc.toString(),
      urgency,
    });

    // Block real orders in simulation mode
    if (this.configService.isSimulationMode()) {
      this.logger.info('Simulation mode: skipping actual hedge order');
      const snapshot = await this.getPosition();
      return {
        executed: false,
        modeUsed: 'NONE',
        deltaNotionalUsdc: new Decimal(0),
        avgFillPrice: snapshot.markPrice,
        feesPaid: new Decimal(0),
        reason: 'simulation mode - no real orders',
        operation: 'noop',
        deltaEth: new Decimal(0),
        orderIds: [],
        newShortNotionalUsdc: snapshot.shortNotionalUsdc,
        newShortSizeEth: snapshot.shortSizeEth,
        fillRate: new Decimal(0),
        slippageBps: new Decimal(0),
        makerAttempts: 0,
        usedFallback: false,
        timestamp: Date.now(),
        deltaUsdc: new Decimal(0),
        avgExecutionPrice: snapshot.markPrice,
        feesUsdc: new Decimal(0),
        orderMode: 'NONE',
      };
    }

    try {
      // ==================== Step 1: Get current position and diff ====================
      const snapshot = await this.getPosition();
      const currentNotional = snapshot.shortNotionalUsdc;
      const diff = targetUsdc.sub(currentNotional);
      const absDiff = diff.abs();

      // Check if within threshold - use strategy config as primary source
      // This unifies with StrategyEngine's STRATEGY_MIN_REHEDGE_AMOUNT
      const minNotional = new Decimal(
        this.configService.strategy?.minRehedgeAmountUsdc ??
          execConfig.minRehedgeNotionalUsdc ??
          10,
      );
      if (absDiff.lessThan(minNotional)) {
        this.logger.debug('Position already at target (within threshold)', {
          current: currentNotional.toString(),
          target: targetUsdc.toString(),
          diff: diff.toString(),
          threshold: minNotional.toString(),
        });

        return this.createNoopResult(snapshot, 'within threshold');
      }

      // ==================== Step 2: Determine direction ====================
      // diff > 0: need to increase short (SELL)
      // diff < 0: need to decrease short (BUY to close, reduce-only)
      const isIncreaseShort = diff.greaterThan(0);
      const side: 'buy' | 'sell' = isIncreaseShort ? 'sell' : 'buy';
      const reduceOnly = !isIncreaseShort; // Use reduce-only when decreasing to prevent flip

      this.logger.info('Hedge adjustment plan', {
        direction: isIncreaseShort ? 'INCREASE_SHORT' : 'DECREASE_SHORT',
        side,
        reduceOnly,
        amountUsdc: absDiff.toFixed(2),
        urgency,
      });

      // ==================== Step 3: Choose execution strategy by urgency ====================
      let modeUsed: HedgeOrderMode = 'NONE';
      let makerAttempts = 0;
      let usedFallback = false;
      let totalFilledUsdc = new Decimal(0);
      let totalFilledEth = new Decimal(0);
      let totalFees = new Decimal(0);
      const orderIds: string[] = [];
      let avgFillPrice = snapshot.markPrice;

      // Get max impact based on urgency
      const maxImpactBps =
        urgency === HedgeUrgency.MARGIN_DANGER
          ? execConfig.maxImpactBpsDanger
          : execConfig.maxImpactBpsNormal;

      if (urgency === HedgeUrgency.MARGIN_DANGER) {
        // ==================== MARGIN_DANGER: Skip maker, go straight to IOC/market ====================
        this.logger.warn('MARGIN_DANGER: Using immediate IOC/market execution');

        const iocResult = await this.executeIocOrMarket(
          absDiff,
          side,
          reduceOnly,
          execConfig.fallbackMode,
          maxImpactBps,
        );

        modeUsed = iocResult.modeUsed;
        totalFilledUsdc = iocResult.filledUsdc;
        totalFilledEth = iocResult.filledEth;
        totalFees = iocResult.fees;
        avgFillPrice = iocResult.avgPrice;
        orderIds.push(...iocResult.orderIds);
        usedFallback = true;
      } else {
        // ==================== NORMAL/POST_RESET: Try maker first ====================
        let remainingUsdc = absDiff;

        // Maker attempts
        for (
          let attempt = 1;
          attempt <= execConfig.maxMakerAttempts;
          attempt++
        ) {
          if (remainingUsdc.lessThan(minNotional)) break;

          makerAttempts = attempt;
          this.logger.debug(
            `Maker attempt ${attempt}/${execConfig.maxMakerAttempts}`,
            {
              remainingUsdc: remainingUsdc.toFixed(2),
            },
          );

          const makerResult = await this.executeMakerOrder(
            remainingUsdc,
            side,
            reduceOnly,
            execConfig.makerTimeoutMs,
            execConfig.makerTickOffset,
          );

          if (makerResult.filled) {
            modeUsed = 'MAKER';
            totalFilledUsdc = totalFilledUsdc.add(makerResult.filledUsdc);
            totalFilledEth = totalFilledEth.add(makerResult.filledEth);
            totalFees = totalFees.add(makerResult.fees);
            orderIds.push(...makerResult.orderIds);

            // Update remaining
            remainingUsdc = remainingUsdc.sub(makerResult.filledUsdc);

            // Update average fill price
            if (makerResult.avgPrice.greaterThan(0)) {
              avgFillPrice = makerResult.avgPrice;
            }

            this.logger.info(`Maker order filled (attempt ${attempt})`, {
              filledUsdc: makerResult.filledUsdc.toFixed(2),
              remainingUsdc: remainingUsdc.toFixed(2),
            });
          } else {
            const updatedSnapshot = await this.getPosition();
            const updatedRemaining = targetUsdc
              .sub(updatedSnapshot.shortNotionalUsdc)
              .abs();
            if (updatedRemaining.lessThan(remainingUsdc)) {
              remainingUsdc = updatedRemaining;
              this.logger.warn(
                'Position updated despite maker status; recalculated remaining',
                {
                  targetUsdc: targetUsdc.toFixed(2),
                  currentUsdc: updatedSnapshot.shortNotionalUsdc.toFixed(2),
                  remainingUsdc: remainingUsdc.toFixed(2),
                },
              );
            }
          }

          // If fully filled or remaining is small, we're done
          if (remainingUsdc.lessThan(minNotional)) {
            break;
          }

          // Wait before next attempt
          if (attempt < execConfig.maxMakerAttempts) {
            await this.sleep(execConfig.retryDelayMs);
          }
        }

        // ==================== Step 5: Fallback if needed ====================
        if (remainingUsdc.greaterThanOrEqualTo(minNotional)) {
          await this.cancelOpenOrdersForHedgeSymbol();
          const preFallbackSnapshot = await this.getPosition();
          const preFallbackDiff = targetUsdc
            .sub(preFallbackSnapshot.shortNotionalUsdc)
            .abs();
          if (preFallbackDiff.lessThan(minNotional)) {
            this.logger.warn(
              'Position updated while orders were pending, skipping fallback',
              {
                targetUsdc: targetUsdc.toFixed(2),
                currentUsdc: preFallbackSnapshot.shortNotionalUsdc.toFixed(2),
                remainingUsdc: remainingUsdc.toFixed(2),
              },
            );
            remainingUsdc = new Decimal(0);
          } else {
            remainingUsdc = preFallbackDiff;
          }
        }

        if (remainingUsdc.greaterThanOrEqualTo(minNotional)) {
          this.logger.info('Maker insufficient, using fallback', {
            remainingUsdc: remainingUsdc.toFixed(2),
            fallbackMode: execConfig.fallbackMode,
          });

          usedFallback = true;
          const fallbackResult = await this.executeIocOrMarket(
            remainingUsdc,
            side,
            reduceOnly,
            execConfig.fallbackMode,
            maxImpactBps,
          );

          modeUsed = fallbackResult.modeUsed;
          totalFilledUsdc = totalFilledUsdc.add(fallbackResult.filledUsdc);
          totalFilledEth = totalFilledEth.add(fallbackResult.filledEth);
          totalFees = totalFees.add(fallbackResult.fees);
          orderIds.push(...fallbackResult.orderIds);

          if (fallbackResult.avgPrice.greaterThan(0)) {
            avgFillPrice = fallbackResult.avgPrice;
          }
        }
      }

      // ==================== Step 6: Post-check ====================
      const newSnapshot = await this.getPosition();

      // Verify we didn't flip to long
      if (newSnapshot.shortSizeEth.lessThan(0)) {
        this.logger.error('CRITICAL: Flipped to long position!', undefined);
        await this.monitoringService.alertCritical('Hedge flipped to LONG!', {
          component: 'HedgeService',
          newShortSizeEth: newSnapshot.shortSizeEth.toString(),
        });
      }

      // Calculate slippage from mid price
      const midPrice = snapshot.markPrice;
      const slippageBps = avgFillPrice
        .sub(midPrice)
        .div(midPrice)
        .mul(10000)
        .abs();

      // Build result
      const fillRate = absDiff.isZero()
        ? new Decimal(1)
        : totalFilledUsdc.div(absDiff);
      const deltaNotional = isIncreaseShort
        ? totalFilledUsdc
        : totalFilledUsdc.neg();
      const operation = this.determineOperation(
        currentNotional,
        newSnapshot.shortNotionalUsdc,
        isIncreaseShort,
      );

      const result: HedgeAdjustResult = {
        // New fields (per spec)
        executed: totalFilledUsdc.greaterThan(0),
        modeUsed,
        deltaNotionalUsdc: deltaNotional,
        avgFillPrice,
        feesPaid: totalFees,
        reason: this.buildReason(
          modeUsed,
          makerAttempts,
          usedFallback,
          fillRate,
        ),

        // Additional details
        operation,
        deltaEth: totalFilledEth,
        orderIds,
        newShortNotionalUsdc: newSnapshot.shortNotionalUsdc,
        newShortSizeEth: newSnapshot.shortSizeEth,
        fillRate,
        slippageBps,
        makerAttempts,
        usedFallback,
        timestamp: Date.now(),

        // Legacy compatibility
        deltaUsdc: deltaNotional.abs(),
        avgExecutionPrice: avgFillPrice,
        feesUsdc: totalFees,
        orderMode: modeUsed,
      };

      this.recordApiSuccess(Date.now() - startTime);

      this.logger.info('Target short set', {
        operation: result.operation,
        modeUsed: result.modeUsed,
        deltaUsdc: result.deltaNotionalUsdc.toFixed(2),
        newNotional: result.newShortNotionalUsdc.toFixed(2),
        slippageBps: result.slippageBps.toFixed(2),
        fillRate: result.fillRate.toFixed(4),
        makerAttempts: result.makerAttempts,
        usedFallback: result.usedFallback,
      });

      return result;
    } catch (error) {
      this.recordApiError(error as Error);

      await this.monitoringService.alertCritical('Failed to set target short', {
        component: 'HedgeService',
        error: (error as Error).message,
        targetUsdc: targetUsdc.toString(),
        urgency,
      });

      throw error;
    }
  }

  // ==================== Private Execution Helpers ====================

  /**
   * Normalize urgency/mode to HedgeUrgency
   */
  private normalizeToUrgency(
    urgencyOrMode: HedgeUrgency | HedgeOrderModeInput,
  ): HedgeUrgency {
    if (typeof urgencyOrMode === 'string') {
      if (urgencyOrMode === 'makerPrefer') return HedgeUrgency.NORMAL;
      if (urgencyOrMode === 'iocMarket') return HedgeUrgency.MARGIN_DANGER;
      // If it's already a HedgeUrgency enum value
      if (Object.values(HedgeUrgency).includes(urgencyOrMode as HedgeUrgency)) {
        return urgencyOrMode as HedgeUrgency;
      }
    }
    return HedgeUrgency.NORMAL;
  }

  /**
   * Get execution config from ConfigService
   */
  private getExecutionConfig(): HedgeExecutionConfig {
    const config = this.configService.hedgeExecution;
    if (config) {
      return config as HedgeExecutionConfig;
    }

    // Default values
    return {
      makerTimeoutMs: 5000,
      maxMakerAttempts: 2,
      fallbackMode: 'IOC',
      maxImpactBpsNormal: 10,
      maxImpactBpsDanger: 50,
      makerTickOffset: 2,
      minRehedgeNotionalUsdc: 300,
      maxOrderSizeUsdc: 50000,
      retryDelayMs: 500,
    };
  }

  /**
   * Execute maker (post-only) order and wait for fill
   */
  private async executeMakerOrder(
    amountUsdc: Decimal,
    side: 'buy' | 'sell',
    reduceOnly: boolean,
    timeoutMs: number,
    tickOffset: number,
  ): Promise<{
    filled: boolean;
    filledUsdc: Decimal;
    filledEth: Decimal;
    fees: Decimal;
    avgPrice: Decimal;
    orderIds: string[];
  }> {
    try {
      // Get current market data to determine maker price
      const marketData = await this.client.getMarketData(this.hedgeSymbol);
      const markPrice = new Decimal(marketData.last);

      // For SELL (increase short): place above ask to be maker
      // For BUY (decrease short): place below bid to be maker
      // tickOffset creates space to ensure we're providing liquidity
      const tickSize = 0.01; // Typical tick for ETHUSDT
      let makerPrice: Decimal;

      if (side === 'sell') {
        // Sell: place slightly above best ask to add to ask book
        makerPrice = new Decimal(marketData.ask).add(tickSize * tickOffset);
      } else {
        // Buy: place slightly below best bid to add to bid book
        makerPrice = new Decimal(marketData.bid).sub(tickSize * tickOffset);
      }

      // Calculate amount in ETH
      const amountEth = amountUsdc.div(markPrice);

      this.logger.debug('Placing maker order', {
        side,
        amountUsdc: amountUsdc.toFixed(2),
        amountEth: amountEth.toFixed(6),
        makerPrice: makerPrice.toFixed(2),
        reduceOnly,
      });

      // Place GTX (post-only) order via Binance
      const sideUpper = side.toUpperCase() as 'BUY' | 'SELL';
      const binanceSymbol = this.client.symbolToBinance(this.hedgeSymbol);
      const preciseAmount = this.client.amountToPrecision(
        this.hedgeSymbol,
        amountEth,
      );
      const precisePrice = parseFloat(makerPrice.toFixed(2));
      const hedgeModeEnabled = this.client.isHedgeMode?.() ?? false;
      const reduceOnlySent = !hedgeModeEnabled && reduceOnly;
      const positionSide = side === 'sell' ? 'SHORT' : 'LONG';
      const positionSideResolved = hedgeModeEnabled
        ? reduceOnly
          ? side === 'buy'
            ? 'SHORT'
            : 'LONG'
          : positionSide
        : 'BOTH';

      // Don't pass newClientOrderId - binance library will generate it with correct broker prefix
      const orderParams: any = {
        symbol: binanceSymbol,
        side: sideUpper,
        type: 'LIMIT',
        quantity: preciseAmount.toNumber(),
        price: precisePrice,
        positionSide: positionSideResolved,
        timeInForce: 'GTX', // Post-only (Good-Til-Crossing)
      };

      if (reduceOnlySent) {
        orderParams.reduceOnly = 'true';
      }

      // Use the underlying client
      this.logger.debug('Submitting hedge-mode maker order', {
        symbol: this.hedgeSymbol,
        side,
        positionSide: positionSideResolved,
        reduceOnly,
        reduceOnlySent,
        quantity: preciseAmount.toNumber(),
        price: precisePrice,
        hedgeMode: hedgeModeEnabled,
      });
      const response = await (this.client as any).client.submitNewOrder(
        orderParams,
      );

      // Get clientOrderId from response - library generates it with correct broker prefix
      const clientOrderId = response.clientOrderId;
      this.logger.debug('Maker order placed', {
        clientOrderId,
        status: response.status,
      });

      // Wait for timeout
      await this.sleep(timeoutMs);

      // Check order status using clientOrderId (avoids precision loss)
      const order = await this.getRawOrderByClientId(
        clientOrderId,
        positionSideResolved,
      );

      // Cancel if not filled
      if (order.status !== 'FILLED') {
        try {
          await this.cancelRawOrderByClientId(
            clientOrderId,
            positionSideResolved,
          );
          this.logger.debug('Cancelled unfilled maker order', {
            clientOrderId,
          });
        } catch {
          // Order might already be filled/cancelled
        }
      }

      const filledAmount = new Decimal(order.executedQty || 0);
      const avgPrice = new Decimal(order.avgPrice || order.price || 0);
      const filledUsdc = filledAmount.mul(avgPrice);
      const fees = order.fee?.cost
        ? new Decimal(order.fee.cost)
        : new Decimal(0);

      return {
        filled: filledAmount.greaterThan(0),
        filledUsdc,
        filledEth: filledAmount,
        fees,
        avgPrice,
        orderIds: filledAmount.greaterThan(0) ? [clientOrderId] : [],
      };
    } catch (error) {
      this.logger.warn('Maker order failed', {
        error: (error as Error).message,
      });
      return {
        filled: false,
        filledUsdc: new Decimal(0),
        filledEth: new Decimal(0),
        fees: new Decimal(0),
        avgPrice: new Decimal(0),
        orderIds: [],
      };
    }
  }

  /**
   * Execute IOC or Market order
   */
  private async executeIocOrMarket(
    amountUsdc: Decimal,
    side: 'buy' | 'sell',
    reduceOnly: boolean,
    mode: 'IOC' | 'MARKET',
    maxImpactBps: number,
  ): Promise<{
    modeUsed: HedgeOrderMode;
    filledUsdc: Decimal;
    filledEth: Decimal;
    fees: Decimal;
    avgPrice: Decimal;
    orderIds: string[];
  }> {
    try {
      // Get current price
      const marketData = await this.client.getMarketData(this.hedgeSymbol);
      const markPrice = new Decimal(marketData.last);
      const amountEth = amountUsdc.div(markPrice);

      this.logger.info(`Executing ${mode} order`, {
        side,
        amountUsdc: amountUsdc.toFixed(2),
        amountEth: amountEth.toFixed(6),
        reduceOnly,
        maxImpactBps,
      });

      const sideUpper = side.toUpperCase() as 'BUY' | 'SELL';
      const binanceSymbol = this.client.symbolToBinance(this.hedgeSymbol);
      const preciseAmount = this.client.amountToPrecision(
        this.hedgeSymbol,
        amountEth,
      );
      const hedgeModeEnabled = this.client.isHedgeMode?.() ?? false;
      const reduceOnlySent = !hedgeModeEnabled && reduceOnly;
      const positionSide = side === 'sell' ? 'SHORT' : 'LONG';
      const positionSideResolved = hedgeModeEnabled
        ? reduceOnly
          ? side === 'buy'
            ? 'SHORT'
            : 'LONG'
          : positionSide
        : 'BOTH';

      let order: any;
      let lastClientOrderId: string | undefined;

      if (mode === 'IOC') {
        // IOC limit order at slightly worse price to ensure fill
        const priceBuffer = markPrice.mul(maxImpactBps).div(10000);
        const iocPrice =
          side === 'buy'
            ? markPrice.add(priceBuffer) // Pay more to buy
            : markPrice.sub(priceBuffer); // Accept less to sell

        // Don't pass newClientOrderId - binance library will generate it with correct broker prefix
        const orderParams: any = {
          symbol: binanceSymbol,
          side: sideUpper,
          type: 'LIMIT',
          quantity: preciseAmount.toNumber(),
          price: parseFloat(iocPrice.toFixed(2)),
          positionSide: positionSideResolved,
          timeInForce: 'IOC',
        };

        if (reduceOnlySent) {
          orderParams.reduceOnly = 'true';
        }

        this.logger.debug('Submitting hedge-mode IOC order', {
          symbol: this.hedgeSymbol,
          side,
          positionSide: positionSideResolved,
          reduceOnly,
          reduceOnlySent,
          quantity: preciseAmount.toNumber(),
          price: parseFloat(iocPrice.toFixed(2)),
          hedgeMode: hedgeModeEnabled,
        });
        const response = await (this.client as any).client.submitNewOrder(
          orderParams,
        );

        // Get clientOrderId from response
        const clientOrderId = response.clientOrderId;
        lastClientOrderId = clientOrderId;

        // IOC should be immediately done or cancelled
        await this.sleep(500);
        order = await this.getRawOrderByClientId(
          clientOrderId,
          positionSideResolved,
        );
      } else {
        // MARKET order
        // Don't pass newClientOrderId - binance library will generate it with correct broker prefix
        const orderParams: any = {
          symbol: binanceSymbol,
          side: sideUpper,
          type: 'MARKET',
          quantity: preciseAmount.toNumber(),
          positionSide: positionSideResolved,
        };

        if (reduceOnlySent) {
          orderParams.reduceOnly = 'true';
        }

        this.logger.debug('Submitting hedge-mode market order', {
          symbol: this.hedgeSymbol,
          side,
          positionSide: positionSideResolved,
          reduceOnly,
          reduceOnlySent,
          quantity: preciseAmount.toNumber(),
          hedgeMode: hedgeModeEnabled,
        });
        const response = await (this.client as any).client.submitNewOrder(
          orderParams,
        );

        // Get clientOrderId from response
        const clientOrderId = response.clientOrderId;
        lastClientOrderId = clientOrderId;

        await this.sleep(500);
        order = await this.getRawOrderByClientId(
          clientOrderId,
          positionSideResolved,
        );
      }

      const filledAmount = new Decimal(order.executedQty || 0);
      const avgPrice = new Decimal(order.avgPrice || order.price || markPrice);
      const filledUsdc = filledAmount.mul(avgPrice);
      const fees = order.fee?.cost
        ? new Decimal(order.fee.cost)
        : new Decimal(0);

      return {
        modeUsed: mode === 'IOC' ? 'IOC' : 'MARKET',
        filledUsdc,
        filledEth: filledAmount,
        fees,
        avgPrice,
        orderIds:
          filledAmount.greaterThan(0) && lastClientOrderId
            ? [lastClientOrderId]
            : [],
      };
    } catch (error) {
      this.logger.error(`${mode} order failed`, error as Error);
      return {
        modeUsed: mode === 'IOC' ? 'IOC' : 'MARKET',
        filledUsdc: new Decimal(0),
        filledEth: new Decimal(0),
        fees: new Decimal(0),
        avgPrice: new Decimal(0),
        orderIds: [],
      };
    }
  }

  /**
   * Create no-op result
   */
  private createNoopResult(
    snapshot: HedgeSnapshot,
    reason: string,
  ): HedgeAdjustResult {
    return {
      executed: false,
      modeUsed: 'NONE',
      deltaNotionalUsdc: new Decimal(0),
      avgFillPrice: snapshot.markPrice,
      feesPaid: new Decimal(0),
      reason,
      operation: 'noop',
      deltaEth: new Decimal(0),
      orderIds: [],
      newShortNotionalUsdc: snapshot.shortNotionalUsdc,
      newShortSizeEth: snapshot.shortSizeEth,
      fillRate: new Decimal(1),
      slippageBps: new Decimal(0),
      makerAttempts: 0,
      usedFallback: false,
      timestamp: Date.now(),
      // Legacy
      deltaUsdc: new Decimal(0),
      avgExecutionPrice: snapshot.markPrice,
      feesUsdc: new Decimal(0),
      orderMode: 'NONE',
    };
  }

  /**
   * Determine operation type based on position change
   */
  private determineOperation(
    previousNotional: Decimal,
    newNotional: Decimal,
    isIncreaseShort: boolean,
  ): 'open' | 'increase' | 'decrease' | 'close' | 'noop' {
    if (previousNotional.isZero() && newNotional.greaterThan(0)) {
      return 'open';
    }
    if (!previousNotional.isZero() && newNotional.isZero()) {
      return 'close';
    }
    if (isIncreaseShort) {
      return previousNotional.isZero() ? 'open' : 'increase';
    }
    return 'decrease';
  }

  private async getRawOrder(
    orderId: string,
    positionSide: 'LONG' | 'SHORT' | 'BOTH',
  ): Promise<any> {
    const binanceSymbol = this.client.symbolToBinance(this.hedgeSymbol);
    const hedgeModeEnabled = this.client.isHedgeMode?.() ?? false;

    // Keep orderId as string to avoid precision loss
    // Binance order IDs can exceed Number.MAX_SAFE_INTEGER
    // usdm-client accepts orderId as string
    const params: any = {
      symbol: binanceSymbol,
      orderId: orderId,
    };
    if (hedgeModeEnabled) {
      params.positionSide = positionSide;
    }
    return (this.client as any).client.getOrder(params);
  }

  private async cancelRawOrder(
    orderId: string,
    positionSide: 'LONG' | 'SHORT' | 'BOTH',
  ): Promise<void> {
    const binanceSymbol = this.client.symbolToBinance(this.hedgeSymbol);
    const hedgeModeEnabled = this.client.isHedgeMode?.() ?? false;

    // Keep orderId as string to avoid precision loss
    const params: any = {
      symbol: binanceSymbol,
      orderId: orderId,
    };
    if (hedgeModeEnabled) {
      params.positionSide = positionSide;
    }
    await (this.client as any).client.cancelOrder(params);
  }

  /**
   * Get order by client order ID (avoids orderId precision loss)
   */
  private async getRawOrderByClientId(
    clientOrderId: string,
    positionSide: 'LONG' | 'SHORT' | 'BOTH',
  ): Promise<any> {
    const binanceSymbol = this.client.symbolToBinance(this.hedgeSymbol);
    const hedgeModeEnabled = this.client.isHedgeMode?.() ?? false;

    const params: any = {
      symbol: binanceSymbol,
      origClientOrderId: clientOrderId,
    };
    if (hedgeModeEnabled) {
      params.positionSide = positionSide;
    }
    return (this.client as any).client.getOrder(params);
  }

  /**
   * Cancel order by client order ID (avoids orderId precision loss)
   */
  private async cancelRawOrderByClientId(
    clientOrderId: string,
    positionSide: 'LONG' | 'SHORT' | 'BOTH',
  ): Promise<void> {
    const binanceSymbol = this.client.symbolToBinance(this.hedgeSymbol);
    const hedgeModeEnabled = this.client.isHedgeMode?.() ?? false;

    const params: any = {
      symbol: binanceSymbol,
      origClientOrderId: clientOrderId,
    };
    if (hedgeModeEnabled) {
      params.positionSide = positionSide;
    }
    await (this.client as any).client.cancelOrder(params);
  }

  private async cancelOpenOrdersForHedgeSymbol(): Promise<void> {
    try {
      const binanceSymbol = this.client.symbolToBinance(this.hedgeSymbol);
      await (this.client as any).client.cancelAllOpenOrders({
        symbol: binanceSymbol,
      });
      this.logger.debug('Cancelled all open hedge orders', {
        symbol: this.hedgeSymbol,
      });
    } catch (error) {
      this.logger.warn('Failed to cancel open hedge orders', {
        error: (error as Error).message,
      });
    }
  }

  /**
   * Build human-readable reason string
   */
  private buildReason(
    modeUsed: HedgeOrderMode,
    makerAttempts: number,
    usedFallback: boolean,
    fillRate: Decimal,
  ): string {
    const parts: string[] = [];

    if (modeUsed === 'NONE') {
      return 'No execution needed';
    }

    if (makerAttempts > 0) {
      parts.push(`${makerAttempts} maker attempt(s)`);
    }

    if (usedFallback) {
      parts.push(`fallback to ${modeUsed}`);
    } else if (modeUsed === 'MAKER') {
      parts.push('maker success');
    }

    parts.push(`fill rate: ${fillRate.mul(100).toFixed(1)}%`);

    return parts.join(', ');
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Emergency reduce-only close of entire position
   */
  async reduceOnlyCloseAll(): Promise<EmergencyCloseResult> {
    this.logger.warn('EMERGENCY: Reduce-only close all triggered');

    // Block real orders in simulation mode
    if (this.configService.isSimulationMode()) {
      this.logger.info('Simulation mode: skipping emergency close');
      return {
        success: true,
        closedUsdc: new Decimal(0),
        closedEth: new Decimal(0),
        executionPrice: new Decimal(0),
        feesUsdc: new Decimal(0),
        orderId: 'simulation',
        timestamp: Date.now(),
      };
    }

    const startTime = Date.now();

    try {
      const position = await this.getShortPosition();

      if (!position || position.contracts.isZero()) {
        this.logger.info('No position to close');
        return {
          success: true,
          closedUsdc: new Decimal(0),
          closedEth: new Decimal(0),
          executionPrice: new Decimal(0),
          feesUsdc: new Decimal(0),
          orderId: '',
          timestamp: Date.now(),
        };
      }

      const markPrice = await this.getCurrentPrice();

      // Use market order for fastest execution
      const order = await this.client.closePosition({
        symbol: this.hedgeSymbol,
        side: 'buy', // Buy to close short
        amount: position.contracts.toNumber(),
      });

      const executionPrice = new Decimal(order.price || markPrice);
      const closedUsdc = position.contracts.mul(executionPrice);
      const feesUsdc = order.fee?.cost
        ? new Decimal(order.fee.cost)
        : new Decimal(0);

      this.recordApiSuccess(Date.now() - startTime);

      await this.monitoringService.alertWarn('Emergency close executed', {
        component: 'HedgeService',
        closedEth: position.contracts.toString(),
        closedUsdc: closedUsdc.toString(),
        executionPrice: executionPrice.toString(),
      });

      this.logger.info('Emergency close completed', {
        closedEth: position.contracts.toFixed(6),
        closedUsdc: closedUsdc.toFixed(2),
        executionPrice: executionPrice.toFixed(2),
        orderId: order.id,
      });

      return {
        success: true,
        closedUsdc,
        closedEth: position.contracts,
        executionPrice,
        feesUsdc,
        orderId: order.id,
        timestamp: Date.now(),
      };
    } catch (error) {
      this.recordApiError(error as Error);

      await this.monitoringService.alertCritical('Emergency close FAILED', {
        component: 'HedgeService',
        error: error as Error,
      });

      return {
        success: false,
        closedUsdc: new Decimal(0),
        closedEth: new Decimal(0),
        executionPrice: new Decimal(0),
        feesUsdc: new Decimal(0),
        orderId: '',
        error: (error as Error).message,
        timestamp: Date.now(),
      };
    }
  }

  // ==================== API Health ====================

  private getApiHealth(): ApiHealthStatus {
    // Clean old error timestamps (older than 1 hour)
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    this.errorTimestamps = this.errorTimestamps.filter((t) => t > oneHourAgo);

    // Calculate average response time
    const avgResponseTimeMs =
      this.responseTimes.length > 0
        ? this.responseTimes.reduce((a, b) => a + b, 0) /
          this.responseTimes.length
        : 0;

    // Determine if healthy
    const isHealthy =
      this.errorTimestamps.length < 10 &&
      this.consecutiveErrors <= 3 &&
      this.consecutivePositionFailures < 2 &&
      this.consecutiveMarginFailures < 2 &&
      avgResponseTimeMs < 5000;

    this.apiHealth = {
      ...this.apiHealth,
      isHealthy,
      avgResponseTimeMs,
      errorCountLastHour: this.errorTimestamps.length,
      consecutiveErrors: this.consecutiveErrors,
      consecutivePositionFailures: this.consecutivePositionFailures,
      consecutiveMarginFailures: this.consecutiveMarginFailures,
    };

    return this.apiHealth;
  }

  private recordApiSuccess(responseTimeMs: number): void {
    this.apiHealth.lastSuccessTimestamp = Date.now();
    this.responseTimes.push(responseTimeMs);
    this.consecutiveErrors = 0;

    // Keep last 100 response times
    if (this.responseTimes.length > 100) {
      this.responseTimes.shift();
    }
  }

  private recordApiError(error: Error): void {
    this.apiHealth.lastError = error.message;
    this.apiHealth.lastErrorTimestamp = Date.now();
    this.errorTimestamps.push(Date.now());
    this.consecutiveErrors += 1;

    this.logger.error('API error recorded', error);

    // Alert if too many errors
    if (this.errorTimestamps.length >= 5) {
      this.monitoringService.alertWarn(
        'High API error rate on hedge exchange',
        {
          component: 'HedgeService',
          errorCount: this.errorTimestamps.length,
          lastError: error.message,
        },
      );
    }
  }

  // ==================== Legacy/Helper Methods ====================

  isConnected(): boolean {
    return this.client.isConnected();
  }

  async connect(): Promise<void> {
    this.logger.info('Connecting to hedge exchange...');
    await this.client.connect();

    const hedgeConfig = this.configService.hedgeExchange;
    // await this.client.setLeverage(this.hedgeSymbol, hedgeConfig.leverage);
    // await this.client.setMarginMode(this.hedgeSymbol, hedgeConfig.marginMode);

    this.logger.info('Connected to hedge exchange', {
      symbol: this.hedgeSymbol,
      leverage: hedgeConfig.leverage,
      marginMode: hedgeConfig.marginMode,
    });
  }

  async ping(): Promise<boolean> {
    return this.client.ping();
  }

  async getFundingRate(symbol?: string): Promise<FundingRateData> {
    const targetSymbol = symbol || this.hedgeSymbol;
    return this.client.getFundingRate(targetSymbol);
  }

  async disconnect(): Promise<void> {
    this.logger.info('Disconnecting from hedge exchange...');
    await this.client.disconnect();
    this.logger.info('Disconnected from hedge exchange');
  }

  async getShortPosition(symbol?: string): Promise<ShortPosition | null> {
    const targetSymbol = symbol || this.hedgeSymbol;

    try {
      const position = await this.client.getPosition({
        symbol: targetSymbol,
        skipZeroPositions: true,
      });

      if (!position || position.contracts === 0) {
        return null;
      }

      const markPrice = new Decimal(position.markPrice || 0);
      const contracts = new Decimal(position.contracts || 0);

      return {
        symbol: targetSymbol,
        side: position.side as 'short' | 'long',
        sizeInAsset: contracts,
        sizeInUsdc: contracts.mul(markPrice),
        entryPrice: new Decimal(position.entryPrice || 0),
        markPrice,
        unrealizedPnl: new Decimal(position.unrealizedPnl || 0),
        realizedPnl: position.realizedPnl
          ? new Decimal(position.realizedPnl)
          : undefined,
        leverage: position.leverage || 1,
        marginType: position.marginType as 'cross' | 'isolated',
        liquidationPrice: new Decimal(position.liquidationPrice || 0),
        contracts,
        exchangeId: position.exchangeId || this.configService.hedgeExchange.id,
      };
    } catch (error) {
      this.logger.error('Failed to get short position', error as Error, {
        symbol: targetSymbol,
      });
      throw error;
    }
  }

  async getMarginInfo(): Promise<MarginInfo> {
    try {
      const accountInfo = await this.client.getAccountInfo();

      const equity = new Decimal(accountInfo.totalMarginBalance);
      const maintenanceMargin = new Decimal(accountInfo.totalMaintMargin);
      const usedMargin = new Decimal(accountInfo.totalInitialMargin);

      const marginRatio = equity.isZero()
        ? new Decimal(0)
        : usedMargin.div(equity);

      const liquidationDistance = equity.isZero()
        ? new Decimal(0)
        : equity.sub(maintenanceMargin).div(equity).mul(100);

      return {
        equity,
        availableBalance: new Decimal(accountInfo.availableBalance),
        usedMargin,
        maintenanceMargin,
        marginRatio,
        liquidationDistance,
        unrealizedPnl: new Decimal(accountInfo.totalUnrealizedProfit),
        walletBalance: new Decimal(accountInfo.totalWalletBalance),
      };
    } catch (error) {
      this.logger.error('Failed to get margin info', error as Error);
      throw error;
    }
  }

  async getCurrentPrice(): Promise<Decimal> {
    return this.client.getCurrentPrice(this.hedgeSymbol);
  }

  /**
   * Get realized volatility for the hedge symbol
   * Uses log-returns from OHLCV data
   */
  async getVolatility(
    timeframe: string = '30m',
    limit: number = 48,
  ): Promise<Decimal> {
    return this.client.getVolatility(this.hedgeSymbol, timeframe, limit);
  }

  async reduceOnlyClose(
    params: EmergencyCloseParams,
  ): Promise<HedgeAdjustmentResult> {
    const { amount, closeAll = false, useMarketOrder = true } = params;

    this.logger.warn('Emergency reduce-only close triggered', {
      amount: amount?.toString(),
      closeAll,
      useMarketOrder,
    });

    try {
      const position = await this.getShortPosition();

      if (!position || position.contracts.isZero()) {
        throw new Error('No short position to close');
      }

      let amountToClose: Decimal;

      if (closeAll) {
        amountToClose = position.contracts;
      } else if (amount) {
        amountToClose = Decimal.min(amount, position.contracts);
      } else {
        throw new Error('Either amount or closeAll must be specified');
      }

      const currentPrice = await this.getCurrentPrice();
      const closeSide = 'buy';

      let order;
      const orderType = useMarketOrder ? 'market' : 'limit';

      if (useMarketOrder) {
        order = await this.client.closePosition({
          symbol: this.hedgeSymbol,
          side: closeSide,
          amount: amountToClose.toNumber(),
        });
      } else {
        order = await this.client.closePositionLimit(
          {
            symbol: this.hedgeSymbol,
            side: closeSide,
            amount: amountToClose.toNumber(),
          },
          {
            maxRetries: 3,
            fallbackToMarket: true,
            maxSlippagePercent: 0.5,
          },
        );
      }

      const executionPrice = new Decimal(order.price || currentPrice);
      const closedUsdc = amountToClose.mul(executionPrice);

      return {
        operation: 'close',
        amountUsdc: closedUsdc,
        amountAsset: amountToClose,
        executionPrice,
        orderId: order.id,
        orderType,
        newPositionSizeUsdc: position.sizeInUsdc.sub(closedUsdc),
        timestamp: order.timestamp,
      };
    } catch (error) {
      this.logger.error('Failed to execute emergency close', error as Error);
      throw error;
    }
  }

  async openOrIncreaseShort(
    amountUsdc: Decimal,
    useLimitOrder: boolean = true,
  ): Promise<HedgeAdjustmentResult> {
    this.logger.info('Opening/increasing short position', {
      amountUsdc: amountUsdc.toString(),
      useLimitOrder,
    });

    try {
      const currentPrice = await this.getCurrentPrice();
      const amountInAsset = amountUsdc.div(currentPrice);

      const marginInfo = await this.getMarginInfo();
      const marginConfig = this.configService.margin;

      if (marginInfo.marginRatio.greaterThan(marginConfig.targetMarginRatio)) {
        this.logger.warn('Margin ratio exceeds target', {
          currentRatio: marginInfo.marginRatio.toString(),
          targetRatio: marginConfig.targetMarginRatio,
        });

        await this.monitoringService.alertWarn(
          'Margin ratio high when opening short',
          {
            component: 'HedgeService',
            marginRatio: marginInfo.marginRatio.toNumber(),
            target: marginConfig.targetMarginRatio,
          },
        );
      }

      const side = 'sell';
      const currentPosition = await this.getShortPosition();
      const operation =
        currentPosition && currentPosition.contracts.greaterThan(0)
          ? 'increase'
          : 'open';

      let order;
      const orderType = useLimitOrder ? 'limit' : 'market';

      if (useLimitOrder) {
        order = await this.client.openPositionLimit(
          {
            symbol: this.hedgeSymbol,
            side,
            amount: amountInAsset.toNumber(),
          },
          {
            maxRetries: 5,
            fallbackToMarket: true,
            maxSlippagePercent: 0.1,
          },
        );
      } else {
        order = await this.client.openPosition({
          symbol: this.hedgeSymbol,
          side,
          amount: amountInAsset.toNumber(),
        });
      }

      const executionPrice = new Decimal(order.price || currentPrice);
      const filledUsdc = new Decimal(order.filled).mul(executionPrice);

      const newPosition = await this.getShortPosition();
      const newPositionSizeUsdc = newPosition?.sizeInUsdc || new Decimal(0);

      this.logger.info('Short position opened/increased', {
        operation,
        filledAsset: order.filled,
        filledUsdc: filledUsdc.toString(),
        orderId: order.id,
      });

      return {
        operation,
        amountUsdc: filledUsdc,
        amountAsset: new Decimal(order.filled),
        executionPrice,
        orderId: order.id,
        orderType,
        newPositionSizeUsdc,
        fees: order.fees?.cost ? new Decimal(order.fees.cost) : undefined,
        timestamp: order.timestamp,
      };
    } catch (error) {
      this.logger.error('Failed to open/increase short', error as Error);
      throw error;
    }
  }

  async decreaseShort(
    amountUsdc: Decimal,
    useLimitOrder: boolean = true,
  ): Promise<HedgeAdjustmentResult> {
    this.logger.info('Decreasing short position', {
      amountUsdc: amountUsdc.toString(),
      useLimitOrder,
    });

    try {
      const currentPosition = await this.getShortPosition();

      if (!currentPosition || currentPosition.contracts.isZero()) {
        throw new Error('No short position to decrease');
      }

      const currentPrice = await this.getCurrentPrice();
      let amountInAsset = amountUsdc.div(currentPrice);

      if (amountInAsset.greaterThan(currentPosition.contracts)) {
        amountInAsset = currentPosition.contracts;
      }

      const side = 'buy';
      const isFullClose = amountInAsset.equals(currentPosition.contracts);
      const operation = isFullClose ? 'close' : 'decrease';

      let order;
      const orderType = useLimitOrder ? 'limit' : 'market';

      if (useLimitOrder) {
        order = await this.client.closePositionLimit(
          {
            symbol: this.hedgeSymbol,
            side,
            amount: amountInAsset.toNumber(),
          },
          {
            maxRetries: 5,
            fallbackToMarket: true,
            maxSlippagePercent: 0.1,
          },
        );
      } else {
        order = await this.client.closePosition({
          symbol: this.hedgeSymbol,
          side,
          amount: amountInAsset.toNumber(),
        });
      }

      const executionPrice = new Decimal(order.price || currentPrice);
      const closedUsdc = new Decimal(order.filled).mul(executionPrice);

      const newPosition = await this.getShortPosition();
      const newPositionSizeUsdc = newPosition?.sizeInUsdc || new Decimal(0);

      this.logger.info('Short position decreased', {
        operation,
        closedAsset: order.filled,
        closedUsdc: closedUsdc.toString(),
        orderId: order.id,
      });

      return {
        operation,
        amountUsdc: closedUsdc,
        amountAsset: new Decimal(order.filled),
        executionPrice,
        orderId: order.id,
        orderType,
        newPositionSizeUsdc,
        fees: order.fees?.cost ? new Decimal(order.fees.cost) : undefined,
        timestamp: order.timestamp,
      };
    } catch (error) {
      this.logger.error('Failed to decrease short', error as Error);
      throw error;
    }
  }

  async syncWithLpPosition(
    lpEthAmount: Decimal,
  ): Promise<HedgeAdjustmentResult | null> {
    this.logger.info('Syncing hedge with LP position', {
      lpEthAmount: lpEthAmount.toString(),
    });

    try {
      const currentPrice = await this.getCurrentPrice();
      const targetNotionalUsdc = lpEthAmount.mul(currentPrice);

      const result = await this.setTargetShortNotional(
        targetNotionalUsdc,
        'makerPrefer',
      );

      if (result.operation === 'noop') {
        return null;
      }

      // Convert HedgeAdjustResult to HedgeAdjustmentResult for compatibility
      return {
        operation: result.operation as
          | 'open'
          | 'increase'
          | 'decrease'
          | 'close',
        amountUsdc: result.deltaUsdc,
        amountAsset: result.deltaEth,
        executionPrice: result.avgExecutionPrice,
        orderId: result.orderIds[0] || '',
        orderType: result.modeUsed === 'MAKER' ? 'limit' : 'market',
        newPositionSizeUsdc: result.newShortNotionalUsdc,
        fees: result.feesUsdc,
        timestamp: result.timestamp,
      };
    } catch (error) {
      this.logger.error('Failed to sync with LP position', error as Error);
      throw error;
    }
  }

  /**
   * Estimate the cost of executing a hedge trade
   * Components:
   * 1. Spread cost: (ask - bid) / mid * notional * 0.5 (half spread)
   * 2. Funding rate impact: 8h funding * notional (one period)
   * 3. Slippage estimate: ~0.01% for small trades
   */
  async estimateHedgeCost(notionalUsdc: Decimal): Promise<Decimal> {
    try {
      // Get order book for spread
      const orderBook = await this.client.getOrderBook(this.hedgeSymbol, 5);

      if (!orderBook.bids.length || !orderBook.asks.length) {
        this.logger.warn('Empty order book, cannot estimate hedge cost');
        return new Decimal(0);
      }

      const bestBid = new Decimal(orderBook.bids[0][0]);
      const bestAsk = new Decimal(orderBook.asks[0][0]);
      const midPrice = bestBid.add(bestAsk).div(2);

      // Spread cost (half spread applied to notional)
      const spreadPct = bestAsk.sub(bestBid).div(midPrice);
      const spreadCost = notionalUsdc.mul(spreadPct).div(2);

      // Funding rate impact (8h funding * notional)
      let fundingCost = new Decimal(0);
      try {
        const fundingData = await this.getFundingRate();
        // Funding rate is per interval (usually 8h), take absolute value
        fundingCost = notionalUsdc.mul(fundingData.rate.abs());
      } catch {
        // Funding rate fetch failed, continue without it
      }

      // Slippage estimate: 0.01% for small trades, up to 0.05% for larger
      const slippagePct = notionalUsdc.gt(50000)
        ? new Decimal(0.0005) // 0.05% for large trades
        : new Decimal(0.0001); // 0.01% for small trades
      const slippageCost = notionalUsdc.mul(slippagePct);

      const totalCost = spreadCost.add(fundingCost).add(slippageCost);

      this.logger.debug('Hedge cost estimate', {
        notionalUsdc: notionalUsdc.toFixed(2),
        spreadPct: (spreadPct.toNumber() * 100).toFixed(4) + '%',
        spreadCost: spreadCost.toFixed(2),
        fundingCost: fundingCost.toFixed(2),
        slippageCost: slippageCost.toFixed(2),
        totalCost: totalCost.toFixed(2),
      });

      return totalCost;
    } catch (error) {
      this.logger.warn('Failed to estimate hedge cost', {
        error: (error as Error).message,
      });
      return new Decimal(0);
    }
  }
}
