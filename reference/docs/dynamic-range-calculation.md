# Dynamic LP Range Calculation

## Overview

LP позиция создается с динамическим диапазоном, который рассчитывается на основе текущей волатильности рынка. Чем выше волатильность, тем шире диапазон.

## Архитектура

```
RangeModelService → StrategyEngine → ExecutionOrchestrator → LpPositionService
     (volatility)      (ticks)           (execution)            (on-chain)
```

## 1. Расчет волатильности (Dual-Window)

### Источник данных

- **Exchange:** Binance Futures
- **Symbol:** ETH/USDT:USDT
- **Timeframe:** 30m свечи (configurable)
- **Windows:**
  - 1d = 48 свечей (быстрый сигнал)
  - 3d = 144 свечи (медленный сигнал)

### Формула волатильности

**Шаг 1: Log-returns**

```
returns[i] = ln(close[i] / close[i-1])
```

**Шаг 2: Standard deviation (σ)**

```
σ = sqrt(Σ(returns - mean)² / (n-1))
```

**Шаг 3: Annualization к 24h**

```
vol24h = σ * sqrt(periods_in_24h) * 100

Для 30m свечей:
periods_in_24h = 24 * 60 / 30 = 48
vol24h = σ * sqrt(48) * 100 ≈ σ * 6.93 * 100
```

### Dual-Window Blending

**Spike Detection:**

```typescript
spikeRatio = vol1d / vol3d

if (spikeRatio > 1.5):
  trend = 'RISING'    // Волатильность резко выросла
elif (spikeRatio < 0.7):
  trend = 'FALLING'   // Волатильность упала
else:
  trend = 'STABLE'    // Стабильная волатильность
```

**Weighted Blending:**

```typescript
if (trend === 'RISING'):
  // Доверяем быстрому сигналу - рынок стал волатильным
  effective = vol1d * 0.8 + vol3d * 0.2

elif (trend === 'FALLING'):
  // Осторожно сужаем - не спешим уменьшать диапазон
  effective = vol1d * 0.4 + vol3d * 0.6

else:
  // Сбалансированный подход
  effective = vol1d * 0.6 + vol3d * 0.4
```

**Floor Protection:**

```typescript
// Никогда не опускаемся ниже 85% от максимума
floor = max(vol1d, vol3d) * 0.85;
effective = max(blended, floor);
```

### Пример расчета

```
Исходные данные:
- vol1d = 6.0% (24h)
- vol3d = 4.0% (24h)

Spike ratio:
spikeRatio = 6.0 / 4.0 = 1.5 → STABLE (граница)

Blending:
effective = 6.0 * 0.6 + 4.0 * 0.4 = 5.2%

Floor check:
floor = max(6.0, 4.0) * 0.85 = 5.1%
effective = max(5.2, 5.1) = 5.2% ✓
```

## 2. Классификация режима волатильности

### Volatility Regimes

| Режим          | Диапазон vol24h | Range Width | Описание                    |
| -------------- | --------------- | ----------- | --------------------------- |
| **ULTRA_CALM** | < 1.5%          | 3-4%        | Очень спокойный рынок       |
| **CALM**       | 1.5-3%          | 5-6%        | Спокойный рынок             |
| **NORMAL**     | 3-5%            | 7-10%       | Нормальная волатильность    |
| **VOLATILE**   | 5-8%            | 12-15%      | Повышенная волатильность    |
| **CHAOS**      | > 8%            | 20-25%      | Экстремальная волатильность |

### Интерполяция внутри режима

Диапазон не фиксированный, а интерполируется линейно:

```typescript
// Пример: vol = 4% (NORMAL режим, границы 3-5%)
lowerBound = 3.0
upperBound = 5.0
rangeMin = 7
rangeMax = 10

progress = (4.0 - 3.0) / (5.0 - 3.0) = 0.5
range = 7 + 0.5 * (10 - 7) = 8.5%
```

**Результат:** При волатильности 4% диапазон будет ±8.5%

### Clamping

После интерполяции применяются лимиты из конфига:

```typescript
// Из .env
LP_RANGE_MIN_PERCENT = 0.04  // 4%
LP_RANGE_MAX_PERCENT = 0.15  // 15%

finalRange = clamp(calculatedRange, 4%, 15%)
```

## 3. Конвертация в тики

### От процентов к ценам

```typescript
// Пример: referencePrice = $3000, range = 8%
w = 0.08

priceLower = 3000 * (1 - 0.08) = 3000 * 0.92 = $2,760
priceUpper = 3000 * (1 + 0.08) = 3000 * 1.08 = $3,240
```

### От цен к тикам

**Uniswap V3 формула:**

```
price = 1.0001^tick

tick = log(price) / log(1.0001)
```

**В коде:**

