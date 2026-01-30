import { injectable, inject } from 'tsyringe';
import Decimal from 'decimal.js';
import { ethers } from 'ethers';
import { Token } from '@uniswap/sdk-core';
import {
  Pool,
  Position,
  nearestUsableTick,
  TickMath,
  TICK_SPACINGS,
  FeeAmount,
} from '@uniswap/v3-sdk';
import JSBI from 'jsbi';

import { Logger, ILogger } from '../../infra/logger/logger';
import { TOKENS } from '../../di/tokens';
import { ConfigService } from '../../config';
import type { IWalletService } from '../wallet';
import type { ITxPolicyService } from '../tx-policy';
import type { IMonitoringService } from '../monitoring';
import { ILpPositionService } from './lp-position.interface';
import {
  PositionInfo,
  PoolState,
  CompositionResult,
  LpTxResult,
  MintPositionParams,
  DecreaseLiquidityParams,
  CollectFeesResult,
  MintForBudgetParams,
  MintForBudgetResult,
  BudgetPolicy,
  WalletPositionSummary,
  WalletPositionsResult,
} from './lp-position.types';

// Uniswap v3 NonfungiblePositionManager ABI (minimal + ERC721 enumerable)
const POSITION_MANAGER_ABI = [
  'function positions(uint256 tokenId) external view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function collect(tuple(uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) external payable returns (uint256 amount0, uint256 amount1)',
  'function decreaseLiquidity(tuple(uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params) external payable returns (uint256 amount0, uint256 amount1)',
  'function increaseLiquidity(tuple(uint256 tokenId, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params) external payable returns (uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function mint(tuple(address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline) params) external payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function burn(uint256 tokenId) external payable',
  'function ownerOf(uint256 tokenId) external view returns (address)',
  // ERC721 Enumerable
  'function balanceOf(address owner) external view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) external view returns (uint256)',
];

// Uniswap v3 Pool ABI (minimal)
const POOL_ABI = [
  'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function liquidity() external view returns (uint128)',
  'function token0() external view returns (address)',
  'function token1() external view returns (address)',
  'function fee() external view returns (uint24)',
];

const MAX_UINT128 = BigInt('340282366920938463463374607431768211455');
const ERC721_TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');

type PoolTokenMapping = {
  token0Address: string;
  token1Address: string;
  token0Symbol: string;
  token1Symbol: string;
  token0Decimals: number;
  token1Decimals: number;
  wethIsToken0: boolean;
};

/**
 * LP Position Service
 * Manages Uniswap v3 LP NFT positions
 */
@injectable()
export class LpPositionService implements ILpPositionService {
  private readonly logger: ILogger;
  private readonly provider: ethers.JsonRpcProvider;
  private readonly wallet: ethers.Wallet;
  private readonly positionManager: ethers.Contract;
  private readonly poolContract: ethers.Contract;

  // Currently tracked token ID
  private tokenId: string | null = null;

  // Token info cache
  private token0: Token | null = null;
  private token1: Token | null = null;
  private poolTokenMapping: PoolTokenMapping | null = null;
  private tokensInitialized = false;

  constructor(
    @inject(TOKENS.LOGGER) logger: Logger,
    @inject(TOKENS.CONFIG_SERVICE)
    private readonly configService: ConfigService,
    @inject(TOKENS.WALLET_SERVICE)
    private readonly walletService: IWalletService,
    @inject(TOKENS.TX_POLICY_SERVICE)
    private readonly txPolicyService: ITxPolicyService,
    @inject(TOKENS.MONITORING_SERVICE)
    private readonly monitoringService: IMonitoringService,
  ) {
    this.logger = logger.child('LpPositionService');

    const { web3, pool } = this.configService;

    this.provider = new ethers.JsonRpcProvider(web3.rpcUrl);
    this.wallet = new ethers.Wallet(web3.privateKey, this.provider);

    this.positionManager = new ethers.Contract(
      web3.positionManagerAddress,
      POSITION_MANAGER_ABI,
      this.wallet,
    );

    this.poolContract = new ethers.Contract(
      pool.poolAddress,
      POOL_ABI,
      this.provider,
    );

    // Initialize token info
    this.initializeTokens();
    void this.refreshPoolTokenMapping();

    this.logger.info('LpPositionService initialized', {
      chainId: web3.chainId,
      pool: pool.poolAddress,
      positionManager: web3.positionManagerAddress,
    });
  }

  /**
   * Initialize token objects from config
   */
  private initializeTokens(): void {
    const { pool, web3 } = this.configService;

    this.token0 = new Token(
      web3.chainId,
      pool.token0Address,
      pool.token0Decimals,
      pool.token0Symbol,
      pool.token0Symbol,
    );

    this.token1 = new Token(
      web3.chainId,
      pool.token1Address,
      pool.token1Decimals,
      pool.token1Symbol,
      pool.token1Symbol,
    );
  }

  private async refreshPoolTokenMapping(): Promise<void> {
    try {
      const mapping = await this.getPoolTokenMapping();
      this.poolTokenMapping = mapping;
      await this.ensureTokensInitialized();
    } catch (error) {
      this.logger.error('Failed to load pool token mapping', error as Error);
    }
  }

  private resolveTokenAddressBySymbol(symbols: string[]): string | null {
    const { pool } = this.configService;
    const normalized = symbols.map((symbol) => symbol.toLowerCase());

    if (normalized.includes(pool.token0Symbol.toLowerCase())) {
      return pool.token0Address;
    }
    if (normalized.includes(pool.token1Symbol.toLowerCase())) {
      return pool.token1Address;
    }
    return null;
  }

  private async getPoolTokenMapping(): Promise<PoolTokenMapping> {
    if (this.poolTokenMapping) {
      return this.poolTokenMapping;
    }

    const { pool } = this.configService;
    const [token0, token1] = await Promise.all([
      this.poolContract.token0(),
      this.poolContract.token1(),
    ]);

    const token0Lower = token0.toLowerCase();
    const token1Lower = token1.toLowerCase();
    const configToken0 = pool.token0Address.toLowerCase();
    const configToken1 = pool.token1Address.toLowerCase();

    const tokenSetMatches =
      (token0Lower === configToken0 && token1Lower === configToken1) ||
      (token0Lower === configToken1 && token1Lower === configToken0);

    if (!tokenSetMatches) {
      const error = `Pool tokens mismatch: on-chain [${token0}, ${token1}] vs config [${pool.token0Address}, ${pool.token1Address}]`;
      await this.monitoringService.alertCritical('LP pool token mismatch', {
        component: 'LpPositionService',
        error,
      });
      throw new Error(error);
    }

    const token0Config =
      token0Lower === configToken0
        ? {
            address: pool.token0Address,
            symbol: pool.token0Symbol,
            decimals: pool.token0Decimals,
          }
        : {
            address: pool.token1Address,
            symbol: pool.token1Symbol,
            decimals: pool.token1Decimals,
          };

    const token1Config =
      token1Lower === configToken0
        ? {
            address: pool.token0Address,
            symbol: pool.token0Symbol,
            decimals: pool.token0Decimals,
          }
        : {
            address: pool.token1Address,
            symbol: pool.token1Symbol,
            decimals: pool.token1Decimals,
          };

    const wethAddress = this.resolveTokenAddressBySymbol(['WETH', 'ETH']);
    const wethIsToken0 = wethAddress
      ? token0Lower === wethAddress.toLowerCase()
      : token0Lower === configToken0;

    return {
      token0Address: token0Config.address,
      token1Address: token1Config.address,
      token0Symbol: token0Config.symbol,
      token1Symbol: token1Config.symbol,
      token0Decimals: token0Config.decimals,
      token1Decimals: token1Config.decimals,
      wethIsToken0,
    };
  }

