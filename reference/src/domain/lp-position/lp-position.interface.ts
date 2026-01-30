import Decimal from 'decimal.js';
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
  WalletPositionsResult,
} from './lp-position.types';

/**
 * LP Position Service interface
 * Manages Uniswap v3 LP NFT positions: read, decrease, collect fees, mint new
 */
export interface ILpPositionService {
  /**
   * Get position info for current tracked tokenId
   * @returns Position info including ticks, liquidity, tokens
   */
  getPosition(): Promise<PositionInfo>;

  /**
   * Get position info by specific tokenId
   * @param tokenId - NFT token ID
   * @returns Position info
   */
  getPositionById(tokenId: string): Promise<PositionInfo>;

  /**
   * Get current pool state
   * @returns Pool state including tick, spot price, liquidity
   */
  getPoolState(): Promise<PoolState>;

  /**
   * Get only the current pool tick (lightweight, single RPC call)
   * Use for cheap in-range checks without full pool state
   * @returns Current tick and spot price
   */
  getPoolTick(): Promise<{ tick: number; spotPrice: Decimal }>;

  /**
   * Get position composition with value calculations
   * @param referencePrice - Reference price for WETH/USDC
   * @returns Composition including amounts, inRange, totalValueUsdc
   */
  getComposition(referencePrice: Decimal): Promise<CompositionResult>;

  /**
   * Decrease liquidity from position
   * @param params - Decrease params (percent, slippage)
   * @returns Transaction result
   */
  decreaseLiquidity(params: DecreaseLiquidityParams): Promise<LpTxResult>;

  /**
   * Collect accumulated fees and withdrawn tokens
   * @returns Collect result with amounts and txHash
   */
  collectFees(): Promise<CollectFeesResult>;

  /**
   * Mint a new LP position NFT
   * Ensures allowances before minting
   * @param params - Mint params (ticks, amounts)
   * @returns Transaction result with new tokenId
   */
  mintNewPosition(params: MintPositionParams): Promise<LpTxResult>;

  /**
   * Mint a new LP position using available wallet balance
   *
   * This method handles the complex logic of determining optimal amounts:
   * - Gets wallet balances and applies safety buffers
   * - Ensures ETH is reserved for gas
   * - Computes amounts that match the Uniswap v3 range requirements
   * - Handles approvals automatically
   * - Validates range contains current price
   *
   * @param params - Tick range and budget policy
   * @returns Detailed result including amounts used, leftovers, newTokenId
   */
  mintNewPositionForBudget(
    params: MintForBudgetParams,
  ): Promise<MintForBudgetResult>;

  /**
   * Get current tracked tokenId
   */
  getTokenId(): string | null;

  /**
   * Set tokenId to track
   * @param tokenId - NFT token ID to track
   */
  setTokenId(tokenId: string): void;

  /**
   * Check if position is in range
   * @returns Whether current price is within position ticks
   */
  isInRange(): Promise<boolean>;

  /**
   * Get distance to position bounds
   * @returns Distance to lower and upper bounds in percent
   */
  getDistanceToBounds(): Promise<{ toLower: Decimal; toUpper: Decimal }>;

  /**
   * Burn empty position NFT
   * Only works if liquidity is 0 and no tokens owed
   * @param tokenId - Token ID to burn
   * @returns Transaction result
   */
  burnPosition(tokenId: string): Promise<LpTxResult>;

  /**
   * Get wallet address used by service
   */
  getWalletAddress(): string;

  /**
   * Convert price to nearest usable tick
   */
  priceToTick(price: Decimal): number;

  /**
   * Convert tick to price
   */
  tickToPrice(tick: number): Decimal;

  /**
   * Calculate tick bounds for symmetric range around current price
   * @param rangeWidthPercent - Width of range as percent (e.g., 5 for ±5%)
   * @returns Lower and upper ticks
   */
  calculateSymmetricRange(
    rangeWidthPercent: number,
  ): Promise<{ tickLower: number; tickUpper: number }>;

  /**
   * Calculate optimal token ratio for a given range based on current price
   *
   * In Uniswap V3, the amount of each token needed depends on where the current price
   * is within the range.
   *
   * @param tickLower - Lower tick of range
   * @param tickUpper - Upper tick of range
   * @param currentTick - Current pool tick (optional, fetched if not provided)
   * @returns { wethPercent, usdcPercent } - Target percentages (0-100)
   */
  calculateOptimalRatioForRange(
    tickLower: number,
    tickUpper: number,
    currentTick?: number,
  ): Promise<{ wethPercent: Decimal; usdcPercent: Decimal }>;

  /**
   * Discover all LP positions owned by this wallet
   * Enumerates all NFTs from NonfungiblePositionManager and checks which match the configured pool
   * @returns Summary of all positions, matching positions, and best active candidate
   */
  discoverWalletPositions(): Promise<WalletPositionsResult>;

  /**
   * Get active LP position for the configured pool
   * Returns the position with highest liquidity that matches the configured pool
   * @returns TokenId of best active position, or null if none found
   */
  getActivePositionForPool(): Promise<string | null>;

  /**
   * Check if a specific tokenId exists and is valid (owned by wallet, matches pool)
   * @param tokenId - Token ID to check
   * @returns Whether the tokenId is valid
   */
  isValidPosition(tokenId: string): Promise<boolean>;

  /**
   * Extract tokenId from a mint transaction receipt
   * Parses ERC721 Transfer event from NonfungiblePositionManager
   * Used for idempotent recovery when mint tx succeeded but state wasn't saved
   *
   * @param txHash - Transaction hash of the mint operation
   * @returns TokenId if found, null if tx not found or no Transfer event
   */
  extractTokenIdFromMintTx(txHash: string): Promise<string | null>;
}
