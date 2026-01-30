# FFE Trading Bot (Forced Flow Exploitation)

Торговый бот для эксплуатации вынужденных потоков на криптовалютных фьючерсах.

## Концепция

FFE бот торгует **не импульс, а его последствия**. Когда происходит каскад ликвидаций, большинство трейдеров либо попадают под раздачу, либо пытаются запрыгнуть в уходящий поезд. FFE делает иначе:

1. **Детектирует** forced event (ликвидационный каскад)
2. **Ждёт** пока вынужденные продавцы/покупатели иссякнут
3. **Фильтрует** continuation vs exhaustion (не входит в трендовые дни)
4. **Входит** когда появляется absorption (поглощение) — цена перестаёт падать несмотря на давление
5. **Выходит** по правилам с time-stop и trailing

## Архитектура

```
┌─────────────────────────────────────────────────────────────────┐
│                        Binance WebSocket                         │
│              (trades, orderbook, liquidations, OI)               │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      MarketDataService                           │
│         Нормализация данных в единый формат                      │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     DataIntegrityGuard                           │
│    Проверка: WS gaps, stale data, latency, frozen books          │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                       FeatureBuilder                             │
│    Расчёт фич: ret_30s, rv_30s, cvd_30s, book_imbalance и др.   │
└─────────────────────────────┬───────────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
┌─────────────────────────┐     ┌─────────────────────────┐
│   LiqBurstDetector      │     │   CrowdingDetector      │
│   Детект ликвидаций     │     │   Детект crowding       │
└───────────┬─────────────┘     └───────────┬─────────────┘
            │                               │
            └───────────────┬───────────────┘
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                     SignalClassifier                             │
│      Фильтрация + проверка DataIntegrity (gate)                  │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                       SetupEngine                                │
│   Adaptive stall threshold + Continuation filter + Plan          │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     ExecutionEngine                              │
│   Entry + Time-stop + No-follow-through + Trailing + MAE/MFE     │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      RiskManager                                 │
│         Position sizing, daily limits, kill switch               │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     JournalService                               │
│         Запись сделок в MongoDB + метрики + MAE/MFE              │
└─────────────────────────────────────────────────────────────────┘
```

## Ключевые защиты

### 1. DataIntegrityGuard

Запрещает торговлю если:

- WS отвалился / реконнект слишком частый
- Задержка данных > 500ms
- Book/trades "замёрзли" (нет обновлений 10+ сек)
- Sequence gaps в orderbook

### 2. Continuation Filter

Абортирует сетап если после импульса:

- Цена продолжает делать новые экстремумы (>1%)
- CVD и цена согласованы (нет дивергенции)
- Spread расширяется
- Book replenish слабый (<0.3)

Нужно минимум 2 сигнала continuation чтобы отменить сетап.

### 3. Adaptive Stall Threshold

Порог stall **не фиксированный**, а зависит от текущей волатильности:

```
stallThreshold = rv30s × 1.5
clamped to [0.05%, 0.3%]
```

На спокойном рынке 0.12% — много, на волатильном — мало. Адаптивный порог решает эту проблему.

### 4. Time-Based Exits

**No Follow-Through (60 сек):**

- Если за первые 60 сек MFE < 0.15R → scratch

**Time Stop (5 мин):**

- Если за 5 мин MFE < 0.2R и P&L > -0.3R → scratch

Убирает "болото" где платишь комиссии и ловишь случайный стоп.

### 5. Realistic Slippage Model

```
slippage = a×spread + b×rv + c×(notional/depth) + noise
clamped to [0.01%, 0.5%]
```

Компоненты:

- Spread: 50% от half-spread
- Volatility: 30% от rv30s
- Impact: notional / assumed_depth × 0.1%
- Noise: ±20% случайный

## Детекторы сигналов

### 1. LiqBurstDetector (Ликвидационный каскад)

Срабатывает когда одновременно:

- `liq_notional_30s > max(10M$, 8 × median_liq_1h)` — объём ликвидаций аномально высокий
- `|ret_30s| > 0.6%` — цена резко двинулась
- `rv_30s > p90_rv_24h` — волатильность в топ-10% за сутки

### 2. CrowdingDetector (Переполненные позиции)

Срабатывает когда:

- OI вырос на 5%+ за 30 минут
- Funding rate экстремальный (>0.05% за 8ч)
- Цена при этом стоит на месте (stall)