  private async ensureTokensInitialized(): Promise<void> {
    if (this.tokensInitialized) {
      return;
    }

    const mapping = await this.getPoolTokenMapping();
    const { web3 } = this.configService;

    this.token0 = new Token(
      web3.chainId,
      mapping.token0Address,
      mapping.token0Decimals,
      mapping.token0Symbol,
      mapping.token0Symbol,
    );
    this.token1 = new Token(
      web3.chainId,
      mapping.token1Address,
      mapping.token1Decimals,
      mapping.token1Symbol,
      mapping.token1Symbol,
    );

    this.tokensInitialized = true;
  }

  // ==================== Position Reading ====================

  /**
   * Get position info for current tracked tokenId
   */
  async getPosition(): Promise<PositionInfo> {
    await this.ensureTokensInitialized();
    if (!this.tokenId) {
      throw new Error('No tokenId set. Call setTokenId first.');
    }
    return this.getPositionById(this.tokenId);
  }

  /**
   * Get position info by specific tokenId
   */
  async getPositionById(tokenId: string): Promise<PositionInfo> {
    this.logger.debug('Getting position', { tokenId });

    try {
      const [position, owner] = await Promise.all([
        this.positionManager.positions(tokenId),
        this.positionManager.ownerOf(tokenId),
      ]);
      const mapping = await this.getPoolTokenMapping();
      const expectedFee = this.configService.pool.feeTier;

      if (owner.toLowerCase() !== this.wallet.address.toLowerCase()) {
        const error = `TokenId ${tokenId} is owned by ${owner}, not wallet ${this.wallet.address}`;
        await this.monitoringService.alertCritical(
          'LP tokenId not owned by wallet',
          {
            component: 'LpPositionService',
            error,
            tokenId,
            owner,
            wallet: this.wallet.address,
          },
        );
        throw new Error(error);
      }

      if (Number(position.fee) !== expectedFee) {
        const error = `TokenId ${tokenId} fee tier ${position.fee} does not match pool fee ${expectedFee}`;
        await this.monitoringService.alertCritical(
          'LP tokenId fee tier mismatch',
          {
            component: 'LpPositionService',
            error,
            tokenId,
            positionFee: Number(position.fee),
            poolFee: expectedFee,
          },
        );
        throw new Error(error);
      }

      // Calculate price bounds
      const priceLower = this.tickToPrice(Number(position.tickLower));
      const priceUpper = this.tickToPrice(Number(position.tickUpper));

      if (position.liquidity === BigInt(0)) {
        this.logger.warn('LP position has zero liquidity', { tokenId });
        await this.monitoringService.alertWarn(
          'LP position has zero liquidity',
          {
            component: 'LpPositionService',
            tokenId,
          },
        );
      }

      return {
        tokenId,
        token0: position.token0,
        token1: position.token1,
        fee: Number(position.fee),
        tickLower: Number(position.tickLower),
        tickUpper: Number(position.tickUpper),
        liquidity: new Decimal(position.liquidity.toString()),
        token0Symbol: mapping.token0Symbol,
        token1Symbol: mapping.token1Symbol,
        priceLower,
        priceUpper,
      };
    } catch (error) {
      this.logger.error('Failed to get position', error as Error, { tokenId });
      throw error;
    }
  }

  /**
   * Get current pool state
   */
  async getPoolState(): Promise<PoolState> {
    this.logger.debug('Getting pool state');

    try {
      await this.ensureTokensInitialized();

      const [slot0, liquidity, token0, token1, fee] = await Promise.all([
        this.poolContract.slot0(),
        this.poolContract.liquidity(),
        this.poolContract.token0(),
        this.poolContract.token1(),
        this.poolContract.fee(),
      ]);

      const sqrtPriceX96 = BigInt(slot0.sqrtPriceX96.toString());
      const tick = Number(slot0.tick);

      // Calculate spot price
      const spotPrice = this.sqrtPriceX96ToPrice(sqrtPriceX96);

      const state: PoolState = {
        poolAddress: this.configService.pool.poolAddress,
        sqrtPriceX96,
        tick,
        spotPrice,
        liquidity: BigInt(liquidity.toString()),
        fee: Number(fee),
        token0,
        token1,
        observationIndex: Number(slot0.observationIndex),
        observationCardinality: Number(slot0.observationCardinality),
        unlocked: slot0.unlocked,
        timestamp: Date.now(),
      };

      this.logger.debug('Pool state fetched', {
        tick,
        spotPrice: spotPrice.toFixed(2),
        liquidity: liquidity.toString(),
      });

      return state;
    } catch (error) {
      this.logger.error('Failed to get pool state', error as Error);
      throw error;
    }
  }

  /**
   * Get only the current pool tick (lightweight, single RPC call)
   * Use for cheap in-range checks without full pool state
   */
  async getPoolTick(): Promise<{ tick: number; spotPrice: Decimal }> {
    try {
      // Single RPC call - only slot0
      const slot0 = await this.poolContract.slot0();

      const sqrtPriceX96 = BigInt(slot0.sqrtPriceX96.toString());
      const tick = Number(slot0.tick);

      // Calculate spot price
      const spotPrice = this.sqrtPriceX96ToPrice(sqrtPriceX96);

      return { tick, spotPrice };
    } catch (error) {
      this.logger.error('Failed to get pool tick', error as Error);
      throw error;
    }
  }

