# Rehedge Metrics Explained

## Two Different Metrics (Don't Confuse Them!)

### 1. LP Delta Drift (PRIMARY TRIGGER)

**Formula:** `|currentWethInLP - wethAtLastHedge| / wethAtLastHedge`

**What it measures:** How much the LP position's WETH exposure has changed since the last hedge.

**Example:**

- Last hedge: 1.953694 WETH in LP
- Current: 1.824807 WETH in LP
- Drift: |1.824807 - 1.953694| / 1.953694 = 6.60%

**This is what triggers rehedge decisions!**

### 2. Hedge Gap (DIAGNOSTIC ONLY)

**Formula:** `|currentShort - targetShort| / targetShort`

**What it measures:** How far the current hedge is from the ideal target.

**Example:**

- Current short: $3,825
- Target short: $4,965
- Gap: $1,140 / $4,965 = 22.97%

**This is NOT a trigger - it just shows execution size!**

## Why They're Different

LP Delta Drift tracks **position changes** (risk metric).
Hedge Gap tracks **execution size** (operational metric).

### Normal Scenario:

1. Price moves, LP delta changes by 6.6%
2. We don't rehedge on every tiny move (threshold = 5.56%)
3. Gap accumulates to 22.97% over time
4. When drift exceeds threshold → rehedge closes the entire gap in one trade

### Why This Is Good:

- ✅ Fewer trades = lower fees
- ✅ Fewer trades = less funding rate exposure
- ✅ One larger rehedge is more efficient than 5 small ones

## Telegram Message Format (Fixed)

**Before (confusing):**

```
Deviation: 22.97%
Threshold: 5.56%
```

→ Makes you think: "WTF? 22.97% > 5.56%, why didn't we rehedge earlier?"

**After (clear):**

```
LP Delta Drift: 6.60%
Threshold: 5.56%
Hedge Gap: 22.97% (diagnostic)
```

→ Now it's obvious: drift 6.60% just exceeded threshold 5.56%, triggering rehedge.

## Code Locations

- **Decision logic:** `src/domain/rehedge-decision/rehedge-decision.service.ts`
- **Event emission:** `src/domain/execution/execution.service.ts`
- **Telegram formatting:** `src/domain/communicator/communicator.service.ts`

## Key Takeaway

**LP Delta Drift** = trigger metric (what we check)
**Hedge Gap** = execution size (what we fix)

Don't mix them up!
