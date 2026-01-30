import { injectable, inject } from 'tsyringe';
import { TOKENS } from '../../../di/tokens';
import { MongoDBClient } from '../mongo-client';
import {
  TradeRecord,
  TradeResult,
} from '../../../domain/journal/journal.types';

interface TradeDoc {
  _id: string;
  planId: string;
  eventId: string;
  symbol: string;
  side: string;
  entryPrice: number;
  exitPrice: number;
  stopPrice: number;
  tpPrice: number;
  qty: number;
  notionalUsdc: number;
  pnlUsdc: number;
  pnlR: number;
  feesUsdc: number;
  slippageUsdc: number;
  mfe: number;
  mae: number;
  holdTimeMs: number;
  exitReason: string;
  result: string;
  createdAt: number;
  filledAt: number;
  closedAt: number;
  updatedAt: Date;
}

@injectable()
export class TradesRepository {
  constructor(@inject(TOKENS.MONGO_CLIENT) private mongo: MongoDBClient) {}

  private get collection() {
    return this.mongo.getCollection<TradeDoc>('trades');
  }

  async save(trade: TradeRecord): Promise<void> {
    await this.collection.updateOne(
      { _id: trade.id },
      {
        $set: {
          _id: trade.id,
          planId: trade.planId,
          eventId: trade.eventId,
          symbol: trade.symbol,
          side: trade.side,
          entryPrice: trade.entryPrice,
          exitPrice: trade.exitPrice,
          stopPrice: trade.stopPrice,
          tpPrice: trade.tpPrice,
          qty: trade.qty,
          notionalUsdc: trade.notionalUsdc,
          pnlUsdc: trade.pnlUsdc,
          pnlR: trade.pnlR,
          feesUsdc: trade.feesUsdc,
          slippageUsdc: trade.slippageUsdc,
          mfe: trade.mfe,
          mae: trade.mae,
          holdTimeMs: trade.holdTimeMs,
          exitReason: trade.exitReason,
          result: trade.result,
          createdAt: trade.createdAt,
          filledAt: trade.filledAt,
          closedAt: trade.closedAt,
          updatedAt: new Date(),
        },
      },
      { upsert: true },
    );
  }

  async findById(id: string): Promise<TradeRecord | null> {
    const doc = await this.collection.findOne({ _id: id });
    if (!doc) return null;
    return this.mapDocToTrade(doc);
  }

  async findByPlanId(planId: string): Promise<TradeRecord | null> {
    const doc = await this.collection.findOne({ planId });
    if (!doc) return null;
    return this.mapDocToTrade(doc);
  }

  async findBySymbol(
    symbol: string,
    limit: number = 100,
  ): Promise<TradeRecord[]> {
    const docs = await this.collection
      .find({ symbol })
      .sort({ closedAt: -1 })
      .limit(limit)
      .toArray();

    return docs.map(this.mapDocToTrade);
  }

  async findByDateRange(
    startTs: number,
    endTs: number,
  ): Promise<TradeRecord[]> {
    const docs = await this.collection
      .find({ closedAt: { $gte: startTs, $lte: endTs } })
      .sort({ closedAt: -1 })
      .toArray();

    return docs.map(this.mapDocToTrade);
  }

  async findRecent(limit: number = 50): Promise<TradeRecord[]> {
    const docs = await this.collection
      .find({})
      .sort({ closedAt: -1 })
      .limit(limit)
      .toArray();

    return docs.map(this.mapDocToTrade);
  }

