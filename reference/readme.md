# Atlas — Hedged LP Bot (Uniswap v3 on Arbitrum + Binance Perps Hedge)

> **Purpose:** Automated delta-hedged concentrated liquidity provisioning on Uniswap v3 (Arbitrum) for WETH/USDC, with directional risk hedged via Binance ETHUSDT perpetuals.
> **Core loop:** Observe → Evaluate risk → Decide actions → Execute safely → Persist state → Report.

This document is designed to be **LLM-friendly**: it defines **architecture, roles, algorithms, invariants, config, data models, and operational flows** with minimal ambiguity.

---

## 0) Glossary (strict meanings)

- **DEX (Decentralized Exchange):** On-chain exchange (here: Uniswap v3).
- **AMM (Automated Market Maker):** Exchange model using liquidity pools instead of order books.
- **LP (Liquidity Providing):** Providing liquidity to a pool and earning swap fees.
- **Concentrated Liquidity (Uniswap v3):** Liquidity is provided in a specific price range; capital efficiency increases, but out-of-range stops earning fees.
- **Position (Uniswap v3):** An NFT representing liquidity, fee tier, and tick range.
- **Tick:** Discrete price grid in Uniswap v3. Range defined by `tickLower`, `tickUpper`.
- **In-range:** Current tick is between `tickLower` and `tickUpper`.
- **Reset-range:** Close current position and mint a new position with a new tick range (new NFT).
- **Hedge:** Short ETH exposure on Binance ETHUSDT perpetual to neutralize LP directional risk.
- **Notional:** Value in USDC/USDT terms (e.g., short notional in USDT).
- **Reference price:** “Fair” ETH price used for valuation and decisions; derived from DEX and/or CEX sources.
- **Operation (Op):** A multi-step execution flow that can be resumed after crash (e.g., reset-range).
- **Step:** A discrete sub-action inside an Operation (decrease liquidity, collect, swap, mint, rehedge, etc.).
- **Simulation mode:** No real on-chain or exchange actions; return mock tx hashes and results.

---

## 1) Strategy overview

### 1.1 What the bot is doing (economic model)

We provide liquidity on Uniswap v3 WETH/USDC in a **limited price range** to earn **swap fees**.
The LP position has **directional exposure** to ETH price; to reduce this risk, we open a **short ETHUSDT perp** on Binance.

**Profit sources**
1. **Uniswap swap fees** collected by LP position.
2. Potentially favorable **funding** on Binance (optional/secondary; can be positive or negative).

**Cost/risks**
- Impermanent loss / “gamma bleed” in trends.
- Hedge execution costs (fees, slippage, funding).
- On-chain gas costs.
- Smart contract risks (Uniswap v3 is mature, but still non-zero risk).
- Exchange risks (API outages, liquidation risk).

### 1.2 System invariants (must always hold)

1. **We avoid being naked to the market during reset-range.**
   The execution order must minimize periods where LP is closed and hedge is misaligned.
2. **We do not execute if RiskManager blocks.**
   Risk gates are enforced before destructive actions.
3. **Reset-range is resumable.**
   Every step is persisted; if the process crashes, it can resume safely.
4. **Hedge is aligned to LP ETH exposure** within a defined tolerance, avoiding over-trading.

---

## 2) Supported deployment (MVP constraints)

- Network: **Arbitrum One**
- DEX: **Uniswap v3**
- Pool: **WETH/USDC 0.05%**
- Hedge venue: **Binance** (ETHUSDT perpetual)
- Wallet: EOA private key on Arbitrum (must have ETH for gas)
- Storage: MongoDB via StateStore (operation and state persistence)
- Scheduling: node-cron based Scheduler

---

## 3) High-level runtime behavior

### 3.1 Application startup
1. Load `.env` config
2. Initialize services
3. Connect MongoDB
4. `StateStore.start()` (critical)
5. Start Scheduler jobs
6. Start main decision loop

