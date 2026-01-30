import { injectable, inject } from 'tsyringe';
import { TOKENS } from '../../../di/tokens';
import { MongoDBClient } from '../mongo-client';
import { ForcedEvent } from '../../../domain/detectors/detector.types';

interface ForcedEventDoc {
  _id: string;
  ts: number;
  symbol: string;
  type: string;
  sideHint: string;
  severity: number;
  triggerValue: number;
  thresholdValue: number;
  snapshot: any;
  createdAt: Date;
}

@injectable()
export class ForcedEventsRepository {
  constructor(@inject(TOKENS.MONGO_CLIENT) private mongo: MongoDBClient) {}

  private get collection() {
    return this.mongo.getCollection<ForcedEventDoc>('forced_events');
  }

  async save(event: ForcedEvent): Promise<void> {
    await this.collection.updateOne(
      { _id: event.id },
      {
        $set: {
          _id: event.id,
          ts: event.ts,
          symbol: event.symbol,
          type: event.type,
          sideHint: event.sideHint,
          severity: event.severity,
          triggerValue: event.triggerValue,
          thresholdValue: event.thresholdValue,
          snapshot: event.snapshot,
          createdAt: new Date(),
        },
      },
      { upsert: true },
    );
  }

  async findById(id: string): Promise<ForcedEvent | null> {
    const doc = await this.collection.findOne({ _id: id });
    if (!doc) return null;
    return this.mapDocToEvent(doc);
  }

  async findBySymbol(
    symbol: string,
    limit: number = 100,
  ): Promise<ForcedEvent[]> {
    const docs = await this.collection
      .find({ symbol })
      .sort({ ts: -1 })
      .limit(limit)
      .toArray();

    return docs.map(this.mapDocToEvent);
  }

  async findRecent(limit: number = 50): Promise<ForcedEvent[]> {
    const docs = await this.collection
      .find({})
      .sort({ ts: -1 })
      .limit(limit)
      .toArray();

    return docs.map(this.mapDocToEvent);
  }

  async findByDateRange(
    startTs: number,
    endTs: number,
  ): Promise<ForcedEvent[]> {
    const docs = await this.collection
      .find({ ts: { $gte: startTs, $lte: endTs } })
      .sort({ ts: -1 })
      .toArray();

    return docs.map(this.mapDocToEvent);
  }

  async countByType(type: string, sinceTs: number): Promise<number> {
    return this.collection.countDocuments({
      type,
      ts: { $gte: sinceTs },
    });
  }

  private mapDocToEvent(doc: ForcedEventDoc): ForcedEvent {
    return {
      id: doc._id,
      ts: doc.ts,
      symbol: doc.symbol,
      type: doc.type as any,
      sideHint: doc.sideHint as any,
      severity: doc.severity,
      triggerValue: doc.triggerValue,
      thresholdValue: doc.thresholdValue,
      snapshot: doc.snapshot,
      cooldownUntil: 0,
    };
  }
}
