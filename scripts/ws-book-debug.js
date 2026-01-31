/* eslint-disable no-console */
const { WebsocketClient, USDMClient } = require('binance');

const SYMBOL = process.env.SYMBOL || 'ETH/USDT:USDT';
const LEVELS = Number(process.env.LEVELS || 20);
const UPDATE_MS = Number(process.env.UPDATE_MS || 100);

const toBinanceSymbol = (symbol) =>
  symbol.replace('/', '').replace(':USDT', '').toUpperCase();

const binanceSymbol = toBinanceSymbol(SYMBOL);

const rest = new USDMClient();
const ws = new WebsocketClient({ beautify: true });

const bids = new Map();
const asks = new Map();
let lastUpdateId = 0;

const applyUpdates = (side, updates) => {
  for (const level of updates) {
    const price = Number(level[0]);
    const qty = Number(level[1]);
    if (!Number.isFinite(price) || !Number.isFinite(qty)) continue;
    const key = price.toString();
    if (qty <= 0) side.delete(key);
    else side.set(key, qty);
  }
};

const buildLevels = (side, isBid, limit) => {
  const arr = Array.from(side.entries()).map(([p, q]) => [Number(p), q]);
  arr.sort((a, b) => (isBid ? b[0] - a[0] : a[0] - b[0]));
  return arr.slice(0, limit);
};

const sumNotional = (levels) =>
  levels.reduce((sum, [price, qty]) => sum + price * qty, 0);

const seed = async () => {
  const book = await rest.getOrderBook({
    symbol: binanceSymbol,
    limit: LEVELS,
  });

  bids.clear();
  asks.clear();

  for (const [p, q] of book.bids || []) {
    const price = Number(p);
    const qty = Number(q);
    if (Number.isFinite(price) && Number.isFinite(qty)) {
      bids.set(price.toString(), qty);
    }
  }

  for (const [p, q] of book.asks || []) {
    const price = Number(p);
    const qty = Number(q);
    if (Number.isFinite(price) && Number.isFinite(qty)) {
      asks.set(price.toString(), qty);
    }
  }

  lastUpdateId = Number(book.lastUpdateId || 0);
};

ws.on('formattedMessage', (data) => {
  const eventType = data.e || data.eventType;
  if (eventType !== 'depthUpdate') return;

  const updateId = data.lastUpdateId || data.u;
  if (typeof updateId === 'number' && updateId <= lastUpdateId) return;

  const bidDepthDelta = data.bidDepthDelta;
  const askDepthDelta = data.askDepthDelta;

  const rawBids = Array.isArray(bidDepthDelta)
    ? bidDepthDelta.map((b) => [b.price, b.quantity])
    : data.bids || data.b || [];
  const rawAsks = Array.isArray(askDepthDelta)
    ? askDepthDelta.map((a) => [a.price, a.quantity])
    : data.asks || data.a || [];

  applyUpdates(bids, rawBids);
  applyUpdates(asks, rawAsks);

  if (typeof updateId === 'number') lastUpdateId = updateId;
});

const logDepth = () => {
  const top5Bids = buildLevels(bids, true, 5);
  const top5Asks = buildLevels(asks, false, 5);
  const top20Bids = buildLevels(bids, true, 20);
  const top20Asks = buildLevels(asks, false, 20);

  const bestBid = top5Bids[0]?.[0] || 0;
  const bestAsk = top5Asks[0]?.[0] || 0;

  console.log(
    new Date().toISOString(),
    SYMBOL,
    `best=${bestBid.toFixed(2)}/${bestAsk.toFixed(2)}`,
    `depth5_bid=$${sumNotional(top5Bids).toFixed(0)}`,
    `depth5_ask=$${sumNotional(top5Asks).toFixed(0)}`,
    `depth20_bid=$${sumNotional(top20Bids).toFixed(0)}`,
    `depth20_ask=$${sumNotional(top20Asks).toFixed(0)}`,
  );
};

const run = async () => {
  console.log(`Seeding orderbook for ${SYMBOL}...`);
  await seed();
  console.log('Seed complete. Subscribing WS...');
  ws.subscribePartialBookDepths(binanceSymbol.toLowerCase(), LEVELS, UPDATE_MS, 'usdm');
  setInterval(logDepth, 2000);
};

run().catch((err) => {
  console.error('Error:', err?.message || err);
  process.exit(1);
});