### 3.2 Main decision loop (every `LOOP_INTERVAL_SEC`)
Pseudo:
1. Load `activeTokenId` (StateStore)
2. If missing: log warning and skip iteration (no position tracked)
3. Fetch `referencePrice` (PriceService)
4. Fetch LP `composition` (LpPositionService)
5. Fetch hedge `position` (HedgeService)
6. Evaluate risks (RiskManager)
7. StrategyEngine builds action plan:
   - Emergency exit?
   - Reset-range?
   - Rehedge only?
   - No-op?
8. ExecutionOrchestrator executes plan:
   - Create OpState in StateStore
   - Execute steps in correct order
   - Persist step completion
   - Finalize OpState
9. LedgerService records tick (observability / PnL inputs)
10. Monitoring/alerts if needed

---

## 4) Service architecture (dependencies and responsibilities)

### 4.1 ConfigService (src/index.ts in this codebase)
**Goal:** parse and validate environment config; expose typed config to services.

**Depends on:** none (source of truth)

**Provides:**
- `web3` settings (rpcUrl, privateKey, chainId, positionManager address)
- `pool` settings (poolAddress, token0/1, fee tier, decimals)
- strategy thresholds
- tx policies
- swap policy
- scheduling intervals
- simulation mode flags

**Invariants:**
- Pool addresses/decimals must be consistent.
- `POOL_FEE_TIER` determines tickSpacing and must be compatible with chosen range ticks.

---

### 4.2 PriceService (price.service.ts)
**Goal:** compute reference ETH price for decisions and valuations.

**Depends on:**
- ConfigService
- HedgeService (or direct CEX adapter) for CEX prices
- LpPositionService or direct pool RPC for DEX price / sqrtPriceX96
- Provider/RPC

**Key behaviors**
- Pull **DEX spot** from pool sqrtPriceX96
- Pull **CEX mark price** (Binance mark or index)
- Compute **reference price** (filtering outliers / sanity checks)

**Outputs**
- `ReferencePrice { price, sources, confidence, spread }`
- Used by StrategyEngine, RiskManager, Ledger

**Note:** In current implementation, LP service also computes pool spot price from slot0.
PriceService exists to unify pricing across components and avoid duplicated conversion logic.

---

### 4.3 LpPositionService (lp-position.service.ts)
**Goal:** manage and query Uniswap v3 position NFT.

**Depends on:**
- ConfigService
- WalletService (balances, allowances)
- TxPolicyService (sendTx/waitConfirmed)
- MonitoringService
- ethers provider and signer

**Core read methods**
- `getPoolState()` → `slot0`, `tick`, `sqrtPriceX96`, liquidity
- `getPosition()` / `getPositionById(tokenId)` → tick bounds, liquidity, fee tier
- `getComposition(referencePrice)` → WETH/USDC amounts + total value + distances to bounds

**Core write methods**
- `decreaseLiquidity({ percent })`
  - Sends PositionManager.decreaseLiquidity
  - Waits for confirmation
- `collectFees()`
  - Sends PositionManager.collect
  - Waits for confirmation
- `mintNewPositionForBudget({ tickLower, tickUpper, budgetPolicy })`
  - Validates range contains current price
  - Reads wallet balances
  - Applies safety buffers
  - Ensures allowances
  - Calls PositionManager.mint
  - Parses new tokenId from ERC721 Transfer event
  - Returns used/leftover balances

**Utility / range**
- `calculateSymmetricRange(rangeWidthPercent)`
  - Computes `tickLower/tickUpper` around spot price using tickSpacing constraints

**Invariants**
- Mapping of pool token0/token1 must match on-chain values.
- `tickLower < currentTick < tickUpper` for mint.
- Token decimals must be correct for price conversions and amount encoding.

---

### 4.4 HedgeService (hedge.service.ts)
**Goal:** manage Binance perpetual hedge position for ETHUSDT.