  /**
   * Get position composition with value calculations
   */
  async getComposition(referencePrice: Decimal): Promise<CompositionResult> {
    this.logger.debug('Getting position composition');

    try {
      await this.ensureTokensInitialized();
      const mapping = await this.getPoolTokenMapping();

      // Step 1: Get position
      const position = await this.getPosition();

      // Step 2: Get pool state
      const poolState = await this.getPoolState();

      // Step 3: Calculate amounts using SDK
      const sdkPool = new Pool(
        this.token0!,
        this.token1!,
        position.fee as FeeAmount,
        poolState.sqrtPriceX96.toString(),
        poolState.liquidity.toString(),
        poolState.tick,
      );

      const sdkPosition = new Position({
        pool: sdkPool,
        liquidity: position.liquidity.toFixed(),
        tickLower: position.tickLower,
        tickUpper: position.tickUpper,
      });

      // Step 4: Convert to human-readable amounts
      const amount0 = new Decimal(sdkPosition.amount0.toExact());
      const amount1 = new Decimal(sdkPosition.amount1.toExact());
      const wethAmount = mapping.wethIsToken0 ? amount0 : amount1;
      const usdcAmount = mapping.wethIsToken0 ? amount1 : amount0;

      // Step 5: Calculate values
      const wethValueUsdc = wethAmount.mul(referencePrice);
      const totalValueUsdc = usdcAmount.add(wethValueUsdc);

      // Check if in range
      const inRange =
        poolState.tick >= position.tickLower &&
        poolState.tick < position.tickUpper;

      // Calculate distances to bounds
      const currentPrice = poolState.spotPrice;
      const lowerPrice = this.tickToPrice(position.tickLower);
      const upperPrice = this.tickToPrice(position.tickUpper);

      const distanceToLowerPercent = currentPrice
        .sub(lowerPrice)
        .div(currentPrice)
        .mul(100);
      const distanceToUpperPercent = upperPrice
        .sub(currentPrice)
        .div(currentPrice)
        .mul(100);
      const rangeWidthPercent = upperPrice
        .sub(lowerPrice)
        .div(lowerPrice)
        .mul(100);

      const result: CompositionResult = {
        wethAmount,
        usdcAmount,
        wethValueUsdc,
        totalValueUsdc,
        inRange,
        currentTick: poolState.tick,
        tickLower: position.tickLower,
        tickUpper: position.tickUpper,
        distanceToLowerPercent,
        distanceToUpperPercent,
        rangeWidthPercent,
        timestamp: Date.now(),
      };

      this.logger.debug('Composition calculated', {
        weth: wethAmount.toFixed(6),
        usdc: usdcAmount.toFixed(2),
        totalUsdc: totalValueUsdc.toFixed(2),
        inRange,
      });

      // Alert if out of range
      if (!inRange) {
        await this.monitoringService.alertWarn('LP position out of range', {
          component: 'LpPositionService',
          price: currentPrice,
          position: {
            lpValue: totalValueUsdc,
          },
        });
      }

      return result;
    } catch (error) {
      this.logger.error('Failed to get composition', error as Error);
      throw error;
    }
  }

  // ==================== Liquidity Operations ====================

  /**
   * Decrease liquidity from position
   */
  async decreaseLiquidity(
    params: DecreaseLiquidityParams,
  ): Promise<LpTxResult> {
    await this.ensureTokensInitialized();
    if (!this.tokenId) {
      throw new Error('No tokenId set');
    }

    if (params.percent <= 0 || params.percent > 100) {
      throw new Error('Percent must be between 0 and 100');
    }

    this.logger.info('Decreasing liquidity', {
      tokenId: this.tokenId,
      percent: params.percent,
    });

    try {
      const position = await this.getPosition();
      const liquidityToRemove = position.liquidity
        .mul(params.percent)
        .div(100)
        .floor();

      if (this.configService.isSimulationMode()) {
        this.logger.info('Simulation mode: skipping actual decrease');
        return {
          success: true,
          txHash: '0x_simulation_tx',
          amount0: new Decimal(0),
          amount1: new Decimal(0),
          liquidity: position.liquidity.sub(liquidityToRemove),
        };
      }

      const deadline =
        Math.floor(Date.now() / 1000) +
        (params.deadlineSeconds ||
          this.configService.web3.defaultDeadlineSeconds);

      // Calculate min amounts with slippage
      const slippageBps =
        params.slippageBps ||
        this.configService.web3.defaultSlippageTolerance * 100;
      const slippageMultiplier = new Decimal(10000 - slippageBps).div(10000);

      // Build calldata
      const data = this.positionManager.interface.encodeFunctionData(
        'decreaseLiquidity',
        [
          {
            tokenId: BigInt(this.tokenId),
            liquidity: BigInt(liquidityToRemove.toFixed()),
            amount0Min: BigInt(0), // Can be improved with position math
            amount1Min: BigInt(0),
            deadline: BigInt(deadline),
          },
        ],
      );

      // Send via TxPolicyService
      const txResult = await this.txPolicyService.sendTx({
        to: this.configService.web3.positionManagerAddress,
        data,
        description: `Decrease LP liquidity ${params.percent}%`,
      });

      // Wait for confirmation
      const receipt = await this.txPolicyService.waitConfirmed(txResult.txHash);

      this.logger.info('Liquidity decreased', {
        txHash: txResult.txHash,
        percent: params.percent,
      });

      return {
        success: receipt.status === 1,
        txHash: txResult.txHash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.costEth,
        liquidity: position.liquidity.sub(liquidityToRemove),
      };
    } catch (error) {
      this.logger.error('Failed to decrease liquidity', error as Error);

      await this.monitoringService.alertCritical('Decrease liquidity failed', {
        component: 'LpPositionService',
        error: error as Error,
      });

      return {
        success: false,
        txHash: '',
        error: (error as Error).message,
      };
    }
  }

  /**
   * Collect accumulated fees and withdrawn tokens
   */
  async collectFees(): Promise<CollectFeesResult> {
    await this.ensureTokensInitialized();
    if (!this.tokenId) {
      throw new Error('No tokenId set');
    }

    this.logger.info('Collecting fees', { tokenId: this.tokenId });

    if (this.configService.isSimulationMode()) {
      this.logger.info('Simulation mode: skipping actual collect');
      return {
        amount0: new Decimal(0),
        amount1: new Decimal(0),
        txHash: '0x_simulation_tx',
      };
    }

    try {
      // Build calldata
      const data = this.positionManager.interface.encodeFunctionData(
        'collect',
        [
          {
            tokenId: BigInt(this.tokenId),
            recipient: this.wallet.address,
            amount0Max: MAX_UINT128,
            amount1Max: MAX_UINT128,
          },
        ],
      );

      // Send via TxPolicyService
      const txResult = await this.txPolicyService.sendTx({
        to: this.configService.web3.positionManagerAddress,
        data,
        description: 'Collect LP fees',
      });

      // Wait for confirmation
      const receipt = await this.txPolicyService.waitConfirmed(txResult.txHash);

      // TODO: Parse amounts from logs
      const amount0 = new Decimal(0);
      const amount1 = new Decimal(0);

      this.logger.info('Fees collected', {
        txHash: txResult.txHash,
        amount0: amount0.toFixed(6),
        amount1: amount1.toFixed(2),
      });

      return {
        amount0,
        amount1,
        txHash: txResult.txHash,
      };
    } catch (error) {
      this.logger.error('Failed to collect fees', error as Error);

      await this.monitoringService.alertWarn('Collect fees failed', {
        component: 'LpPositionService',
        error: error as Error,
      });

      throw error;
    }
  }

