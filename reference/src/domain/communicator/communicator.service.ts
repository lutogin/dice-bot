import { injectable, inject } from 'tsyringe';
import dayjs from 'dayjs';
import Decimal from 'decimal.js';

import { Logger, ILogger } from '../../infra/logger/logger';
import { TOKENS } from '../../di/tokens';
import type { EventData } from '../../infra/event-bus/event-bus.types';
import {
  EventHandler,
  setupEventHandlers,
} from '../../infra/event-bus/event-bus.decorators';
import { EventBus } from '../../infra/event-bus/event-bus';
import { TelegramService } from '../../integrations/telegram';
import { ConfigService } from '../../config';
import { ICommunicatorService } from './communicator.interface';
import type { ILpPositionService } from '../lp-position/lp-position.interface';
import type { IHedgeService } from '../hedge/hedge.interface';
import type { IPriceService } from '../price/price.interface';
import type { IWalletService } from '../wallet/wallet.interface';

/**
 * Escape special characters for Telegram Markdown (legacy mode)
 * Characters: _ * [ ] ( ) ~ ` > # + - = | { } . !
 * In legacy Markdown mode, only _ * ` [ need escaping
 */
function escapeMarkdown(text: string): string {
  return text
    .replace(/_/g, '\\_')
    .replace(/\*/g, '\\*')
    .replace(/\[/g, '\\[')
    .replace(/`/g, '\\`');
}

@injectable()
export class CommunicatorService implements ICommunicatorService {
  private readonly logger: ILogger;

  constructor(
    @inject(TOKENS.LOGGER) logger: Logger,
    @inject(TOKENS.TELEGRAM_SERVICE)
    private readonly telegramService: TelegramService,
    @inject(TOKENS.CONFIG_SERVICE)
    private readonly configService: ConfigService,
    @inject(TOKENS.EVENT_BUS) private readonly eventBus: EventBus,
    @inject(TOKENS.LP_POSITION_SERVICE)
    private readonly lpPositionService: ILpPositionService,
    @inject(TOKENS.HEDGE_SERVICE) private readonly hedgeService: IHedgeService,
    @inject(TOKENS.PRICE_SERVICE) private readonly priceService: IPriceService,
    @inject(TOKENS.WALLET_SERVICE)
    private readonly walletService: IWalletService,
  ) {
    this.logger = logger.child('Communicator');
    setupEventHandlers(this);
  }

  @EventHandler('balances.get.request')
  async handleBalancesRequest(
    _params: EventData<'balances.get.request'>,
  ): Promise<void> {
    this.logger.debug('Received balances request');

    try {
      // Get reference price
      const priceRef = await this.priceService.getReferencePrice();
      const referencePrice = new Decimal(priceRef.price);

      // Get wallet balances (Web3)
      const walletBalances =
        await this.walletService.getBalancesWithValue(referencePrice);

      // Get Binance futures account info
      const hedgeSnapshot = await this.hedgeService.getPosition();

      // Get LP position value
      let lpTotalUsdc = new Decimal(0);
      let lpData: {
        weth: Decimal;
        usdc: Decimal;
        inRange: boolean;
        tokenId: string;
      } | null = null;
      try {
        const composition =
          await this.lpPositionService.getComposition(referencePrice);
        lpTotalUsdc = composition.totalValueUsdc;
        lpData = {
          weth: composition.wethAmount,
          usdc: composition.usdcAmount,
          inRange: composition.inRange,
          tokenId: this.lpPositionService.getTokenId() || 'N/A',
        };
      } catch {
        // LP position not available
      }

      // Calculate totals
      const walletTotalUsdc = walletBalances.totalValueUsdc || new Decimal(0);
      const binanceTotalUsdc = hedgeSnapshot.equity;
      const grandTotalUsdc = walletTotalUsdc
        .add(binanceTotalUsdc)
        .add(lpTotalUsdc);

      // Format message
      const lines: string[] = [];
      lines.push('💰 *Account Balances*');
      lines.push('');

      // Web3 Wallet section
      lines.push('🔗 *Web3 Wallet:*');
      lines.push(`├ USDC: $${walletBalances.usdc.toFixed(2)}`);
      lines.push(
        `├ WETH: ${walletBalances.weth.toFixed(6)} (~$${walletBalances.wethValueUsdc?.toFixed(2) || '0.00'})`,
      );
      lines.push(`├ ETH (gas): ${walletBalances.ethForGas.toFixed(6)}`);
      lines.push(`└ Total: *$${walletTotalUsdc.toFixed(2)}*`);
      lines.push('');

      // LP Position section
      lines.push('🏊 *LP Position:*');
      if (lpData) {
        const rangeEmoji = lpData.inRange ? '✅' : '⚠️';
        lines.push(`├ Token: \`${lpData.tokenId}\``);
        lines.push(`├ WETH: ${lpData.weth.toFixed(6)}`);
        lines.push(`├ USDC: $${lpData.usdc.toFixed(2)}`);
        lines.push(
          `├ In Range: ${rangeEmoji} ${lpData.inRange ? 'Yes' : 'No'}`,
        );
        lines.push(`└ Total: *$${lpTotalUsdc.toFixed(2)}*`);
      } else {
        lines.push(`└ No active LP position`);
      }
      lines.push('');

      // Binance Futures section
      lines.push('📊 *Binance Futures:*');
      lines.push(`├ Equity: $${hedgeSnapshot.equity.toFixed(2)}`);
      lines.push(`├ Available: $${hedgeSnapshot.availableBalance.toFixed(2)}`);
      if (hedgeSnapshot.hasPosition) {
        lines.push(
          `├ Position: ${hedgeSnapshot.shortSizeEth.toFixed(4)} ETH short`,
        );
        lines.push(
          `├ Notional: $${hedgeSnapshot.shortNotionalUsdc.toFixed(2)}`,
        );
        lines.push(
          `├ Unrealized PnL: $${hedgeSnapshot.unrealizedPnl.toFixed(2)}`,
        );
        lines.push(
          `└ Liq Distance: ${hedgeSnapshot.liquidationDistancePercent.toFixed(1)}%`,
        );
      } else {
        lines.push(`└ No open position`);
      }
      lines.push('');

      // Grand total
      lines.push('━━━━━━━━━━━━━━━━━━━━');
      lines.push(`💵 *Grand Total: $${grandTotalUsdc.toFixed(2)}*`);

      await this.telegramService.sendMessageWithMarkdown(lines.join('\n'));
    } catch (error) {
      this.logger.error('Failed to get balances', error as Error);
      await this.telegramService.sendMessageWithMarkdown(
        `❌ *Failed to get balances*\n\nError: ${(error as Error).message}`,
      );
    }
  }

  @EventHandler('balances.get.response')
  async sendBalancesResponse(
    params: EventData<'balances.get.response'>,
  ): Promise<void> {
    const message = this.formatBalancesMessage(params.balances);
    this.telegramService.sendBalancesMessage(message);
  }

  @EventHandler('positions.current.request')
  async handleCurrentPositionsRequest(
    _params: EventData<'positions.current.request'>,
  ): Promise<void> {
    this.logger.debug('Received current positions request');

    try {
      // Get reference price
      const priceRef = await this.priceService.getReferencePrice();
      const referencePrice = new Decimal(priceRef.dexPrice ?? priceRef.price);

      // Get LP composition
      let lpData: EventData<'positions.current.response'>['lp'] = null;
      try {
        const composition =
          await this.lpPositionService.getComposition(referencePrice);
        const position = await this.lpPositionService.getPosition();
        const totalValue = composition.totalValueUsdc;
        const wethPercent = totalValue.gt(0)
          ? composition.wethValueUsdc.div(totalValue).mul(100)
          : new Decimal(0);
        const usdcPercent = totalValue.gt(0)
          ? composition.usdcAmount.div(totalValue).mul(100)
          : new Decimal(0);

        lpData = {
          tokenId: position.tokenId,
          inRange: composition.inRange,
          wethAmount: composition.wethAmount.toFixed(6),
          usdcAmount: composition.usdcAmount.toFixed(2),
          totalValueUsdc: composition.totalValueUsdc.toFixed(2),
          wethPercent: wethPercent.toFixed(1),
          usdcPercent: usdcPercent.toFixed(1),
          tickLower: composition.tickLower,
          tickUpper: composition.tickUpper,
          currentTick: composition.currentTick,
          priceLower: position.priceLower?.toFixed(2) ?? '0',
          priceUpper: position.priceUpper?.toFixed(2) ?? '0',
          distanceToLowerPercent: composition.distanceToLowerPercent.toFixed(2),
          distanceToUpperPercent: composition.distanceToUpperPercent.toFixed(2),
        };
      } catch (error) {
        this.logger.warn('Failed to get LP composition', {
          error: (error as Error).message,
        });
      }

      // Get hedge snapshot
      let hedgeData: EventData<'positions.current.response'>['hedge'] = null;
      try {
        const snapshot = await this.hedgeService.getPosition();
        hedgeData = {
          hasPosition: snapshot.hasPosition,
          shortSizeEth: snapshot.shortSizeEth.toFixed(6),
          shortNotionalUsdc: snapshot.shortNotionalUsdc.toFixed(2),
          entryPrice: snapshot.entryPrice.toFixed(2),
          markPrice: snapshot.markPrice.toFixed(2),
          unrealizedPnl: snapshot.unrealizedPnl.toFixed(2),
          leverage: snapshot.leverage,
          equity: snapshot.equity.toFixed(2),
          availableBalance: snapshot.availableBalance.toFixed(2),
          maintenanceMargin: snapshot.maintenanceMargin.toFixed(2),
          liquidationPrice: snapshot.liquidationPrice.toFixed(2),
          liquidationDistancePercent:
            snapshot.liquidationDistancePercent.toFixed(2),
          marginRatioPercent: (
            snapshot.marginRatio?.mul(100) ?? new Decimal(0)
          ).toFixed(2),
        };
      } catch (error) {
        this.logger.warn('Failed to get hedge snapshot', {
          error: (error as Error).message,
        });
      }

      // Calculate hedge ratio
      let hedgeRatio = '0.00';
      if (lpData && hedgeData) {
        const lpEthNotional = new Decimal(lpData.wethAmount).mul(
          referencePrice,
        );
        if (lpEthNotional.gt(0)) {
          hedgeRatio = new Decimal(hedgeData.shortNotionalUsdc)
            .div(lpEthNotional)
            .mul(100)
            .toFixed(2);
        }
      }

      // Emit response
      this.eventBus.emit('positions.current.response', {
        timestamp: Date.now(),
        lp: lpData,
        hedge: hedgeData,
        referencePrice: referencePrice.toFixed(2),
        hedgeRatio,
      });
    } catch (error) {
      this.logger.error('Failed to get current positions', error as Error);
      this.eventBus.emit('positions.current.response', {
        timestamp: Date.now(),
        lp: null,
        hedge: null,
        referencePrice: '0',
        hedgeRatio: '0',
        error: (error as Error).message,
      });
    }
  }

  @EventHandler('positions.close-all.request')
  async handleCloseAllRequest(
    _params: EventData<'positions.close-all.request'>,
  ): Promise<void> {
    this.logger.info('Received close-all positions request');

    const result: EventData<'positions.close-all.response'> = {
      timestamp: Date.now(),
      success: true,
      lp: { closed: false },
      hedge: { closed: false },
    };

    // Block in simulation mode
    if (this.configService.isSimulationMode()) {
      this.logger.info('Simulation mode: skipping close-all');
      result.error = 'Simulation mode - no real positions closed';
      this.eventBus.emit('positions.close-all.response', result);
      return;
    }

    try {
      // Step 1: Close LP position (decrease liquidity + collect + burn)
      try {
        const tokenId = this.lpPositionService.getTokenId();
        if (tokenId && tokenId !== '0') {
          this.logger.info('Closing LP position', { tokenId });

          // Decrease 100% liquidity
          const decreaseResult = await this.lpPositionService.decreaseLiquidity(
            { percent: 100 },
          );
          if (!decreaseResult.success) {
            throw new Error('Failed to decrease liquidity');
          }

          // Collect fees
          const collectResult = await this.lpPositionService.collectFees();

          // Burn the position
          await this.lpPositionService.burnPosition(tokenId);

          result.lp = {
            closed: true,
            tokenId,
            collectedUsdc: collectResult.amount1?.toFixed(2) ?? '0',
            collectedWeth: collectResult.amount0?.toFixed(6) ?? '0',
          };

          this.logger.info('LP position closed', result.lp);
        } else {
          result.lp = { closed: false, error: 'No active LP position' };
        }
      } catch (error) {
        this.logger.error('Failed to close LP position', error as Error);
        result.lp = { closed: false, error: (error as Error).message };
        result.success = false;
      }

      // Step 2: Close hedge position
      try {
        const hedgeSnapshot = await this.hedgeService.getPosition();
        if (hedgeSnapshot.hasPosition && hedgeSnapshot.shortSizeEth.gt(0)) {
          this.logger.info('Closing hedge position', {
            shortEth: hedgeSnapshot.shortSizeEth.toFixed(6),
          });

          const closeResult = await this.hedgeService.reduceOnlyCloseAll();

          result.hedge = {
            closed: closeResult.success,
            closedUsdc: closeResult.closedUsdc?.toFixed(2),
            closedEth: closeResult.closedEth?.toFixed(6),
            error: closeResult.success ? undefined : 'Close failed',
          };

          this.logger.info('Hedge position closed', result.hedge);
        } else {
          result.hedge = { closed: false, error: 'No active hedge position' };
        }
      } catch (error) {
        this.logger.error('Failed to close hedge position', error as Error);
        result.hedge = { closed: false, error: (error as Error).message };
        result.success = false;
      }

      // Emit response
      this.eventBus.emit('positions.close-all.response', result);
    } catch (error) {
      this.logger.error('Close-all failed', error as Error);
      this.eventBus.emit('positions.close-all.response', {
        timestamp: Date.now(),
        success: false,
        lp: { closed: false },
        hedge: { closed: false },
        error: (error as Error).message,
      });
    }
  }

  @EventHandler('positions.close-all.response')
  async handleCloseAllResponse(
    data: EventData<'positions.close-all.response'>,
  ): Promise<void> {
    const lines: string[] = [];

    if (data.success) {
      lines.push('✅ *Positions Closed*');
    } else {
      lines.push('⚠️ *Close All - Partial Failure*');
    }

    lines.push('');

    // LP status
    if (data.lp.closed) {
      lines.push(`📈 *LP Position*: ✅ Closed`);
      lines.push(`├ Token ID: ${data.lp.tokenId}`);
      lines.push(`├ Collected WETH: ${data.lp.collectedWeth}`);
      lines.push(`└ Collected USDC: $${data.lp.collectedUsdc}`);
    } else {
      lines.push(`📈 *LP Position*: ${data.lp.error || 'Not closed'}`);
    }

    lines.push('');

    // Hedge status
    if (data.hedge.closed) {
      lines.push(`🔻 *Hedge Position*: ✅ Closed`);
      lines.push(`├ Closed ETH: ${data.hedge.closedEth}`);
      lines.push(`└ Closed USDC: $${data.hedge.closedUsdc}`);
    } else {
      lines.push(`🔻 *Hedge Position*: ${data.hedge.error || 'Not closed'}`);
    }

    if (data.error) {
      lines.push('');
      lines.push(`❌ Error: ${data.error}`);
    }

    await this.telegramService.sendMessageWithMarkdown(lines.join('\n'));
  }

  @EventHandler('reset.completed')
  async handleResetCompleted(
    data: EventData<'reset.completed'>,
  ): Promise<void> {
    const lines: string[] = [];

    if (data.error || !data.success) {
      lines.push('❌ *LP Reset Failed*');
      lines.push('');
      if (data.error) {
        lines.push(`Error: ${data.error}`);
      }
    } else {
      lines.push('🔁 *LP Range Reset Completed*');
      lines.push('');

      if (data.reason) {
        lines.push(`📝 Reason: ${data.reason}`);
        lines.push('');
      }

      lines.push('📊 *Old Range:*');
      lines.push(`├ Token: \`${data.oldTokenId}\``);
      lines.push(`├ Ticks: [${data.oldTickLower}, ${data.oldTickUpper}]`);
      lines.push(`└ Price: $${data.oldPriceLower} - $${data.oldPriceUpper}`);
      lines.push('');

      lines.push('📊 *New Range:*');
      lines.push(`├ Token: \`${data.newTokenId}\``);
      lines.push(`├ Ticks: [${data.newTickLower}, ${data.newTickUpper}]`);
      lines.push(`├ Price: $${data.newPriceLower} - $${data.newPriceUpper}`);
      lines.push(`└ Value: $${data.newTotalValueUsdc}`);
      lines.push('');

      lines.push('💰 *Collected Fees:*');
      lines.push(`├ WETH: ${data.collectedWeth}`);
      lines.push(`└ USDC: $${data.collectedUsdc}`);
      lines.push('');

      lines.push(`⏱ Duration: ${(data.durationMs / 60 / 1000).toFixed(1)}min`);
      lines.push(`📍 Ref Price: $${data.referencePrice}`);
    }

    await this.telegramService.sendMessageWithMarkdown(lines.join('\n'));
  }

  @EventHandler('rehedge.completed')
  async handleRehedgeCompleted(
    data: EventData<'rehedge.completed'>,
  ): Promise<void> {
    const lines: string[] = [];

    if (data.error || !data.success) {
      lines.push('❌ *Rehedge Failed*');
      lines.push('');
      if (data.error) {
        lines.push(`Error: ${data.error}`);
      }
    } else {
      const directionEmoji = data.direction === 'increase' ? '📈' : '📉';
      const directionText =
        data.direction === 'increase' ? 'Increase Short' : 'Reduce Short';

      lines.push(`🔄 *Rehedge Completed*`);
      lines.push('');

      // Show reason if provided
      // if (data.reason) {
      //   lines.push(`📋 Reason: ${escapeMarkdown(data.reason)}`);
      //   lines.push('');
      // }

      lines.push(`${directionEmoji} *${directionText}*`);
      lines.push('');
      lines.push(`├ Delta: $${data.deltaUsdc} (${data.deltaEth} ETH)`);
      lines.push(`├ New Position: $${data.newShortUsdc}`);
      lines.push(`├ Target: $${data.targetUsdc}`);
      lines.push(`├ Avg Price: $${data.avgPrice}`);
      lines.push(`└ Fees: $${data.feesUsdc}`);
      lines.push('');
      lines.push('📊 *Trigger Info:*');
      if (data.rehedgeMode) {
        lines.push(`├ Mode: ${escapeMarkdown(data.rehedgeMode)}`);
      }
      lines.push(`├ LP Delta Drift: ${data.deviationPercent ?? 'N/A'}%`);
      lines.push(`├ Threshold: ${data.thresholdPercent}%`);
      lines.push(`├ Source: ${data.thresholdSource}`);

      // Calculate hedge gap for diagnostic purposes
      const currentShort = new Decimal(data.newShortUsdc).sub(
        new Decimal(data.deltaUsdc),
      );
      const targetShort = new Decimal(data.targetUsdc);
      const hedgeGap = targetShort.sub(currentShort).abs();
      const hedgeGapPercent = targetShort.gt(0)
        ? hedgeGap.div(targetShort).mul(100).toFixed(2)
        : '0.00';
      lines.push(`├ Hedge Gap: ${hedgeGapPercent}% (diagnostic)`);
      lines.push(`└ Duration: ${(data.durationMs / 60 / 1000).toFixed(1)}min`);
    }

    await this.telegramService.sendMessageWithMarkdown(lines.join('\n'));
  }

  @EventHandler('rebalance.completed')
  async handleRebalanceCompleted(
    data: EventData<'rebalance.completed'>,
  ): Promise<void> {
    const lines: string[] = [];

    if (data.error) {
      lines.push('❌ *Rebalance Failed*');
      lines.push('');
      lines.push(`Error: ${data.error}`);
    } else if (data.performed) {
      const directionEmoji = data.direction === 'WETH_TO_USDC' ? '⬇️' : '⬆️';
      const directionText =
        data.direction === 'WETH_TO_USDC' ? 'WETH → USDC' : 'USDC → WETH';

      lines.push(`🔄 *Rebalance Completed*`);
      lines.push('');
      lines.push(`${directionEmoji} Direction: ${directionText}`);
      lines.push(`├ Amount In: ${data.amountIn}`);
      lines.push(`├ Amount Out: ${data.amountOut ?? 'N/A'}`);
      lines.push(`├ Target WETH: ${data.targetWethPercent}%`);
      lines.push(`└ Tx: \`${data.txHash?.slice(0, 10)}...\``);
      lines.push('');
      lines.push('📊 *Before:*');
      lines.push(
        `├ WETH: ${data.balancesBefore.weth} (${data.balancesBefore.wethPercent}%)`,
      );
      lines.push(`└ USDC: $${data.balancesBefore.usdc}`);

      if (data.balancesAfter) {
        lines.push('');
        lines.push('📊 *After:*');
        lines.push(
          `├ WETH: ${data.balancesAfter.weth} (${data.balancesAfter.wethPercent}%)`,
        );
        lines.push(`└ USDC: $${data.balancesAfter.usdc}`);
      }
    } else {
      // Rebalance not performed (within threshold or below min notional)
      lines.push('ℹ️ *Rebalance Skipped*');
      lines.push('');
      lines.push(`Reason: ${data.reason}`);
      lines.push(`Target WETH: ${data.targetWethPercent}%`);
      lines.push('');
      lines.push('📊 *Current:*');
      lines.push(
        `├ WETH: ${data.balancesBefore.weth} (${data.balancesBefore.wethPercent}%)`,
      );
      lines.push(`└ USDC: $${data.balancesBefore.usdc}`);
    }

    await this.telegramService.sendMessageWithMarkdown(lines.join('\n'));
  }

  @EventHandler('error')
  async sendErrorMessage(params: EventData<'error'>): Promise<void> {
    const message = [
      `❌ ${params.message}`,
      `  🕒 ${dayjs(params.timestamp || dayjs().utc().valueOf())
        .tz(this.configService.userTz)
        .format('YYYY-MM-DD HH:mm:ss')}`,
      `  Source: ${params.source}`,
      `  Severity: ${params.severity}`,
    ];

    if (params.error) {
      message.push(`  ‼️ ${params.error.message}`);
    }

    if (params.ctx) {
      Object.entries(params.ctx).forEach(([key, value]) => {
        message.push(
          `  📍 ${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`,
        );
      });
    }

    this.telegramService.sendMessageWithMarkdown(message.join('\n'));
  }

  private formatBalancesMessage(
    balances: EventData<'balances.get.response'>['balances'],
  ): string {
    if (balances.length === 0) {
      return '📊 *Current Balances*\n\n🔍 No balances found';
    }

    const lines = ['📊 *Current Balances*', ''];

    balances.forEach((balance, index) => {
      lines.push(`${index + 1}. *${balance.exchangeId}*`);
      lines.push(
        `  🟢 ${balance.free.toFixed(2)} 🔴 ${balance.used.toFixed(2)}`,
      );
      lines.push(`  💰 *${balance.total.toFixed(2)}* ${balance.asset}`);
    });
    lines.push('-'.repeat(5));
    lines.push(
      `📈 Total: *${balances.reduce((acc, balance) => acc + balance.total, 0).toFixed(2)}* ${balances[0].asset}`,
    );

    return lines.join('\n');
  }
}
