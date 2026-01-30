import { injectable, inject } from 'tsyringe';
import { Logger, ILogger } from '../../../infra/logger/logger';
import { TOKENS } from '../../../di/tokens';
import {
  OperationStateModel,
  GlobalStateModel,
  IOperationState,
  IStepRecord,
  OperationStatus,
  OperationType,
} from '../schemas/operation-state.schema';
import { GlobalState } from '../../../domain/state-store/state-store.types';

/**
 * Create operation input
 */
export interface CreateOperationInput {
  operationId: string;
  type: OperationType;
  data?: Record<string, any>;
  steps?: IStepRecord[];
}

/**
 * Update step input
 */
export interface UpdateStepInput {
  stepName: string;
  status: IStepRecord['status'];
  data?: Record<string, any>;
  txHash?: string;
  error?: string;
}

/**
 * Query options
 */
export interface OperationQueryOptions {
  type?: OperationType;
  status?: OperationStatus | OperationStatus[];
  from?: Date;
  to?: Date;
  limit?: number;
}

/**
 * Operation State Repository
 * Handles CRUD operations for operation state documents
 */
@injectable()
export class OperationStateRepository {
  private readonly logger: ILogger;

  constructor(@inject(TOKENS.LOGGER) logger: Logger) {
    this.logger = logger.child('OperationStateRepository');
  }

  /**
   * Create a new operation
   */
  async create(input: CreateOperationInput): Promise<IOperationState> {
    const now = new Date();

    const operation = new OperationStateModel({
      operationId: input.operationId,
      type: input.type,
      status: OperationStatus.STARTED,
      data: input.data || {},
      steps: input.steps || [],
      startedAt: now,
      updatedAt: now,
      lastHeartbeat: now,
      retryCount: 0,
    });

    await operation.save();

    this.logger.debug('Operation created', {
      operationId: input.operationId,
      type: input.type,
    });

    return operation;
  }

  /**
   * Find operation by ID
   */
  async findById(operationId: string): Promise<IOperationState | null> {
    return OperationStateModel.findOne({ operationId }).exec();
  }

  /**
   * Find in-flight (non-completed) operation
   */
  async findInFlight(): Promise<IOperationState | null> {
    return OperationStateModel.findOne({
      status: {
        $in: [OperationStatus.STARTED, OperationStatus.IN_PROGRESS],
      },
    })
      .sort({ startedAt: -1 })
      .exec();
  }

  /**
   * Find stuck operations (no heartbeat for specified duration)
   */
  async findStuck(heartbeatTimeoutMs: number): Promise<IOperationState[]> {
    const threshold = new Date(Date.now() - heartbeatTimeoutMs);

    return OperationStateModel.find({
      status: { $in: [OperationStatus.STARTED, OperationStatus.IN_PROGRESS] },
      lastHeartbeat: { $lt: threshold },
    }).exec();
  }

  /**
   * Find stuck candidates based on heartbeat timeout
   */
  async findStuckCandidates(heartbeatTimeoutMs: number): Promise<IOperationState[]> {
    return this.findStuck(heartbeatTimeoutMs);
  }

  /**
   * Update operation status
   */
  async updateStatus(
    operationId: string,
    status: OperationStatus,
    error?: string
  ): Promise<IOperationState | null> {
    const now = new Date();

    const update: Record<string, any> = {
      status,
      updatedAt: now,
      lastHeartbeat: now,
    };

    if (
      status === OperationStatus.COMPLETED ||
      status === OperationStatus.FAILED ||
      status === OperationStatus.ROLLED_BACK
    ) {
      update.completedAt = now;
    }

    if (error) {
      update.error = error;
    }

    const operation = await OperationStateModel.findOneAndUpdate(
      { operationId },
      { $set: update },
      { new: true }
    ).exec();

    if (operation) {
      this.logger.debug('Operation status updated', {
        operationId,
        status,
      });
    }

    return operation;
  }

  /**
   * Update step in operation
   */
  async updateStep(
    operationId: string,
    input: UpdateStepInput
  ): Promise<IOperationState | null> {
    const now = new Date();
    const operation = await this.findById(operationId);

    if (!operation) {
      return null;
    }

    // Find existing step or create new one
    const existingStepIndex = operation.steps.findIndex(
      s => s.stepName === input.stepName
    );

    if (existingStepIndex >= 0) {
      // Update existing step
      const step = operation.steps[existingStepIndex];
      step.status = input.status;

      if (input.status === 'started') {
        step.startedAt = now;
      }
      if (input.status === 'completed' || input.status === 'failed') {
        step.completedAt = now;
      }
      if (input.data) {
        step.data = { ...step.data, ...input.data };
      }
      if (input.txHash) {
        step.txHash = input.txHash;
      }
      if (input.error) {
        step.error = input.error;
      }
    } else {
      // Add new step
      const newStep: IStepRecord = {
        stepName: input.stepName,
        status: input.status,
        startedAt: input.status === 'started' ? now : undefined,
        completedAt:
          input.status === 'completed' || input.status === 'failed'
            ? now
            : undefined,
        data: input.data,
        txHash: input.txHash,
        error: input.error,
      };
      operation.steps.push(newStep);
    }

    // Update operation
    operation.updatedAt = now;
    operation.lastHeartbeat = now;

    // If first step started, mark operation as in_progress
    if (
      input.status === 'started' &&
      operation.status === OperationStatus.STARTED
    ) {
      operation.status = OperationStatus.IN_PROGRESS;
    }

    await operation.save();

    this.logger.debug('Step updated', {
      operationId,
      stepName: input.stepName,
      status: input.status,
    });

    return operation;
  }