  /**
   * Mint a new LP position NFT
   */
  async mintNewPosition(params: MintPositionParams): Promise<LpTxResult> {
    await this.ensureTokensInitialized();
    this.logger.info('Minting new position', {
      tickLower: params.tickLower,
      tickUpper: params.tickUpper,
      amountWeth: params.amountWeth.toFixed(6),
      amountUsdc: params.amountUsdc.toFixed(2),
    });

    const { pool, web3 } = this.configService;
    const mapping = await this.getPoolTokenMapping();
    const amount0Desired = mapping.wethIsToken0
      ? params.amountWeth
      : params.amountUsdc;
    const amount1Desired = mapping.wethIsToken0
      ? params.amountUsdc
      : params.amountWeth;

    try {
      // Step 1: Ensure allowances via WalletService
      const token0Allowance = await this.walletService.ensureAllowance(
        mapping.token0Address,
        web3.positionManagerAddress,
        amount0Desired,
      );
      if (!token0Allowance.ok) {
        throw new Error(
          `${mapping.token0Symbol} approval failed: ${token0Allowance.error}`,
        );
      }

      const token1Allowance = await this.walletService.ensureAllowance(
        mapping.token1Address,
        web3.positionManagerAddress,
        amount1Desired,
      );
      if (!token1Allowance.ok) {
        throw new Error(
          `${mapping.token1Symbol} approval failed: ${token1Allowance.error}`,
        );
      }

      if (this.configService.isSimulationMode()) {
        this.logger.info('Simulation mode: skipping actual mint');
        return {
          success: true,
          txHash: '0x_simulation_tx',
          newTokenId: '0',
        };
      }

      // Step 2: Build mint calldata
      const deadline =
        Math.floor(Date.now() / 1000) +
        (params.deadlineSeconds || web3.defaultDeadlineSeconds);
      const slippageBps =
        params.slippageBps || web3.defaultSlippageTolerance * 100;
      const slippageMultiplier = new Decimal(10000 - slippageBps).div(10000);

      // Convert amounts to raw
      const amount0DesiredRaw = BigInt(
        amount0Desired
          .mul(new Decimal(10).pow(mapping.token0Decimals))
          .floor()
          .toFixed(),
      );
      const amount1DesiredRaw = BigInt(
        amount1Desired
          .mul(new Decimal(10).pow(mapping.token1Decimals))
          .floor()
          .toFixed(),
      );

      const amount0Min = BigInt(
        amount0Desired
          .mul(slippageMultiplier)
          .mul(new Decimal(10).pow(mapping.token0Decimals))
          .floor()
          .toFixed(),
      );
      const amount1Min = BigInt(
        amount1Desired
          .mul(slippageMultiplier)
          .mul(new Decimal(10).pow(mapping.token1Decimals))
          .floor()
          .toFixed(),
      );

      const data = this.positionManager.interface.encodeFunctionData('mint', [
        {
          token0: mapping.token0Address,
          token1: mapping.token1Address,
          fee: pool.feeTier,
          tickLower: params.tickLower,
          tickUpper: params.tickUpper,
          amount0Desired: amount0DesiredRaw,
          amount1Desired: amount1DesiredRaw,
          amount0Min,
          amount1Min,
          recipient: this.wallet.address,
          deadline: BigInt(deadline),
        },
      ]);

      // Step 3: Send via TxPolicyService
      const txResult = await this.txPolicyService.sendTx({
        to: web3.positionManagerAddress,
        data,
        description: `Mint LP position [${params.tickLower}, ${params.tickUpper}]`,
      });

      // Step 4: Wait for confirmation
      const receipt = await this.txPolicyService.waitConfirmed(txResult.txHash);

      // Parse new token ID from logs (ERC721 Transfer from PositionManager)
      let newTokenId = '0';
      for (const log of receipt.logs) {
        if (
          log.address?.toLowerCase() !==
          web3.positionManagerAddress.toLowerCase()
        )
          continue;
        if (log.topics[0] !== ERC721_TRANSFER_TOPIC) continue;
        if (log.topics.length < 4) continue;
        const to = '0x' + log.topics[2].slice(26);
        if (to.toLowerCase() !== this.wallet.address.toLowerCase()) continue;
        newTokenId = BigInt(log.topics[3]).toString();
        break;
      }

      // Update tracked tokenId
      this.tokenId = newTokenId;

      this.logger.info('Position minted', {
        txHash: txResult.txHash,
        newTokenId,
        tickLower: params.tickLower,
        tickUpper: params.tickUpper,
      });

      return {
        success: receipt.status === 1,
        txHash: txResult.txHash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.costEth,
        newTokenId,
      };
    } catch (error) {
      this.logger.error('Failed to mint position', error as Error);

      await this.monitoringService.alertCritical('Mint position failed', {
        component: 'LpPositionService',
        error: error as Error,
      });

      return {
        success: false,
        txHash: '',
        error: (error as Error).message,
      };
    }
  }

  // ==================== Mint for Budget ====================