## Пример сделки

### Сценарий: Ликвидационный каскад на ETHUSDT

**Шаг 1: Детект события**

```
Время: 14:32:15 UTC
Событие: LIQ_BURST detected

Данные:
- ret_30s: -1.4% (резкое падение)
- liq_notional_30s: $85M (при медиане $6M = 14x)
- rv_30s: в топ-5% дня
- sideHint: DOWN (импульс вниз = ликвидировали лонги)
```

**Шаг 2: DataIntegrity Check**

```
DataIntegrityGuard проверяет:
✓ WS connected, no recent reconnects
✓ Latency < 500ms (текущая: 45ms)
✓ Book updated 0.2s ago
✓ No sequence gaps

Результат: HEALTHY → торговля разрешена
```

**Шаг 3: Классификация**

```
SignalClassifier проверяет:
✓ DataIntegrity healthy
✓ Severity > 0.3 (у нас 0.47)
✓ Волатильность достаточная
✓ Не в cooldown периоде

Результат: PASSED → создаём setup
```

**Шаг 4: Ожидание absorption (30-300 сек)**

```
SetupEngine мониторит с ADAPTIVE threshold:
- rv30s: 0.08% → stallThreshold = 0.12%
- stallRangePct10s: текущий диапазон цены

Continuation check каждые 200ms:
- Цена не делает новых лоу ✓
- CVD divergence есть ✓
- Spread нормальный ✓
- Replenish > 0.3 ✓

Через 65 секунд:
- Цена: 2248-2253 (диапазон 0.10% < threshold 0.12% = stall!)
- CVD: продолжает падать (продают)
- Стакан: быстро восстанавливается

→ Паттерн "продают, но не падает" = absorption confirmed
```

**Шаг 5: Формирование плана**

```
TradePlan:
- Symbol: ETH/USDT:USDT
- Side: LONG (против импульса)
- Entry trigger: 2253.11 (stall_high + 0.05% buffer)
- Stop: 2237.60 (low импульса - 0.1% buffer)
- TP1: 2268.62 (+1R)
- TP2: 2284.13 (+2R)

Position sizing (equity $10,000):
- Risk: 0.5% = $50
- Stop distance: 0.69%
- Notional: $7,246
- Qty: 3.22 ETH
```

**Шаг 6: Исполнение с реалистичным slippage**

```
14:33:20 - Цена пробила 2253.11 → ENTRY

Slippage calculation:
- spread component: 0.015%
- rv component: 0.024%
- impact component: 0.008%
- noise: -0.003%
- total: 0.044%

14:33:20 - Market order filled @ 2254.10
14:33:20 - Stop-loss set @ 2237.60
14:33:20 - TP1 target @ 2269.60

Slippage: 0.044% ($3.19)
Fees: $2.90
```

**Шаг 7: Time-based monitoring**

```
14:33:20 - Entry @ 2254.10
14:33:50 - 30 sec: MFE = 0.08R (watching...)
14:34:20 - 60 sec: MFE = 0.22R ✓ (follow-through confirmed!)

No-follow-through check PASSED → держим позицию
```

**Шаг 8: Управление позицией**

```
14:45:00 - Цена достигла 2269.60 → TP1 HIT
         - Закрыто 50% позиции (+$24.50)
         - Stop moved to breakeven (2254.50)
         - Trailing stop activated

15:12:00 - High: 2281.30, trailing stop: 2273.55
15:18:00 - Цена откатилась до 2273.55 → TRAILING STOP HIT
         - Закрыто оставшиеся 50% (+$30.70)
```

**Результат:**

```
Entry: 2254.10
Exit (avg): 2271.58
P&L: +$55.20 (+1.10R)
Fees: $5.80
Slippage: $3.19
Net P&L: +$46.21
Hold time: 45 минут
MFE: +1.21%
MAE: -0.08%
```

## Правила входа

| Критерий            | Значение                  | Описание                    |
| ------------------- | ------------------------- | --------------------------- |
| Data Integrity      | HEALTHY                   | WS ok, latency ok, no gaps  |
| Тип события         | LIQ_BURST или OI_CROWDING | Только forced flow          |
| Severity            | > 0.3                     | Достаточно сильный сигнал   |
| Stall range         | < rv30s × 1.5 (adaptive)  | Цена остановилась           |
| CVD divergence      | Против цены               | Давление есть, движения нет |
| Book replenish      | > 0.6                     | Стакан восстанавливается    |
| Continuation filter | PASSED                    | Не trend day                |
| Cooldown            | Прошёл                    | Не торгуем подряд           |

