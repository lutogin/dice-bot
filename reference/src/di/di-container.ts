import { container } from 'tsyringe';
import { ConfigService } from '../config';
import { App } from '../app';
import { SchedulerService } from '../infra/scheduler/scheduler';
import { EventBus } from '../infra/event-bus/event-bus';
import { Logger } from '../infra/logger/logger';
import { TelegramService } from '../integrations/telegram';
import { MongoClient } from '../integrations/database/mongo-client';
import { TOKENS } from './tokens';
import { CommunicatorService, ICommunicatorService } from 'domain/communicator';
import { LpPositionService, ILpPositionService } from 'domain/lp-position';
import { HedgeService, IHedgeService } from 'domain/hedge';
import { StrategyEngine, IStrategyEngine } from 'domain/strategy';
import { ExecutionOrchestrator, IExecutionOrchestrator } from 'domain/execution';
import { RiskManager, IRiskManager } from 'domain/risk';
import { PriceService, IPriceService } from 'domain/price';
import { MonitoringService, IMonitoringService } from 'domain/monitoring';
import { TxPolicyService, ITxPolicyService } from 'domain/tx-policy';
import { WalletService, IWalletService } from 'domain/wallet';
import { LedgerService, ILedgerService } from 'domain/ledger';
import { StateStore, IStateStore } from 'domain/state-store';
import { RangeModelService, IRangeModelService } from 'domain/range-model';
import { DynamicThresholdService, IDynamicThresholdService } from 'domain/dynamic-threshold';
import { RehedgeDecisionService, IRehedgeDecisionService } from 'domain/rehedge-decision';
import { OperationStateRepository } from '../integrations/database/repositories/operation-state.repository';
import { BinanceClient } from '../integrations/exchanges/clients/binance/binance';

export class DIContainer {
  private static instance: DIContainer;
  private isConfigured = false;

  private constructor() {}

  public static getInstance(): DIContainer {
    if (!DIContainer.instance) {
      DIContainer.instance = new DIContainer();
    }
    return DIContainer.instance;
  }

  public configure(): void {
    if (this.isConfigured) {
      return;
    }

    // Register core domain with tokens
    container.registerSingleton<ConfigService>(TOKENS.CONFIG_SERVICE, ConfigService);
    container.registerSingleton<Logger>(TOKENS.LOGGER, Logger);
    container.registerSingleton<EventBus>(TOKENS.EVENT_BUS, EventBus);

    // Register telegram service
    container.registerSingleton<TelegramService>(TOKENS.TELEGRAM_SERVICE, TelegramService);

    // Register communicator service
    container.registerSingleton<ICommunicatorService>(
      TOKENS.COMMUNICATOR_SERVICE,
      CommunicatorService
    );

    // Register LP position service (Uniswap v3)
    container.registerSingleton<ILpPositionService>(
      TOKENS.LP_POSITION_SERVICE,
      LpPositionService
    );

    // Register Binance client (CEX API)
    container.registerSingleton<BinanceClient>(
      TOKENS.BINANCE_CLIENT,
      BinanceClient
    );

    // Register hedge service (CEX Perps)
    container.registerSingleton<IHedgeService>(
      TOKENS.HEDGE_SERVICE,
      HedgeService
    );

    // Register strategy engine
    container.registerSingleton<IStrategyEngine>(
      TOKENS.STRATEGY_ENGINE,
      StrategyEngine
    );

    // Register execution orchestrator
    container.registerSingleton<IExecutionOrchestrator>(
      TOKENS.EXECUTION_ORCHESTRATOR,
      ExecutionOrchestrator
    );

    // Register risk manager
    container.registerSingleton<IRiskManager>(
      TOKENS.RISK_MANAGER,
      RiskManager
    );

    // Register price service
    container.registerSingleton<IPriceService>(
      TOKENS.PRICE_SERVICE,
      PriceService
    );

    // Register monitoring service
    container.registerSingleton<IMonitoringService>(
      TOKENS.MONITORING_SERVICE,
      MonitoringService
    );

    // Register transaction policy service
    container.registerSingleton<ITxPolicyService>(
      TOKENS.TX_POLICY_SERVICE,
      TxPolicyService
    );

    // Register wallet service
    container.registerSingleton<IWalletService>(
      TOKENS.WALLET_SERVICE,
      WalletService
    );

    // Register ledger service
    container.registerSingleton<ILedgerService>(
      TOKENS.LEDGER_SERVICE,
      LedgerService
    );

    // Register database services
    container.registerSingleton<MongoClient>(TOKENS.MONGO_CLIENT, MongoClient);

    // Register state store repository
    container.registerSingleton<OperationStateRepository>(
      TOKENS.STATE_STORE_REPOSITORY,
      OperationStateRepository
    );

    // Register state store
    container.registerSingleton<IStateStore>(
      TOKENS.STATE_STORE,
      StateStore
    );

    // Register range model service
    container.registerSingleton<IRangeModelService>(
      TOKENS.RANGE_MODEL_SERVICE,
      RangeModelService
    );

    // Register dynamic threshold service
    container.registerSingleton<IDynamicThresholdService>(
      TOKENS.DYNAMIC_THRESHOLD_SERVICE,
      DynamicThresholdService
    );

    // Register rehedge decision service
    container.registerSingleton<IRehedgeDecisionService>(
      TOKENS.REHEDGE_DECISION_SERVICE,
      RehedgeDecisionService
    );

    container.registerSingleton<SchedulerService>(TOKENS.SCHEDULER_SERVICE, SchedulerService);

    // Register application as singleton
    container.registerSingleton(App);

    this.isConfigured = true;
  }

  public getContainer(): typeof container {
    if (!this.isConfigured) {
      this.configure();
    }
    return container;
  }

  public resolve<T>(token: new (...args: any[]) => T): T {
    return this.getContainer().resolve<T>(token);
  }
}

export const diContainer = DIContainer.getInstance();