**Depends on:**
- ConfigService
- Exchange API adapter (ccxt/official)
- MonitoringService
- Risk thresholds (min notional, etc.)

**Read**
- `getPosition()` returns:
  - `hasPosition`
  - `shortSizeEth`
  - `shortNotionalUsdc`
  - `equity`
  - `unrealizedPnl`
  - `liquidationDistancePercent` (computed from exchange data)

**Write**
- `setTargetShortNotional(targetUsdc, urgency)`
  Computes delta between current and target:
  - If increase: open/increase short (market or limit logic)
  - If decrease: reduce-only close portion
  Enforces:
  - minimum notional
  - max slippage/spread constraints (if implemented)
  Returns execution summary:
  - `operation: open/increase/decrease/close/noop`
  - `deltaUsdc`
  - `avgExecutionPrice`
  - `orderIds`

**Invariants**
- Avoid over-trading: do nothing if deviation < threshold.
- Avoid liquidation: in danger zone, reduce risk rather than increase.

---

### 4.5 StrategyEngine (strategy.service.ts)
**Goal:** decide what actions to take.

**Depends on:**
- ConfigService thresholds (hedgeRatio, resetNearBoundary, rangeWidth, etc.)
- No IO (pure-ish), but invoked with inputs from other services.

**Key calculations**
- **Hedge target**: how much short notional is needed given LP composition.

For MVP we use practical, not “Greeks”:
- `lpWethValueUsdc = lp.wethAmount * referencePrice`
- `targetShortUsdc = lpWethValueUsdc * hedgeRatio`

(hedgeRatio typically 0.90–1.00; e.g. 0.95)

**Rehedge decision**
- compute deviation:
  - `abs(currentShortUsdc - targetShortUsdc) / targetShortUsdc`
- if deviation > `REHEDGE_THRESHOLD` → rehedge action

**Reset-range decision**
- use distances to bounds:
  - if `distanceToLowerPercent <= resetNearBoundaryPercent`
  - OR `distanceToUpperPercent <= resetNearBoundaryPercent`
  → reset-range is triggered

**Range selection**
- For symmetric ±X%:
  - lowerPrice = spot*(1 - X)
  - upperPrice = spot*(1 + X)
  - ticks computed by LpPositionService.priceToTick and nearestUsableTick

**Outputs**
- ActionPlan:
  - `type: emergency_exit | reset_range | rehedge | noop`
  - parameters (ticks, rehedge target, urgency, etc.)

---

### 4.6 RiskManager / RiskService (risk.service.ts)
**Goal:** enforce kill-switch and execution gates.

**Depends on:**
- ConfigService thresholds
- MonitoringService
- StateStore (optional for persistent stats)
- Inputs: price, LP composition, hedge snapshot

**Core checks (examples, must be explicit)**
- **Price integrity**
  - DEX vs CEX spread not above `maxPriceSpreadBps` or percent threshold
  - ReferencePrice confidence acceptable
- **Hedge safety**
  - `liquidationDistancePercent >= dangerLiquidationDistancePercent`
  - `marginBuffer >= minMarginBufferPercent`
- **Operational safety**
  - Only one operation at a time: `operationInProgress` flag
  - RPC health OK (latency/error rate)
  - Exchange health OK (API errors)
- **Drawdown**
  - If tracked PnL drawdown exceeds `maxDrawdownPercent` → emergency exit

**Gates**
- `canExecuteReset(riskFlags)` → must be true before reset-range
- `canSwap(riskFlags)` → only if price integrity ok and not in danger state
- `shouldEmergencyExit(riskFlags)` → triggers emergencyExit flow

**Emergency exit policy**
- Close hedge reduce-only
- Withdraw/decrease LP to zero
- Collect
- Convert to stable if configured (optional)
- Mark system safe state

---

### 4.7 ExecutionOrchestrator (execution.service.ts)
**Goal:** execute multi-step flows safely and resumably.