## Правила выхода

| Правило           | Условие                        | Действие               |
| ----------------- | ------------------------------ | ---------------------- |
| Stop-loss         | Цена достигла стопа            | Закрыть 100%           |
| No follow-through | 60 сек, MFE < 0.15R            | Scratch (закрыть ~0)   |
| Time stop         | 5 мин, MFE < 0.2R, P&L > -0.3R | Scratch                |
| TP1 (+1R)         | Цена достигла TP1              | Закрыть 50%, стоп в BE |
| Trailing          | После TP1, trail 0.5R          | Двигаем стоп за ценой  |
| TP2 (+2R)         | Цена достигла TP2              | Закрыть оставшееся     |
| Kill switch       | Ручная команда                 | Закрыть всё немедленно |
| Daily limit       | -1.5% от equity                | Стоп торговли на день  |

## Риск-менеджмент

- **Риск на сделку:** 0.25% - 0.75% от equity
- **Макс. позиций:** 1-2 одновременно
- **Дневной лимит:** -1.5% (торговля останавливается)
- **Макс. notional:** $15,000 на сделку

## Режимы работы

### Simulation (Paper Trading)

```env
FFE_SIMULATION=true
```

- Виртуальный equity $10,000
- Симуляция fills с реалистичным slippage model
- Полное отслеживание MAE/MFE/fees
- Сохранение в MongoDB
- Telegram уведомления с меткой `[SIM]`

### Live Trading

```env
FFE_SIMULATION=false
BINANCE_API_KEY=your_key
BINANCE_SECRET=your_secret
```

## Telegram команды

| Команда    | Описание                        |
| ---------- | ------------------------------- |
| `/status`  | Текущие позиции и P&L           |
| `/stats`   | Общая статистика                |
| `/metrics` | Дневные метрики                 |
| `/trades`  | Последние 5 сделок              |
| `/kill`    | Аварийное закрытие всех позиций |
| `/help`    | Список команд                   |

В simulation mode все сообщения помечены `🎮 SIMULATION`.

## Логирование "почему НЕ вошли"

Бот логирует причины отклонения сетапов для анализа:

```
[SetupEngine] Stall not confirmed yet
  symbol: ETHUSDT
  elapsed: 45.2s
  reasons: ["range_too_wide:0.18%>0.12%", "low_replenish:0.42<0.6"]
  stallRange: 0.180%
  threshold: 0.120%
  replenish: 0.42
```

```
[SetupEngine] Setup ABORTED - continuation detected
  symbol: BTCUSDT
  continuationReasons: ["price_continuing_down_-1.34%", "cvd_price_aligned_continuation"]
```

```
[SetupEngine] Setup EXPIRED - no stall formed
  symbol: ETHUSDT
  waitedSec: 300.0
  lastRejectReasons: ["range_too_wide:0.25%>0.15%"]
```

## Запуск

```bash
# Установка зависимостей
npm install

# Проверка типов
npm run typecheck

# Запуск в dev режиме
npm run dev

# Или через Docker
docker-compose up -d
```

## Конфигурация

Все параметры настраиваются через `.env` файл. См. `.env.example` для полного списка с описаниями.

## Метрики для анализа

После накопления 50-100 сделок анализируй:

1. **Win Rate** — должен быть 45-55%
2. **Avg R** — должен быть > 0.3R
3. **Profit Factor** — должен быть > 1.3
4. **MAE distribution** — насколько глубоко уходит против тебя
5. **MFE distribution** — сколько оставляешь на столе
6. **Filter rate** — какой % сигналов отфильтровывается
7. **Time-stop rate** — сколько сделок закрыто по time-stop
8. **Continuation abort rate** — сколько сетапов отменено continuation filter

## Важно

- Бот торгует **редко** — это нормально. Качество > количество.
- 90%+ сигналов отфильтровывается — это by design.
- Не торгуй в импульс — жди absorption.
- Time-stop убирает "болото" — позиции которые "умирают в воде".
- Continuation filter защищает от trend days.
- Веди журнал и анализируй каждую сделку.
- Логи "почему НЕ вошли" — золото для отладки.
