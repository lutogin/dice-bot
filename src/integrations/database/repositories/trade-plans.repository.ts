import { injectable, inject } from 'tsyringe';
import { TOKENS } from '../../../di/tokens';
import { MongoDBClient } from '../mongo-client';
import {
  TradePlan,
  PlanStatus,
} from '../../../domain/setup-engine/setup-engine.types';

interface TradePlanDoc {
  _id: string;
  eventId: string;
  symbol: string;
  side: string;
  entryTriggerPrice: number;
  entryType: string;
  stopPrice: number;
  tp1Price: number;
  tp2Price: number;
  qty: number;
  notionalUsdc: number;
  riskUsdc: number;
  riskPercent: number;
  stallHigh: number;
  stallLow: number;
  impulseExtreme: number;
  status: string;
  createdAt: number;
  expiresAt: number;
  armedAt?: number;
  triggeredAt?: number;
  filledAt?: number;
  updatedAt: Date;
}

@injectable()
export class TradePlansRepository {
  constructor(@inject(TOKENS.MONGO_CLIENT) private mongo: MongoDBClient) {}

  private get collection() {
    return this.mongo.getCollection<TradePlanDoc>('trade_plans');
  }

  async save(plan: TradePlan): Promise<void> {
    await this.collection.updateOne(
      { _id: plan.id },
      {
        $set: {
          _id: plan.id,
          eventId: plan.eventId,
          symbol: plan.symbol,
          side: plan.side,
          entryTriggerPrice: plan.entryTriggerPrice,
          entryType: plan.entryType,
          stopPrice: plan.stopPrice,
          tp1Price: plan.tp1Price,
          tp2Price: plan.tp2Price,
          qty: plan.qty,
          notionalUsdc: plan.notionalUsdc,
          riskUsdc: plan.riskUsdc,
          riskPercent: plan.riskPercent,
          stallHigh: plan.stallHigh,
          stallLow: plan.stallLow,
          impulseExtreme: plan.impulseExtreme,
          status: plan.status,
          createdAt: plan.createdAt,
          expiresAt: plan.expiresAt,
          armedAt: plan.armedAt,
          triggeredAt: plan.triggeredAt,
          filledAt: plan.filledAt,
          updatedAt: new Date(),
        },
      },
      { upsert: true },
    );
  }

  async updateStatus(
    id: string,
    status: PlanStatus,
    timestamps?: Partial<
      Pick<TradePlan, 'armedAt' | 'triggeredAt' | 'filledAt'>
    >,
  ): Promise<void> {
    const update: any = {
      status,
      updatedAt: new Date(),
    };

    if (timestamps?.armedAt) update.armedAt = timestamps.armedAt;
    if (timestamps?.triggeredAt) update.triggeredAt = timestamps.triggeredAt;
    if (timestamps?.filledAt) update.filledAt = timestamps.filledAt;

    await this.collection.updateOne({ _id: id }, { $set: update });
  }

  async findById(id: string): Promise<TradePlan | null> {
    const doc = await this.collection.findOne({ _id: id });
    if (!doc) return null;
    return this.mapDocToPlan(doc);
  }

  async findByEventId(eventId: string): Promise<TradePlan | null> {
    const doc = await this.collection.findOne({ eventId });
    if (!doc) return null;
    return this.mapDocToPlan(doc);
  }

  async findByStatus(
    status: PlanStatus,
    limit: number = 100,
  ): Promise<TradePlan[]> {
    const docs = await this.collection
      .find({ status })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();

    return docs.map(this.mapDocToPlan);
  }

  async findRecent(limit: number = 50): Promise<TradePlan[]> {
    const docs = await this.collection
      .find({})
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();

    return docs.map(this.mapDocToPlan);
  }

  private mapDocToPlan(doc: TradePlanDoc): TradePlan {
    return {
      id: doc._id,
      eventId: doc.eventId,
      symbol: doc.symbol,
      side: doc.side as any,
      entryTriggerPrice: doc.entryTriggerPrice,
      entryType: doc.entryType as any,
      stopPrice: doc.stopPrice,
      tp1Price: doc.tp1Price,
      tp2Price: doc.tp2Price,
      qty: doc.qty,
      notionalUsdc: doc.notionalUsdc,
      riskUsdc: doc.riskUsdc,
      riskPercent: doc.riskPercent,
      stallHigh: doc.stallHigh,
      stallLow: doc.stallLow,
      impulseExtreme: doc.impulseExtreme,
      status: doc.status as any,
      createdAt: doc.createdAt,
      expiresAt: doc.expiresAt,
      armedAt: doc.armedAt,
      triggeredAt: doc.triggeredAt,
      filledAt: doc.filledAt,
    };
  }
}