**Depends on:**
- StrategyEngine (decisions)
- RiskManager (gates and status)
- LpPositionService (decrease/collect/mint/getComposition)
- WalletService (rebalance swap to 50/50)
- HedgeService (setTargetShortNotional)
- TxPolicyService (sendTx/waitConfirmed)
- StateStore (operation/step persistence)
- LedgerService (record tick)
- MonitoringService

**Key concept:** Operations are persisted as OpState + StepState.
If process crashes mid-reset, `resumeResetRange()` replays unfinished steps.

---

### 4.8 StateStore (state-store.service.ts)
**Goal:** persistent source-of-truth for bot state and ongoing operations.

**Depends on:**
- MongoDB connection
- ConfigService
- Logger

**Key state**
- `activeTokenId` (current LP NFT tracked)
- operations:
  - operationId
  - operationType (reset_range)
  - data snapshot (ticks, tx hashes, token ids)
  - step statuses (started/completed/failed/skipped)
  - timestamps

**Critical**
- Must call `StateStore.start()` at app startup.
- Bot main loop requires activeTokenId; without it, loop skips.

---

### 4.9 WalletService (wallet.service.ts)
**Goal:** wallet balances, approvals, swaps.

**Depends on:**
- ethers provider + wallet signer
- ConfigService token addresses
- TxPolicyService
- DEX router/quoter (if used)
- MonitoringService

**Key methods**
- `getBalances()` → { usdc, weth, ethForGas }
- `getBalancesWithValue(referencePrice)` → includes totalValueUsdc
- `ensureAllowance(token, spender, amount)` → sends approve if needed
- `rebalanceTo50_50({ referencePrice, deviationThresholdPct, maxSlippageBps, deadlineSec, minNotionalUsdc })`
  On-chain swap to bring wallet closer to 50/50 WETH+USDC before mint.
  Should:
  - compute imbalance
  - decide direction WETH→USDC or USDC→WETH
  - compute amountIn and minOut
  - execute swap via router
  - return txHash and amounts

---

### 4.10 TxPolicyService (tx-policy.service.ts)
**Goal:** centralized tx sending policy: gas, nonce, confirmation, retries.

**Depends on:**
- provider
- wallet signer
- ConfigService tx settings

**Key methods**
- `sendTx({ to, data, description })`
  - sets EIP-1559 params
  - manages nonce policy
  - submits tx
  - returns txHash
- `waitConfirmed(txHash)`
  - waits receipt
  - returns receipt + computed cost, status, logs

**Invariants**
- Gas policy must cap maxFee/maxPriority to avoid runaway.
- Nonce must not collide if multiple tx in flight.

---

### 4.11 LedgerService (ledger.service.ts)
**Goal:** record operational metrics to analyze PnL and system behavior.

**Depends on:**
- StateStore or DB
- Logger

**Records**
- reference prices
- lp composition and ticks
- hedge snapshot
- per-step outcomes
- optional funding and fees (if integrated)

---

### 4.12 SchedulerService (scheduler.ts)
**Goal:** cron scheduling for background checks.

**Depends on:**
- MonitoringService
- App callback functions

**Jobs**
- health_check: ensure main loop not stalled
- position_sync: verify tokenId exists and composition readable
- funding_rate: periodic funding snapshots (optional)

---

### 4.13 App / Entry points (app.ts, index.ts)
**index.ts**
- loads config
- constructs DI container (or manual wiring)
- calls `app.run()`

**app.ts**
- initializes StateStore
- starts scheduler
- starts main loop

---

## 5) Reset-range operation (the most important flow)

### 5.1 Why reset-range exists
When price approaches tick bounds, the LP position becomes inefficient:
- In-range → earning fees
- Out-of-range → mostly one asset, earning nearly 0 fees

Reset-range closes the old position and mints a new one around current price.