```typescript
// 1. Price → sqrtPriceX96
sqrtPriceX96 = (sqrt(price) * 2) ^ 96;

// 2. sqrtPriceX96 → tick (через TickMath)
rawTick = TickMath.getTickAtSqrtRatio(sqrtPriceX96);

// 3. Round to tickSpacing
tickSpacing = 10; // для fee tier 0.05%
tickLower = floor(rawTickLower / 10) * 10;
tickUpper = ceil(rawTickUpper / 10) * 10;
```

### Пример полного расчета

```
Входные данные:
- referencePrice = $3,000
- vol1d = 6%, vol3d = 4%
- effective = 5.2%
- regime = NORMAL

Шаг 1: Интерполяция range
progress = (5.2 - 5.0) / (5.0 - 3.0) = 0.1
range = 7 + 0.1 * (10 - 7) = 7.3%

Шаг 2: Цены
priceLower = 3000 * 0.927 = $2,781
priceUpper = 3000 * 1.073 = $3,219

Шаг 3: Тики
rawTickLower = log(2781/3000) / log(1.0001) ≈ -7,900
rawTickUpper = log(3219/3000) / log(1.0001) ≈ +7,100

Шаг 4: Округление (tickSpacing = 10)
tickLower = floor(-7900 / 10) * 10 = -7,900
tickUpper = ceil(7100 / 10) * 10 = 7,100

Результат:
Range: [-7900, 7100] ticks
Price: [$2,781, $3,219]
Width: ±7.3%
```

## 4. Кэширование

### Cache TTL

- **Duration:** 5 минут
- **Reason:** Волатильность не меняется каждую секунду

### Fallback

Если расчет волатильности падает:

```typescript
fallbackRange = LP_RANGE_WIDTH_PERCENT; // из .env (default 10%)
```

## 5. Validation

### Sanity Checks

**1. tickLower < tickUpper**

```typescript
if (tickLower >= tickUpper) {
  return { isValid: false, reason: 'Invalid tick order' };
}
```

**2. Current price inside range**

```typescript
poolTick = await getPoolState().tick;

if (poolTick <= tickLower || poolTick >= tickUpper) {
  return { isValid: false, reason: 'Current price outside range' };
}
```

## 6. Code Locations

| Component               | File                     | Method                            |
| ----------------------- | ------------------------ | --------------------------------- |
| Volatility calculation  | `range-model.service.ts` | `calculateDynamicRange()`         |
| Dual-window blending    | `range-model.service.ts` | `getDualWindowVolatility()`       |
| Regime classification   | `range-model.service.ts` | `classifyRegime()`                |
| Range interpolation     | `range-model.service.ts` | `getRangeForRegime()`             |
| Tick calculation        | `strategy.service.ts`    | `computeNewRangeWithValidation()` |
| Price ↔ Tick conversion | `lp-position.service.ts` | `priceToTick()`, `tickToPrice()`  |

## 7. Configuration

### Environment Variables

```bash
# Range limits
LP_RANGE_MIN_PERCENT=0.04      # 4% minimum
LP_RANGE_MAX_PERCENT=0.15      # 15% maximum
LP_RANGE_WIDTH_PERCENT=0.10    # 10% fallback

# Volatility calculation
VOLATILITY_TIMEFRAME=30m       # Candle size
VOLATILITY_CANDLE_COUNT=48     # 1d window
```

### Regime Mapping (hardcoded)

```typescript
DEFAULT_REGIME_RANGE_MAPPING = {
  ULTRA_CALM: { min: 3, max: 4 },
  CALM: { min: 5, max: 6 },
  NORMAL: { min: 7, max: 10 },
  VOLATILE: { min: 12, max: 15 },
  CHAOS: { min: 20, max: 25 },
};
```

## 8. Monitoring

### Logs

```typescript
// Info level - каждый расчет
logger.info('Dynamic range calculated (dual-window)', {
  regime: 'NORMAL',
  vol1d: '6.00%',
  vol3d: '4.00%',
  volEffective: '5.20%',
  spikeRatio: 1.5,
  trend: 'STABLE',
  rangeWidth: '±8.5%',
  expectedMove: '5.20%',
  lpEnabled: true,
});
```

### Events

```typescript
// Если волатильность слишком высокая
eventBus.emit('error', {
  source: 'StrategyEngine',
  message: 'High volatility: RangeModelService recommends LP OFF',
  severity: 'high',
  ctx: {
    regime: 'CHAOS',
    volatility24h: '12.50%',
    suggestedRange: '±22.0%',
  },
});
```

## Summary

1. **Fetches** OHLCV data from Binance (1d + 3d windows)
2. **Calculates** realized volatility (log-returns σ)
3. **Annualizes** to 24h timeframe
4. **Blends** 1d and 3d with spike detection
5. **Classifies** into volatility regime
6. **Interpolates** range width within regime
7. **Clamps** to min/max limits
8. **Converts** to price bounds
9. **Transforms** to Uniswap V3 ticks
10. **Validates** sanity checks

Result: Dynamic, volatility-adaptive LP range that widens in chaos and narrows in calm markets.