  /**
   * Update heartbeat
   */
  async updateHeartbeat(operationId: string): Promise<void> {
    await OperationStateModel.updateOne(
      { operationId },
      {
        $set: {
          lastHeartbeat: new Date(),
          updatedAt: new Date(),
        },
      }
    ).exec();
  }

  /**
   * Increment retry count
   */
  async incrementRetry(operationId: string): Promise<number> {
    const operation = await OperationStateModel.findOneAndUpdate(
      { operationId },
      {
        $inc: { retryCount: 1 },
        $set: { updatedAt: new Date(), lastHeartbeat: new Date() },
      },
      { new: true }
    ).exec();

    return operation?.retryCount || 0;
  }

  /**
   * Update operation data
   */
  async updateData(
    operationId: string,
    dataPatch: Record<string, any>
  ): Promise<IOperationState | null> {
    const operation = await this.findById(operationId);

    if (!operation) {
      return null;
    }

    operation.data = { ...operation.data, ...dataPatch };
    operation.updatedAt = new Date();
    operation.lastHeartbeat = new Date();

    await operation.save();

    return operation;
  }

  /**
   * Find operations by query
   */
  async find(options: OperationQueryOptions): Promise<IOperationState[]> {
    const query: Record<string, any> = {};

    if (options.type) {
      query.type = options.type;
    }

    if (options.status) {
      query.status = Array.isArray(options.status)
        ? { $in: options.status }
        : options.status;
    }

    if (options.from || options.to) {
      query.startedAt = {};
      if (options.from) {
        query.startedAt.$gte = options.from;
      }
      if (options.to) {
        query.startedAt.$lte = options.to;
      }
    }

    let queryBuilder = OperationStateModel.find(query).sort({ startedAt: -1 });

    if (options.limit) {
      queryBuilder = queryBuilder.limit(options.limit);
    }

    return queryBuilder.exec();
  }

  /**
   * Mark stuck operations
   */
  async markStuck(heartbeatTimeoutMs: number): Promise<number> {
    const threshold = new Date(Date.now() - heartbeatTimeoutMs);

    const result = await OperationStateModel.updateMany(
      {
        status: { $in: [OperationStatus.STARTED, OperationStatus.IN_PROGRESS] },
        lastHeartbeat: { $lt: threshold },
      },
      {
        $set: {
          status: OperationStatus.STUCK,
          updatedAt: new Date(),
        },
      }
    ).exec();

    if (result.modifiedCount > 0) {
      this.logger.warn('Marked stuck operations', {
        count: result.modifiedCount,
      });
    }

    return result.modifiedCount;
  }

  /**
   * Mark specific operations as stuck
   */
  async markStuckByIds(operationIds: string[]): Promise<number> {
    if (operationIds.length === 0) return 0;

    const result = await OperationStateModel.updateMany(
      {
        operationId: { $in: operationIds },
        status: { $in: [OperationStatus.STARTED, OperationStatus.IN_PROGRESS] },
      },
      {
        $set: {
          status: OperationStatus.STUCK,
          updatedAt: new Date(),
        },
      }
    ).exec();

    if (result.modifiedCount > 0) {
      this.logger.warn('Marked stuck operations', {
        count: result.modifiedCount,
      });
    }

    return result.modifiedCount;
  }

  /**
   * Delete old completed operations
   */
  async deleteOldCompleted(olderThanDays: number): Promise<number> {
    const threshold = new Date();
    threshold.setDate(threshold.getDate() - olderThanDays);

    const result = await OperationStateModel.deleteMany({
      status: {
        $in: [
          OperationStatus.COMPLETED,
          OperationStatus.FAILED,
          OperationStatus.ROLLED_BACK,
        ],
      },
      completedAt: { $lt: threshold },
    }).exec();

    if (result.deletedCount > 0) {
      this.logger.info('Deleted old operations', {
        count: result.deletedCount,
      });
    }

    return result.deletedCount;
  }

  // ==================== Global State ====================

  private static readonly GLOBAL_STATE_ID = 'global_state';

  /**
   * Upsert global state
   */
  async upsertGlobalState(state: GlobalState): Promise<void> {
    await GlobalStateModel.findOneAndUpdate(
      { stateId: OperationStateRepository.GLOBAL_STATE_ID },
      {
        $set: {
          stateId: OperationStateRepository.GLOBAL_STATE_ID,
          activeTokenId: state.activeTokenId,
          activeTokenIdUpdatedAt: state.activeTokenIdUpdatedAt ?? null,
          activeTokenIdTxHash: state.activeTokenIdTxHash ?? null,
          activeTokenIdSourceOpId: state.activeTokenIdSourceOpId ?? null,
          lastResetAt: state.lastResetAt,
          resetsCount24h: state.resetsCount24h,
          resetTimestamps: state.resetTimestamps,
          updatedAt: new Date(),
        },
      },
      { upsert: true }
    ).exec();
  }

  /**
   * Get global state
   */
  async getGlobalState(): Promise<GlobalState | null> {
    const doc = await GlobalStateModel.findOne({
      stateId: OperationStateRepository.GLOBAL_STATE_ID,
    }).exec();

    if (!doc) {
      return null;
    }

    return {
      activeTokenId: doc.activeTokenId,
      activeTokenIdUpdatedAt: doc.activeTokenIdUpdatedAt ?? null,
      activeTokenIdTxHash: doc.activeTokenIdTxHash ?? null,
      activeTokenIdSourceOpId: doc.activeTokenIdSourceOpId ?? null,
      lastResetAt: doc.lastResetAt,
      resetsCount24h: doc.resetsCount24h,
      resetTimestamps: doc.resetTimestamps,
    };
  }
}