  /**
   * Mint a new LP position using available wallet balance
   *
   * This method handles the complex logic of:
   * 1. Getting wallet balances and applying safety buffers
   * 2. Validating tick range contains current price
   * 3. Computing amounts that respect Uniswap v3 mint requirements
   * 4. Handling approvals automatically
   * 5. Checking for excessive leftovers (warning)
   *
   * @param params - Tick range and optional budget policy
   * @returns Detailed result
   */
  async mintNewPositionForBudget(
    params: MintForBudgetParams,
  ): Promise<MintForBudgetResult> {
    await this.ensureTokensInitialized();
    const {
      tickLower,
      tickUpper,
      budgetPolicy: policyOverrides,
      recipientAddress,
    } = params;

    // Get default budget policy from config
    const defaultPolicy = this.getDefaultBudgetPolicy();
    const policy: BudgetPolicy = {
      ...defaultPolicy,
      ...policyOverrides,
    };

    this.logger.info('Minting position for budget', {
      tickLower,
      tickUpper,
      policy: {
        useAllBalances: policy.useAllBalances,
        amountSafetyPct: policy.amountSafetyPct.toFixed(4),
        reserveEthForGas: policy.reserveEthForGas.toFixed(4),
      },
    });

    // Block real transactions in simulation mode
    if (this.configService.isSimulationMode()) {
      this.logger.info('Simulation mode: skipping actual mint for budget');
      const balances = await this.walletService.getBalances();
      return {
        success: true,
        txHash: '0x_simulation_tx',
        newTokenId: '999999999',
        usedUsdc: new Decimal(0),
        usedWeth: new Decimal(0),
        leftoverUsdc: balances.usdc,
        leftoverWeth: balances.weth,
        leftoverPct: new Decimal(100),
        liquidity: new Decimal(0),
        reason: 'simulation mode - no real mint',
        tickLower,
        tickUpper,
        referencePrice: new Decimal(0),
        balancesBefore: {
          usdc: balances.usdc,
          weth: balances.weth,
          ethForGas: balances.ethForGas,
        },
        balancesAfter: {
          usdc: balances.usdc,
          weth: balances.weth,
          ethForGas: balances.ethForGas,
        },
      };
    }

    try {
      // ==================== Step 1: Get pool state and validate range ====================
      const poolState = await this.getPoolState();
      const currentTick = poolState.tick;

      // Sanity: tickLower < currentTick < tickUpper
      if (tickLower >= currentTick || tickUpper <= currentTick) {
        const error = `Invalid range: tickLower=${tickLower}, tickUpper=${tickUpper}, currentTick=${currentTick}. Range must contain current price.`;
        this.logger.error(error, undefined);

        await this.monitoringService.alertCritical(
          'Mint for budget: invalid range',
          {
            component: 'LpPositionService',
            error,
          },
        );

        return this.createFailedMintResult(params, poolState.spotPrice, error);
      }

      // ==================== Step 2: Get balances and apply buffers ====================
      const balances = await this.walletService.getBalances();
      const { pool } = this.configService;

      this.logger.debug('Wallet balances', {
        usdc: balances.usdc.toFixed(2),
        weth: balances.weth.toFixed(6),
        ethForGas: balances.ethForGas.toFixed(6),
      });

      // Check ETH for gas
      if (balances.ethForGas.lt(policy.reserveEthForGas)) {
        const error = `Insufficient ETH for gas: ${balances.ethForGas.toFixed(6)} < ${policy.reserveEthForGas.toFixed(6)}`;
        this.logger.error(error, undefined);

        await this.monitoringService.alertCritical('Mint for budget: no gas', {
          component: 'LpPositionService',
          error,
        });

        return this.createFailedMintResult(
          params,
          poolState.spotPrice,
          error,
          balances,
        );
      }

      const mapping = await this.getPoolTokenMapping();

      // Calculate available amounts with safety margin
      const availWeth = balances.weth.mul(policy.amountSafetyPct);
      const availUsdc = balances.usdc.mul(policy.amountSafetyPct);

      // Reference price for logging
      const referencePrice = params.referencePrice || poolState.spotPrice;

      this.logger.debug('Available amounts after safety buffer', {
        availWeth: availWeth.toFixed(6),
        availUsdc: availUsdc.toFixed(2),
        safetyPct: policy.amountSafetyPct.toFixed(4),
      });

      // ==================== Step 3: Compute desired amounts ====================
      // For MVP: we use all available as "desired", let the contract decide actual amounts
      // The contract will use what it needs based on the price and return the rest

      const amount0Desired = mapping.wethIsToken0 ? availWeth : availUsdc;
      const amount1Desired = mapping.wethIsToken0 ? availUsdc : availWeth;

      // Compute minimums - these should be LOW or ZERO
      // Uniswap V3 determines the exact token ratio based on tick range and current price
      // Setting minPct=0 means "accept whatever ratio Uniswap calculates"
      // Leftover tokens will remain in wallet
      const amount0Min = amount0Desired.mul(policy.amount0MinPct);
      const amount1Min = amount1Desired.mul(policy.amount1MinPct);

      this.logger.info('Mint amounts computed', {
        amount0Desired: amount0Desired.toFixed(6),
        amount1Desired: amount1Desired.toFixed(2),
        amount0Min: amount0Min.toFixed(6),
        amount1Min: amount1Min.toFixed(2),
        note: 'amountMin=0 means Uniswap determines actual ratio, leftover stays in wallet',
      });

      // ==================== Step 4: Approvals ====================
      const positionManager = this.configService.web3.positionManagerAddress;

      // Ensure WETH allowance
      const token0Allowance = await this.walletService.ensureAllowance(
        mapping.token0Address,
        positionManager,
        amount0Desired,
      );
      if (!token0Allowance.ok) {
        throw new Error(
          `${mapping.token0Symbol} approval failed: ${token0Allowance.error}`,
        );
      }

      // Ensure token1 allowance
      const token1Allowance = await this.walletService.ensureAllowance(
        mapping.token1Address,
        positionManager,
        amount1Desired,
      );
      if (!token1Allowance.ok) {
        throw new Error(
          `${mapping.token1Symbol} approval failed: ${token1Allowance.error}`,
        );
      }

      // ==================== Step 5: Mint transaction ====================
      const deadline = Math.floor(Date.now() / 1000) + policy.deadlineSec;
      const recipient = recipientAddress || this.wallet.address;

      // Convert to raw units
      const amount0DesiredRaw = BigInt(
        amount0Desired
          .mul(new Decimal(10).pow(mapping.token0Decimals))
          .floor()
          .toString(),
      );
      const amount1DesiredRaw = BigInt(
        amount1Desired
          .mul(new Decimal(10).pow(mapping.token1Decimals))
          .floor()
          .toString(),
      );
      const amount0MinRaw = BigInt(
        amount0Min
          .mul(new Decimal(10).pow(mapping.token0Decimals))
          .floor()
          .toString(),
      );
      const amount1MinRaw = BigInt(
        amount1Min
          .mul(new Decimal(10).pow(mapping.token1Decimals))
          .floor()
          .toString(),
      );

      // Encode mint call
      const mintData = this.positionManager.interface.encodeFunctionData(
        'mint',
        [
          {
            token0: mapping.token0Address,
            token1: mapping.token1Address,
            fee: pool.feeTier,
            tickLower,
            tickUpper,
            amount0Desired: amount0DesiredRaw,
            amount1Desired: amount1DesiredRaw,
            amount0Min: amount0MinRaw,
            amount1Min: amount1MinRaw,
            recipient,
            deadline: BigInt(deadline),
          },
        ],
      );

      // Send transaction
      const txResult = await this.txPolicyService.sendTx({
        to: positionManager,
        data: mintData,
        description: `Mint LP for budget [${tickLower}, ${tickUpper}]`,
      });

      // Wait for confirmation
      const receipt = await this.txPolicyService.waitConfirmed(txResult.txHash);

      if (receipt.status !== 1) {
        throw new Error('Mint transaction reverted');
      }

      // Parse new token ID from logs (ERC721 Transfer from PositionManager)
      let newTokenId = '0';
      for (const log of receipt.logs) {
        if (log.address?.toLowerCase() !== positionManager.toLowerCase())
          continue;
        if (log.topics[0] !== ERC721_TRANSFER_TOPIC) continue;
        if (log.topics.length < 4) continue;
        const to = '0x' + log.topics[2].slice(26);
        if (to.toLowerCase() !== recipient.toLowerCase()) continue;
        newTokenId = BigInt(log.topics[3]).toString();
        break;
      }

      // Update tracked tokenId
      this.tokenId = newTokenId;

      // ==================== Step 6: Post-check ====================
      const balancesAfter = await this.walletService.getBalances();

      // Calculate what was used
      const usedWeth = balances.weth.sub(balancesAfter.weth);
      const usedUsdc = balances.usdc.sub(balancesAfter.usdc);

      // Calculate leftovers
      const leftoverWeth = balancesAfter.weth;
      const leftoverUsdc = balancesAfter.usdc;

      // Calculate leftover percentage (of total value)
      const leftoverValueUsdc = leftoverWeth
        .mul(referencePrice)
        .add(leftoverUsdc);
      const totalValueBefore = balances.weth
        .mul(referencePrice)
        .add(balances.usdc);
      const leftoverPct = totalValueBefore.isZero()
        ? new Decimal(0)
        : leftoverValueUsdc.div(totalValueBefore);

      this.logger.info('Mint for budget complete', {
        txHash: txResult.txHash,
        newTokenId,
        usedWeth: usedWeth.toFixed(6),
        usedUsdc: usedUsdc.toFixed(2),
        leftoverWeth: leftoverWeth.toFixed(6),
        leftoverUsdc: leftoverUsdc.toFixed(2),
        leftoverPct: `${leftoverPct.mul(100).toFixed(2)}%`,
      });

      // Warn if leftover is excessive
      if (leftoverPct.gt(policy.maxLeftoverPctWarn)) {
        await this.monitoringService.alertWarn('High leftover after mint', {
          component: 'LpPositionService',
          context: {
            leftoverPct: `${leftoverPct.mul(100).toFixed(2)}%`,
            threshold: `${policy.maxLeftoverPctWarn.mul(100).toFixed(2)}%`,
            leftoverUsdc: leftoverUsdc.toFixed(2),
            leftoverWeth: leftoverWeth.toFixed(6),
          },
        });
      }

      return {
        success: true,
        newTokenId,
        txHash: txResult.txHash,
        usedUsdc: usedUsdc,
        usedWeth: usedWeth,
        leftoverUsdc,
        leftoverWeth,
        leftoverPct,
        reason: 'mint successful',
        tickLower,
        tickUpper,
        referencePrice,
        balancesBefore: {
          usdc: balances.usdc,
          weth: balances.weth,
          ethForGas: balances.ethForGas,
        },
        balancesAfter: {
          usdc: balancesAfter.usdc,
          weth: balancesAfter.weth,
          ethForGas: balancesAfter.ethForGas,
        },
      };
    } catch (error) {
      const errorMsg = (error as Error).message;
      this.logger.error('Mint for budget failed', error as Error);

      await this.monitoringService.alertCritical('Mint for budget failed', {
        component: 'LpPositionService',
        error: errorMsg,
      });

      const balances = await this.walletService.getBalances().catch(() => ({
        usdc: new Decimal(0),
        weth: new Decimal(0),
        ethForGas: new Decimal(0),
        timestamp: Date.now(),
      }));

      return this.createFailedMintResult(
        params,
        params.referencePrice || new Decimal(0),
        errorMsg,
        balances,
      );
    }
  }

