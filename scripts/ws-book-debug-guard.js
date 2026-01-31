/* eslint-disable no-console */
require('dotenv').config();
const { WebsocketClient, USDMClient } = require('binance');

const SYMBOL = process.env.SYMBOL || 'ETH/USDT:USDT';
const LEVELS = Number(process.env.LEVELS || 20);
const UPDATE_MS = Number(process.env.UPDATE_MS || 100);
const MIN_TOP_DEPTH_USD = Number(
  process.env.FFE_DI_MIN_TOP_DEPTH_USD || 10000,
);

const toBinanceSymbol = (symbol) =>
  symbol.replace('/', '').replace(':USDT', '').toUpperCase();

const binanceSymbol = toBinanceSymbol(SYMBOL);
const rest = new USDMClient();
const ws = new WebsocketClient({ beautify: true });

const bids = new Map();
const asks = new Map();
let lastUpdateId = 0;
let debugPrints = 0;

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

  if (debugPrints < 5) {
    debugPrints += 1;
    console.log(
      '[debug depthUpdate]',
      {
        updateId,
        bidDepthDeltaLen: Array.isArray(bidDepthDelta) ? bidDepthDelta.length : null,
        askDepthDeltaLen: Array.isArray(askDepthDelta) ? askDepthDelta.length : null,
        rawBidsLen: rawBids.length,
        rawAsksLen: rawAsks.length,
        bidSample: rawBids[0] || null,
        askSample: rawAsks[0] || null,
      },
    );
  }

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

  const depth5Bid = sumNotional(top5Bids);
  const depth5Ask = sumNotional(top5Asks);
  const depth20Bid = sumNotional(top20Bids);
  const depth20Ask = sumNotional(top20Asks);
  const minDepth = Math.min(depth5Bid, depth5Ask);

  const status = minDepth < MIN_TOP_DEPTH_USD ? 'DEPTH_THIN' : 'OK';

  console.log(
    new Date().toISOString(),
    SYMBOL,
    status,
    `best=${bestBid.toFixed(2)}/${bestAsk.toFixed(2)}`,
    `top5_bid=$${depth5Bid.toFixed(0)}`,
    `top5_ask=$${depth5Ask.toFixed(0)}`,
    `top20_bid=$${depth20Bid.toFixed(0)}`,
    `top20_ask=$${depth20Ask.toFixed(0)}`,
  );
};

const run = async () => {
  console.log(
    `Seeding orderbook for ${SYMBOL} (minTopDepthUsd=${MIN_TOP_DEPTH_USD})...`,
  );
  await seed();
  console.log('Seed complete. Subscribing WS...');
  ws.subscribePartialBookDepths(
    binanceSymbol.toLowerCase(),
    LEVELS,
    UPDATE_MS,
    'usdm',
  );
  setInterval(logDepth, 2000);
};

run().catch((err) => {
  console.error('Error:', err?.message || err);
  process.exit(1);
});
