import mongoose, { Schema, Document } from 'mongoose';

/**
 * Operation status enum
 */
export enum OperationStatus {
  STARTED = 'started',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  FAILED = 'failed',
  STUCK = 'stuck',
  ROLLED_BACK = 'rolled_back',
}

/**
 * Operation type enum
 */
export enum OperationType {
  RESET_RANGE = 'reset_range',
  REHEDGE = 'rehedge',
  COLLECT_FEES = 'collect_fees',
  EMERGENCY_EXIT = 'emergency_exit',
  REBALANCE_WALLET = 'rebalance_wallet',
}

/**
 * Step record interface
 */
export interface IStepRecord {
  stepName: string;
  status: 'pending' | 'started' | 'completed' | 'failed';
  startedAt?: Date;
  completedAt?: Date;
  data?: Record<string, any>;
  txHash?: string;
  error?: string;
}

/**
 * Operation state document interface
 */
export interface IOperationState extends Document {
  operationId: string;
  type: OperationType;
  status: OperationStatus;
  data: Record<string, any>;
  steps: IStepRecord[];
  startedAt: Date;
  updatedAt: Date;
  completedAt?: Date;
  error?: string;
  retryCount: number;
  lastHeartbeat: Date;
}

/**
 * Step record schema
 */
const StepRecordSchema = new Schema<IStepRecord>(
  {
    stepName: { type: String, required: true },
    status: {
      type: String,
      enum: ['pending', 'started', 'completed', 'failed'],
      default: 'pending',
    },
    startedAt: { type: Date },
    completedAt: { type: Date },
    data: { type: Schema.Types.Mixed },
    txHash: { type: String },
    error: { type: String },
  },
  { _id: false }
);

/**
 * Operation state schema
 */
const OperationStateSchema = new Schema<IOperationState>(
  {
    operationId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    type: {
      type: String,
      enum: Object.values(OperationType),
      required: true,
    },
    status: {
      type: String,
      enum: Object.values(OperationStatus),
      default: OperationStatus.STARTED,
      index: true,
    },
    data: {
      type: Schema.Types.Mixed,
      default: {},
    },
    steps: {
      type: [StepRecordSchema],
      default: [],
    },
    startedAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
    completedAt: {
      type: Date,
    },
    error: {
      type: String,
    },
    retryCount: {
      type: Number,
      default: 0,
    },
    lastHeartbeat: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: false,
    collection: 'operation_states',
  }
);

// Index for finding stuck operations
OperationStateSchema.index({ status: 1, lastHeartbeat: 1 });

// Index for finding operations by type and status
OperationStateSchema.index({ type: 1, status: 1 });

// Prevent multiple in-flight operations
OperationStateSchema.index(
  { status: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: { $in: [OperationStatus.STARTED, OperationStatus.IN_PROGRESS] },
    },
  }
);

/**
 * Operation state model
 */
export const OperationStateModel = mongoose.model<IOperationState>(
  'OperationState',
  OperationStateSchema
);

// ==================== Global State Schema ====================

/**
 * Global state document interface
 */
export interface IGlobalState {
  stateId: string;
  activeTokenId: string | null;
  activeTokenIdUpdatedAt?: number | null;
  activeTokenIdTxHash?: string | null;
  activeTokenIdSourceOpId?: string | null;
  lastResetAt: number | null;
  resetsCount24h: number;
  resetTimestamps: number[];
  updatedAt: Date;
}

/**
 * Global state schema
 */
const GlobalStateSchema = new Schema<IGlobalState>(
  {
    stateId: { type: String, required: true, unique: true },
    activeTokenId: { type: String, default: null },
    activeTokenIdUpdatedAt: { type: Number, default: null },
    activeTokenIdTxHash: { type: String, default: null },
    activeTokenIdSourceOpId: { type: String, default: null },
    lastResetAt: { type: Number, default: null },
    resetsCount24h: { type: Number, default: 0 },
    resetTimestamps: { type: [Number], default: [] },
    updatedAt: { type: Date, default: Date.now },
  },
  {
    timestamps: false,
    collection: 'global_state',
  }
);

// Index for finding global state
GlobalStateSchema.index({ stateId: 1 }, { unique: true });

/**
 * Global state model
 */
export const GlobalStateModel = mongoose.model<IGlobalState>(
  'GlobalState',
  GlobalStateSchema
);