  /**
   * Get default budget policy from config
   */
  private getDefaultBudgetPolicy(): BudgetPolicy {
    const mintPolicy = this.configService.mintPolicy;

    if (mintPolicy) {
      return {
        useAllBalances: mintPolicy.useAllBalances,
        reserveEthForGas: new Decimal(mintPolicy.reserveEthForGas),
        amountSafetyPct: new Decimal(mintPolicy.amountSafetyPct),
        amount0MinPct: new Decimal(mintPolicy.amount0MinPct),
        amount1MinPct: new Decimal(mintPolicy.amount1MinPct),
        deadlineSec: mintPolicy.deadlineSec,
        maxLeftoverPctWarn: new Decimal(mintPolicy.maxLeftoverPctWarn),
      };
    }

    // Fallback defaults
    // Note: amount0MinPct and amount1MinPct should be LOW (not high!)
    // These protect against price movement, not against Uniswap using less than expected.
    // Uniswap V3 will calculate the exact ratio it needs for the tick range.
    // Setting these to 0 means "I accept whatever Uniswap decides to use"
    return {
      useAllBalances: true,
      reserveEthForGas: new Decimal('0.02'),
      amountSafetyPct: new Decimal('0.995'),
      amount0MinPct: new Decimal('0'), // Accept any amount - Uniswap determines ratio
      amount1MinPct: new Decimal('0'), // Accept any amount - Uniswap determines ratio
      deadlineSec: 120,
      maxLeftoverPctWarn: new Decimal('0.50'), // Expect up to 50% leftover (asymmetric ranges)
    };
  }

  /**
   * Create failed mint result helper
   */
  private createFailedMintResult(
    params: MintForBudgetParams,
    referencePrice: Decimal,
    error: string,
    balances?: { usdc: Decimal; weth: Decimal; ethForGas: Decimal },
  ): MintForBudgetResult {
    const defaultBalances = balances || {
      usdc: new Decimal(0),
      weth: new Decimal(0),
      ethForGas: new Decimal(0),
    };

    return {
      success: false,
      usedUsdc: new Decimal(0),
      usedWeth: new Decimal(0),
      leftoverUsdc: defaultBalances.usdc,
      leftoverWeth: defaultBalances.weth,
      leftoverPct: new Decimal(1), // 100% leftover (nothing minted)
      reason: `error: ${error}`,
      error,
      tickLower: params.tickLower,
      tickUpper: params.tickUpper,
      referencePrice,
      balancesBefore: defaultBalances,
    };
  }

  /**
   * Burn empty position NFT
   */
  async burnPosition(tokenId: string): Promise<LpTxResult> {
    await this.ensureTokensInitialized();
    this.logger.info('Burning position', { tokenId });

    if (this.configService.isSimulationMode()) {
      this.logger.info('Simulation mode: skipping burn');
      return { success: true, txHash: '0x_simulation_tx' };
    }

    try {
      const data = this.positionManager.interface.encodeFunctionData('burn', [
        BigInt(tokenId),
      ]);

      const txResult = await this.txPolicyService.sendTx({
        to: this.configService.web3.positionManagerAddress,
        data,
        description: `Burn LP NFT ${tokenId}`,
      });

      const receipt = await this.txPolicyService.waitConfirmed(txResult.txHash);

      this.logger.info('Position burned', { txHash: txResult.txHash, tokenId });

      return {
        success: receipt.status === 1,
        txHash: txResult.txHash,
        blockNumber: receipt.blockNumber,
      };
    } catch (error) {
      this.logger.error('Failed to burn position', error as Error);
      return {
        success: false,
        txHash: '',
        error: (error as Error).message,
      };
    }
  }

  // ==================== Utility Methods ====================

  getTokenId(): string | null {
    return this.tokenId;
  }

  setTokenId(tokenId: string): void {
    if (this.tokenId !== tokenId) {
      const previousTokenId = this.tokenId;
      this.tokenId = tokenId;
      this.logger.info('TokenId changed', {
        previousTokenId: previousTokenId || 'none',
        newTokenId: tokenId || 'none',
      });
    } else {
      this.tokenId = tokenId;
    }
  }

  async isInRange(): Promise<boolean> {
    await this.ensureTokensInitialized();
    const position = await this.getPosition();
    const poolState = await this.getPoolState();
    return (
      poolState.tick >= position.tickLower &&
      poolState.tick < position.tickUpper
    );
  }

  async getDistanceToBounds(): Promise<{ toLower: Decimal; toUpper: Decimal }> {
    await this.ensureTokensInitialized();
    const position = await this.getPosition();
    const poolState = await this.getPoolState();

    const currentPrice = poolState.spotPrice;
    const lowerPrice = this.tickToPrice(position.tickLower);
    const upperPrice = this.tickToPrice(position.tickUpper);

    const toLower = currentPrice.sub(lowerPrice).div(currentPrice).mul(100);
    const toUpper = upperPrice.sub(currentPrice).div(currentPrice).mul(100);

    return { toLower, toUpper };
  }

  getWalletAddress(): string {
    return this.wallet.address;
  }

