export class MissedFundingInterval extends Error {
  exchangeId: string;
  intervalStr: string | undefined;

  constructor(exchangeId: string, intervalStr: string | undefined, message?: string) {
    super(message || `Missed funding interval, ${exchangeId}, ${intervalStr}`);
    this.exchangeId = exchangeId;
    this.intervalStr = intervalStr;
  }
}

export class NoPositionFound extends Error {
  exchangeId: string;
  symbol: string;

  constructor(exchangeId: string, symbol: string, message?: string) {
    super(message || `No open position found for ${symbol}, ${exchangeId}`);
    this.exchangeId = exchangeId;
    this.symbol = symbol;
  }
}