### 5.2 Reset-range steps (canonical order)
The bot uses **new NFT per reset**.

**Preflight**
- read price, LP composition, hedge snapshot
- risk evaluation; must pass

**Hedge safety (optional but recommended)**
- if liquidation distance is low, reduce short notional to avoid liquidation during reset

**Decrease liquidity (100%)**
- PositionManager.decreaseLiquidity(tokenId, liquidity)
- wait confirmation

**Collect fees**
- PositionManager.collect(tokenId)
- wait confirmation

**Balances snapshot**
- read wallet balances; compute total value

**On-chain swap (rebalance to 50/50)**
- If wallet holdings not near 50/50 by value:
  - swap USDC↔WETH to bring closer to 50/50
- Respect slippage and min notional thresholds
- wait confirmation
- skip if below threshold or disabled

**Allowances**
- ensure allowance for token0 and token1 to PositionManager

**Mint new position**
- mint with new ticks and budget policy
- parse new tokenId
- set tokenId in LpPositionService and in StateStore

**Hedge after reset**
- compute new LP composition
- compute targetShortUsdc
- call HedgeService.setTargetShortNotional(targetShortUsdc)

**Ledger record**
- record final LP + hedge snapshot

**Done**
- set `activeTokenId = newTokenId`
- record reset timestamp/counters
- complete OpState

### 5.3 Resumability contract
At any step:
- mark step started
- send tx / place order
- persist txHash/orderIds in OpState
- on restart:
  - `resumeResetRange()` checks step completion and continues

---

## 6) Hedge logic (MVP)

### 6.1 What we hedge
We hedge **ETH exposure** of LP approximated by:
- LP WETH amount valued in USDC

**Definition**
- `lpWethValueUsdc = lp.wethAmount * referencePrice`

**Target**
- `targetShortUsdc = lpWethValueUsdc * hedgeRatio`

Where `hedgeRatio` typically 0.90–1.00 (MVP uses 0.95).

### 6.2 Rehedge threshold
We avoid micro-adjustments:

- If `abs(currentShortUsdc - targetShortUsdc) / targetShortUsdc <= rehedgeThreshold`
  → do nothing.

Example: `rehedgeThreshold = 20%`

---

## 7) Configuration (env) — core blocks

### 7.1 Pool (Arbitrum WETH/USDC 0.05%)
Example:
- `POOL_ADDRESS=0xC6962004f452bE9203591991D15f6b388e09E8D0`
- Token0 WETH: `0x82aF...fBab1` decimals 18
- Token1 USDC native: `0xaf88...e5831` decimals 6
- Fee tier 500 (0.05%), tickSpacing 10

### 7.2 Critical operational flags
- `SIMULATION_MODE` — disables real tx and orders
- `LOOP_INTERVAL_SEC` — main loop frequency

### 7.3 Strategy thresholds (examples)
- `RANGE_WIDTH_PERCENT=10`
- `RESET_NEAR_BOUNDARY_PERCENT=2.5`
- `HEDGE_RATIO=0.95`
- `REHEDGE_THRESHOLD_PERCENT=20`

### 7.4 Risk thresholds (examples)
- `MAX_DRAWDOWN_PERCENT=10`
- `MIN_MARGIN_BUFFER_PERCENT=30`
- `MAX_PRICE_SPREAD_BPS=60`
- `DANGER_LIQ_DISTANCE_PERCENT=20` (example)

### 7.5 Swap policy (wallet rebalance during reset)
- `SWAP_DEVIATION_THRESHOLD_PCT` (how close to 50/50 required)
- `SWAP_MAX_SLIPPAGE_BPS`
- `SWAP_DEADLINE_SEC`
- `SWAP_MIN_NOTIONAL_USDC`

### 7.6 Tx policy
- `MAX_GAS_PRICE_GWEI`
- `DEFAULT_SLIPPAGE_TOLERANCE`
- `DEFAULT_DEADLINE_SECONDS`