  // ==================== Price/Tick Conversions ====================

  /**
   * Convert price to nearest usable tick
   */
  priceToTick(price: Decimal): number {
    this.ensureTokenMappingReady();
    const { pool } = this.configService;
    const sqrtPriceX96 = this.priceToSqrtPriceX96(price);
    const tick = TickMath.getTickAtSqrtRatio(
      JSBI.BigInt(sqrtPriceX96.toFixed()),
    );
    return nearestUsableTick(tick, TICK_SPACINGS[pool.feeTier as FeeAmount]);
  }

  /**
   * Convert tick to price
   */
  tickToPrice(tick: number): Decimal {
    this.ensureTokenMappingReady();
    const sqrtRatioX96 = TickMath.getSqrtRatioAtTick(tick);
    return this.sqrtPriceX96ToPrice(BigInt(sqrtRatioX96.toString()));
  }

  /**
   * Calculate symmetric range around current price
   */
  async calculateSymmetricRange(
    rangeWidthPercent: number,
  ): Promise<{ tickLower: number; tickUpper: number }> {
    await this.ensureTokensInitialized();
    const poolState = await this.getPoolState();
    const { pool } = this.configService;

    const currentPrice = poolState.spotPrice;
    const halfWidth = new Decimal(rangeWidthPercent).div(100);

    const lowerPrice = currentPrice.mul(new Decimal(1).sub(halfWidth));
    const upperPrice = currentPrice.mul(new Decimal(1).add(halfWidth));

    let tickFromLowerPrice = this.priceToTick(lowerPrice);
    let tickFromUpperPrice = this.priceToTick(upperPrice);

    // When price is inverted (WETH is not token0), higher price maps to lower tick
    // So we need to swap the ticks to ensure tickLower < tickUpper
    const tickLower = Math.min(tickFromLowerPrice, tickFromUpperPrice);
    const tickUpper = Math.max(tickFromLowerPrice, tickFromUpperPrice);

    this.logger.debug('Symmetric range calculated', {
      currentPrice: currentPrice.toFixed(2),
      lowerPrice: lowerPrice.toFixed(2),
      upperPrice: upperPrice.toFixed(2),
      currentTick: poolState.tick,
      tickLower,
      tickUpper,
      inverted: this.shouldInvertPrice(),
    });

    return { tickLower, tickUpper };
  }

  /**
   * Calculate optimal token ratio for a given range based on current price
   *
   * In Uniswap V3, the amount of each token needed depends on where the current price
   * is within the range. This calculates what percentage should be in WETH vs USDC.
   *
   * @param tickLower - Lower tick of range
   * @param tickUpper - Upper tick of range
   * @param currentTick - Current pool tick (optional, fetched if not provided)
   * @returns { wethPercent, usdcPercent } - Target percentages (0-100)
   */
  async calculateOptimalRatioForRange(
    tickLower: number,
    tickUpper: number,
    currentTick?: number,
  ): Promise<{ wethPercent: Decimal; usdcPercent: Decimal }> {
    await this.ensureTokensInitialized();

    // Get current tick if not provided
    if (currentTick === undefined) {
      const poolState = await this.getPoolState();
      currentTick = poolState.tick;
    }

    // If out of range, one token is 100%
    if (currentTick <= tickLower) {
      // Price at or below lower bound - need 100% token1 (USDC)
      return { wethPercent: new Decimal(0), usdcPercent: new Decimal(100) };
    }
    if (currentTick >= tickUpper) {
      // Price at or above upper bound - need 100% token0 (WETH)
      return { wethPercent: new Decimal(100), usdcPercent: new Decimal(0) };
    }

    // Calculate sqrt prices
    const sqrtPriceLower = new Decimal(1.0001).pow(tickLower / 2);
    const sqrtPriceUpper = new Decimal(1.0001).pow(tickUpper / 2);
    const sqrtPriceCurrent = new Decimal(1.0001).pow(currentTick / 2);

    // For a given amount of liquidity L:
    // amount0 (WETH) = L * (1/sqrtP - 1/sqrtPb) = L * (sqrtPb - sqrtP) / (sqrtP * sqrtPb)
    // amount1 (USDC) = L * (sqrtP - sqrtPa)
    //
    // Value ratio (in terms of token1):
    // value0 = amount0 * P = amount0 * sqrtP^2
    // value1 = amount1
    //
    // Simplified: wethValueFraction depends on position in range

    // Fraction of range that is "above" current price (more WETH needed)
    const rangeAbove = sqrtPriceUpper.sub(sqrtPriceCurrent);
    const rangeBelow = sqrtPriceCurrent.sub(sqrtPriceLower);
    const totalRange = sqrtPriceUpper.sub(sqrtPriceLower);

    // Value-weighted ratio considering price
    // WETH value = rangeAbove * currentPrice / sqrtPriceUpper
    // USDC value = rangeBelow
    const wethValueContribution = rangeAbove
      .mul(sqrtPriceCurrent)
      .div(sqrtPriceUpper);
    const usdcValueContribution = rangeBelow;
    const totalValue = wethValueContribution.add(usdcValueContribution);

    const wethPercent = totalValue.isZero()
      ? new Decimal(50)
      : wethValueContribution.div(totalValue).mul(100);
    const usdcPercent = new Decimal(100).sub(wethPercent);

    this.logger.debug('Calculated optimal ratio for range', {
      tickLower,
      tickUpper,
      currentTick,
      wethPercent: wethPercent.toFixed(1),
      usdcPercent: usdcPercent.toFixed(1),
    });

    return { wethPercent, usdcPercent };
  }

  /**
   * Convert sqrtPriceX96 to human-readable price
   */
  private sqrtPriceX96ToPrice(sqrtPriceX96: bigint): Decimal {
    const { pool } = this.configService;
    const Q96 = BigInt(2) ** BigInt(96);

    const sqrtPrice = new Decimal(sqrtPriceX96.toString()).div(
      new Decimal(Q96.toString()),
    );
    let price = sqrtPrice.pow(2);

    // Adjust for decimals
    const token0Decimals =
      this.poolTokenMapping?.token0Decimals ?? pool.token0Decimals;
    const token1Decimals =
      this.poolTokenMapping?.token1Decimals ?? pool.token1Decimals;
    const decimalAdjustment = new Decimal(10).pow(
      token0Decimals - token1Decimals,
    );
    price = price.mul(decimalAdjustment);

    if (this.shouldInvertPrice()) {
      price = new Decimal(1).div(price);
    }
    return price;
  }

  /**
   * Convert price to sqrtPriceX96
   */
  private priceToSqrtPriceX96(price: Decimal): Decimal {
    const { pool } = this.configService;

    const token0Decimals =
      this.poolTokenMapping?.token0Decimals ?? pool.token0Decimals;
    const token1Decimals =
      this.poolTokenMapping?.token1Decimals ?? pool.token1Decimals;
    const normalizedPrice = this.shouldInvertPrice()
      ? new Decimal(1).div(price)
      : price;

    // Adjust for decimals
    const adjustedPrice = normalizedPrice.div(
      new Decimal(10).pow(token0Decimals - token1Decimals),
    );
    const sqrtPrice = adjustedPrice.sqrt();
    const sqrtPriceX96 = sqrtPrice.mul(new Decimal(2).pow(96));

    return sqrtPriceX96;
  }