  async getStats(sinceTs?: number): Promise<{
    totalTrades: number;
    wins: number;
    losses: number;
    totalPnlUsdc: number;
    totalPnlR: number;
    avgMfe: number;
    avgMae: number;
    avgHoldTimeMs: number;
    totalFees: number;
    totalSlippage: number;
  }> {
    const match = sinceTs ? { closedAt: { $gte: sinceTs } } : {};

    const result = await this.collection
      .aggregate([
        { $match: match },
        {
          $group: {
            _id: null,
            totalTrades: { $sum: 1 },
            wins: { $sum: { $cond: [{ $eq: ['$result', 'WIN'] }, 1, 0] } },
            losses: { $sum: { $cond: [{ $eq: ['$result', 'LOSS'] }, 1, 0] } },
            totalPnlUsdc: { $sum: '$pnlUsdc' },
            totalPnlR: { $sum: '$pnlR' },
            avgMfe: { $avg: '$mfe' },
            avgMae: { $avg: '$mae' },
            avgHoldTimeMs: { $avg: '$holdTimeMs' },
            totalFees: { $sum: '$feesUsdc' },
            totalSlippage: { $sum: '$slippageUsdc' },
          },
        },
      ])
      .toArray();

    if (result.length === 0) {
      return {
        totalTrades: 0,
        wins: 0,
        losses: 0,
        totalPnlUsdc: 0,
        totalPnlR: 0,
        avgMfe: 0,
        avgMae: 0,
        avgHoldTimeMs: 0,
        totalFees: 0,
        totalSlippage: 0,
      };
    }

    const r = result[0]!;
    return {
      totalTrades: r.totalTrades,
      wins: r.wins,
      losses: r.losses,
      totalPnlUsdc: r.totalPnlUsdc,
      totalPnlR: r.totalPnlR,
      avgMfe: r.avgMfe || 0,
      avgMae: r.avgMae || 0,
      avgHoldTimeMs: r.avgHoldTimeMs || 0,
      totalFees: r.totalFees,
      totalSlippage: r.totalSlippage,
    };
  }

  async getDailyStats(date: string): Promise<{
    tradesCount: number;
    wins: number;
    losses: number;
    pnlUsdc: number;
    pnlR: number;
  }> {
    const startOfDay = new Date(date + 'T00:00:00Z').getTime();
    const endOfDay = new Date(date + 'T23:59:59.999Z').getTime();

    const result = await this.collection
      .aggregate([
        { $match: { closedAt: { $gte: startOfDay, $lte: endOfDay } } },
        {
          $group: {
            _id: null,
            tradesCount: { $sum: 1 },
            wins: { $sum: { $cond: [{ $eq: ['$result', 'WIN'] }, 1, 0] } },
            losses: { $sum: { $cond: [{ $eq: ['$result', 'LOSS'] }, 1, 0] } },
            pnlUsdc: { $sum: '$pnlUsdc' },
            pnlR: { $sum: '$pnlR' },
          },
        },
      ])
      .toArray();

    if (result.length === 0) {
      return { tradesCount: 0, wins: 0, losses: 0, pnlUsdc: 0, pnlR: 0 };
    }

    const r = result[0]!;
    return {
      tradesCount: r.tradesCount,
      wins: r.wins,
      losses: r.losses,
      pnlUsdc: r.pnlUsdc,
      pnlR: r.pnlR,
    };
  }

  private mapDocToTrade(doc: TradeDoc): TradeRecord {
    return {
      id: doc._id,
      planId: doc.planId,
      eventId: doc.eventId,
      symbol: doc.symbol,
      side: doc.side as any,
      entryPrice: doc.entryPrice,
      exitPrice: doc.exitPrice,
      stopPrice: doc.stopPrice,
      tpPrice: doc.tpPrice,
      qty: doc.qty,
      notionalUsdc: doc.notionalUsdc,
      pnlUsdc: doc.pnlUsdc,
      pnlR: doc.pnlR,
      feesUsdc: doc.feesUsdc,
      slippageUsdc: doc.slippageUsdc,
      mfe: doc.mfe,
      mae: doc.mae,
      holdTimeMs: doc.holdTimeMs,
      exitReason: doc.exitReason as any,
      result: doc.result as TradeResult,
      createdAt: doc.createdAt,
      filledAt: doc.filledAt,
      closedAt: doc.closedAt,
    };
  }
}