---

## 8) Operational modes

### 8.1 Read-only mode (recommended first)
- Do not execute swaps/mints/decrease
- Only read LP/hedge state and compute decisions
- Should produce “action plan” logs without performing actions

(If not implemented: emulate by setting `SIMULATION_MODE=true` and/or disabling scheduler jobs and execution.)

### 8.2 Hedge-only mode
- Keep LP fixed
- Only call `setTargetShortNotional()` when deviating

### 8.3 Controlled reset mode
- Execute exactly one reset-range
- Then disable resets and continue in hedge-only or read-only

---

## 9) Testing approach

### 9.1 Unit tests (Jest)
- StrategyEngine pure calculations:
  - computeHedgeTarget
  - shouldRehedge
  - shouldResetRange
- RiskManager gates:
  - canExecuteReset
  - shouldEmergencyExit
- ExecutionOrchestrator step ordering:
  - ensure reset steps occur in canonical order
  - ensure state persistence calls happen for each step
  - ensure resume works

### 9.2 Integration tests (sandbox)
- Use `SIMULATION_MODE=true`
- Stub RPC responses and Binance responses

### 9.3 Live test (small capital)
- Fund Arbitrum wallet:
  - ETH for gas
  - WETH/USDC for LP
- Open LP manually or via bot mint
- Fund Binance margin in USDT
- Open minimal short (>= minTradeNotional)
- Start bot; confirm:
  - reads activeTokenId
  - computes target short
  - adjusts hedge
  - does not reset until boundary condition occurs

---

## 10) Known sharp edges / gotchas

1. **activeTokenId is mandatory**
   If missing, main loop skips. Ensure StateStore initialization sets it or store it from config.
2. **node-cron missed execution warnings**
   Long blocking IO in main loop can cause cron misses. Consider:
   - running cron tasks lightweight
   - avoid blocking loops
   - or use separate process for scheduler
3. **Token ordering and price inversion**
   Uniswap token0/token1 are sorted by address. Price conversion must respect correct inversion and decimals.
4. **USDC native vs bridged**
   Arbitrum has multiple USDC variants historically. Using native USDC address is required for correct balances/UX.
5. **WETH vs ETH**
   Uniswap v3 pool uses ERC20 WETH, not native ETH. Wallet must hold WETH to mint; keep ETH only for gas.
6. **Approvals**
   Ensure allowances are sufficient for PositionManager and swap router.
7. **Reset-range can be expensive**
   Multiple txs; ensure enough ETH for gas and set gas caps.

---

## 11) Concrete “what runs on schedule” (current MVP)

### Main loop
- Runs every `LOOP_INTERVAL_SEC` (e.g. 60s)
- Performs decision and possibly execution

### Scheduled jobs
- `monitoring.health_check` every 1 minute
- `monitoring.position_sync` every 5 minutes
- `monitoring.funding_rate` at minute 55 each hour

---

## 12) Recommended next improvements (roadmap)

1. **Explicit read-only / hedge-only toggles**
2. **TWAP pricing** (avoid manipulation, safer reference price)
3. **Better LP “composition” and leftover tracking**
4. **Fee parsing from collect receipts**
5. **Safer swap routing** (quoting, minOut, multi-hop)
6. **Async isolation** (split scheduler and main loop into separate processes)
7. **PnL accounting** (fees, funding, hedge PnL, gas)
8. **Crash recovery hardening** (idempotent step checks, tx receipt re-reads)

---

## 13) Minimal mental model (one paragraph)

Atlas keeps a Uniswap v3 WETH/USDC position earning fees in a tight range. The LP position’s ETH exposure is continuously hedged by a Binance ETHUSDT short. Every loop, it reads the pool, computes LP composition, checks hedge health, decides whether to rehedge or reset-range, then executes in a safe stepwise sequence with persistent state so that crashes can resume without leaving the portfolio naked.

---