  private ensureTokenMappingReady(): void {
    if (!this.tokensInitialized || !this.poolTokenMapping) {
      throw new Error(
        'Pool token mapping not initialized. Call getPoolState() first.',
      );
    }
  }

  private shouldInvertPrice(): boolean {
    if (this.poolTokenMapping) {
      return !this.poolTokenMapping.wethIsToken0;
    }
    const { pool } = this.configService;
    const token0IsBase =
      pool.token0Symbol.toLowerCase() === 'weth' ||
      pool.token0Symbol.toLowerCase() === 'eth';
    return !token0IsBase;
  }

  // ==================== Position Discovery Methods ====================

  /**
   * Discover all LP positions owned by this wallet
   */
  async discoverWalletPositions(): Promise<WalletPositionsResult> {
    this.logger.info('Discovering wallet LP positions');

    const walletAddress = this.wallet.address;
    const { pool } = this.configService;

    try {
      // Get number of NFTs owned by wallet
      const balanceResult = await this.positionManager.balanceOf(walletAddress);
      const balance = Number(balanceResult);

      this.logger.debug('Wallet NFT balance', { balance });

      if (balance === 0) {
        this.logger.info('No LP NFTs found for wallet');
        return {
          totalNfts: 0,
          allPositions: [],
          matchingPoolPositions: [],
          activePositions: [],
          bestActivePosition: null,
        };
      }

      // Fetch all tokenIds
      const tokenIds: string[] = [];
      for (let i = 0; i < balance; i++) {
        const tokenId = await this.positionManager.tokenOfOwnerByIndex(
          walletAddress,
          i,
        );
        tokenIds.push(tokenId.toString());
      }

      this.logger.debug('Found tokenIds', { count: tokenIds.length, tokenIds });

      // Fetch position info for each tokenId
      const allPositions: WalletPositionSummary[] = [];

      for (const tokenId of tokenIds) {
        try {
          const position = await this.positionManager.positions(tokenId);

          const token0 = position.token0.toLowerCase();
          const token1 = position.token1.toLowerCase();
          const fee = Number(position.fee);
          const liquidity = new Decimal(position.liquidity.toString());

          // Check if matches configured pool
          const configToken0 = pool.token0Address.toLowerCase();
          const configToken1 = pool.token1Address.toLowerCase();
          const configFee = pool.feeTier;

          const matchesConfigPool =
            token0 === configToken0 &&
            token1 === configToken1 &&
            fee === configFee;

          const summary: WalletPositionSummary = {
            tokenId,
            token0: position.token0,
            token1: position.token1,
            fee,
            tickLower: Number(position.tickLower),
            tickUpper: Number(position.tickUpper),
            liquidity,
            matchesConfigPool,
            hasLiquidity: liquidity.gt(0),
          };

          allPositions.push(summary);
        } catch (error) {
          this.logger.warn('Failed to fetch position info', {
            tokenId,
            error: (error as Error).message,
          });
        }
      }

      // Filter matching and active positions
      const matchingPoolPositions = allPositions.filter(
        (p) => p.matchesConfigPool,
      );
      const activePositions = matchingPoolPositions.filter(
        (p) => p.hasLiquidity,
      );

      // Find best active position (highest liquidity)
      let bestActivePosition: WalletPositionSummary | null = null;
      if (activePositions.length > 0) {
        bestActivePosition = activePositions.reduce((best, current) =>
          current.liquidity.gt(best.liquidity) ? current : best,
        );
      }

      this.logger.info('Position discovery complete', {
        totalNfts: balance,
        allPositions: allPositions.length,
        matchingPool: matchingPoolPositions.length,
        active: activePositions.length,
        bestTokenId: bestActivePosition?.tokenId,
      });

      return {
        totalNfts: balance,
        allPositions,
        matchingPoolPositions,
        activePositions,
        bestActivePosition,
      };
    } catch (error) {
      this.logger.error('Failed to discover wallet positions', error as Error);
      throw error;
    }
  }

  /**
   * Get active LP position for the configured pool
   * Returns the position with highest liquidity that matches the configured pool
   */
  async getActivePositionForPool(): Promise<string | null> {
    const result = await this.discoverWalletPositions();
    return result.bestActivePosition?.tokenId ?? null;
  }

  /**
   * Check if a specific tokenId exists and is valid (owned by wallet, matches pool)
   */
  async isValidPosition(tokenId: string): Promise<boolean> {
    try {
      const position = await this.getPositionById(tokenId);

      // Check ownership is already done in getPositionById
      // Check pool match
      const { pool } = this.configService;
      const matchesPool =
        position.token0.toLowerCase() === pool.token0Address.toLowerCase() &&
        position.token1.toLowerCase() === pool.token1Address.toLowerCase() &&
        position.fee === pool.feeTier;

      return matchesPool;
    } catch {
      return false;
    }
  }

  /**
   * Extract tokenId from a mint transaction receipt
   * Parses ERC721 Transfer event from NonfungiblePositionManager
   * Used for idempotent recovery when mint tx succeeded but state wasn't saved
   *
   * @param txHash - Transaction hash of the mint operation
   * @returns TokenId if found, null if tx not found/failed or no Transfer event
   */
  async extractTokenIdFromMintTx(txHash: string): Promise<string | null> {
    try {
      const receipt = await this.provider.getTransactionReceipt(txHash);

      if (!receipt) {
        this.logger.warn('Mint tx not found (not mined yet or invalid)', {
          txHash,
        });
        return null;
      }

      if (receipt.status !== 1) {
        this.logger.warn('Mint tx reverted', { txHash });
        return null;
      }

      const positionManager =
        this.configService.web3.positionManagerAddress.toLowerCase();
      const walletAddress = this.wallet.address.toLowerCase();

      // Parse ERC721 Transfer event: Transfer(from, to, tokenId)
      // For mint: from=0x0, to=recipient
      for (const log of receipt.logs) {
        // Must be from PositionManager
        if (log.address?.toLowerCase() !== positionManager) continue;

        // Must be Transfer event
        if (log.topics[0] !== ERC721_TRANSFER_TOPIC) continue;

        // Must have 4 topics: event sig, from, to, tokenId
        if (log.topics.length < 4) continue;

        // Check recipient is our wallet
        const to = '0x' + log.topics[2].slice(26);
        if (to.toLowerCase() !== walletAddress) continue;

        // Extract tokenId from topic[3]
        const tokenId = BigInt(log.topics[3]).toString();

        this.logger.info('Extracted tokenId from mint tx', {
          txHash,
          tokenId,
        });

        return tokenId;
      }

      this.logger.warn('No Transfer event found in mint tx', { txHash });
      return null;
    } catch (error) {
      this.logger.error(
        'Failed to extract tokenId from mint tx',
        error as Error,
        { txHash },
      );
      return null;
    }
  }
}
