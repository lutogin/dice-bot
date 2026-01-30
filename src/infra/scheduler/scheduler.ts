import { injectable, inject } from 'tsyringe';
import * as cron from 'node-cron';
import { ScheduledTask } from 'node-cron';

import { Logger, ILogger } from '../logger/logger';
import { EventBus } from '../event-bus/event-bus';
import { TOKENS } from '../../di/tokens';
import { EventName } from '../event-bus/event-bus.types';
import dayjs from 'dayjs';

@injectable()
export class SchedulerService {
  private jobs: Map<string, ScheduledTask> = new Map();
  public isRunning: boolean = false;
  private readonly logger: ILogger;

  constructor(
    @inject(TOKENS.EVENT_BUS) private eventBus: EventBus,
    @inject(TOKENS.LOGGER) logger: Logger,
  ) {
    this.logger = logger.child('Scheduler');
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn(`${SchedulerService.name} is already running`);
      return;
    }

    this.isRunning = true;
    this.logger.info(`🕐 ${SchedulerService.name} started`);
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.logger.info(`Stopping ${SchedulerService.name}`);

    this.jobs.forEach((task, name) => {
      if (task) {
        task.stop();
        this.logger.debug(`Stopped scheduled task: ${name}`);
      }
    });

    this.jobs.clear();
    this.isRunning = false;
  }

  public scheduleEventJob(
    name: string,
    cronExpression: string,
    eventName: EventName,
    eventData: any = {},
    options?: { timezone?: string },
  ): void {
    if (this.jobs.has(name)) {
      this.logger.warn(`Job ${name} already exists, stopping the old one`);
      this.jobs.get(name)?.stop();
    }

    const job = cron.schedule(
      cronExpression,
      () => {
        try {
          this.logger.debug(
            `Triggering scheduled event: ${eventName} for job: ${name}`,
          );

          this.eventBus.emit(eventName, {
            ...eventData,
            timestamp: dayjs().valueOf(),
            source: 'scheduled',
            jobName: name,
          });
        } catch (error) {
          this.logger.error(
            `Error triggering scheduled event ${eventName} for job ${name}`,
            error as Error,
          );
        }
      },
      {
        timezone: options?.timezone || 'UTC',
      },
    );

    this.jobs.set(name, job);

    this.logger.info(
      `📅 Scheduled event job '${name}' -> '${eventName}' with expression: ${cronExpression}`,
    );
  }

  public scheduleJob<T>(
    name: string,
    cronExpression: string,
    task: () => Promise<T>,
    options?: { timezone?: string },
  ): void {
    if (this.jobs.has(name)) {
      this.logger.warn(`Job ${name} already exists, stopping the old one`);
      this.jobs.get(name)?.stop();
    }

    const job = cron.schedule(
      cronExpression,
      async () => {
        try {
          this.logger.debug(`Executing scheduled job: ${name}`);
          await task();
        } catch (error) {
          this.logger.error(`Error in scheduled job ${name}`, error as Error);
        }
      },
      {
        timezone: options?.timezone || 'UTC',
      },
    );

    this.jobs.set(name, job);

    this.logger.info(
      `📅 Scheduled job '${name}' with expression: ${cronExpression}`,
    );
  }

  public startJob(name: string): boolean {
    const job = this.jobs.get(name);
    if (job) {
      job.start();
      this.logger.debug(`Started job: ${name}`);
      return true;
    }
    this.logger.warn(`Job ${name} not found`);
    return false;
  }

  public stopJob(name: string): boolean {
    const job = this.jobs.get(name);
    if (job) {
      job.stop();
      this.logger.debug(`Stopped job: ${name}`);
      return true;
    }
    return false;
  }

  public removeJob(name: string): boolean {
    const job = this.jobs.get(name);
    if (job) {
      job.stop();
      this.jobs.delete(name);
      this.logger.info(`Removed job: ${name}`);
      return true;
    }
    return false;
  }

  public getAllJobs(): string[] {
    return Array.from(this.jobs.keys());
  }

  public hasJob(name: string): boolean {
    return this.jobs.has(name);
  }
}
