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
    @inject(TOKENS.LOGGER) logger: Logger
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

    // Останавливаем все задачи
    this.jobs.forEach((task, name) => {
      if (task) {
        task.destroy();
        this.logger.debug(`Stopped scheduled task: ${name}`);
      }
    });

    this.jobs.clear();
    this.isRunning = false;
  }

  /**
   * Добавляет новую задачу в планировщик через события
   */
  public scheduleEventJob(
    name: string,
    cronExpression: string,
    eventName: EventName,
    eventData: any = {},
    options?: { timezone?: string }
  ): void {
    if (this.jobs.has(name)) {
      this.logger.warn(`Job ${name} already exists, stopping the old one`);
      this.jobs.get(name)?.destroy();
    }

    const job = cron.schedule(
      cronExpression,
      () => {
        try {
          this.logger.debug(`Triggering scheduled event: ${eventName} for job: ${name}`);

          this.eventBus.emit(eventName, {
            ...eventData,
            timestamp: dayjs().utc().valueOf(),
            source: 'scheduled',
            jobName: name,
          });
        } catch (error) {
          this.logger.error(
            `Error triggering scheduled event ${eventName} for job ${name}`,
            error as Error
          );
        }
      },
      {
        timezone: options?.timezone || 'UTC',
      }
    );

    this.jobs.set(name, job);

    this.logger.info(
      `📅 Scheduled event job '${name}' -> '${eventName}' with expression: ${cronExpression} (ready to start)`
    );
  }

  /**
   * Добавляет новую задачу в планировщик с функцией
   */
  public scheduleJob<T>(
    name: string,
    cronExpression: string,
    task: () => Promise<T>,
    options?: { timezone?: string }
  ): void {
    if (this.jobs.has(name)) {
      this.logger.warn(`Job ${name} already exists, stopping the old one`);
      this.jobs.get(name)?.destroy();
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
      }
    );

    this.jobs.set(name, job);

    this.logger.info(
      `📅 Scheduled job '${name}' with expression: ${cronExpression} (ready to start)`
    );
  }

  /**
   * Запускает конкретную задачу
   */
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

  /**
   * Останавливает конкретную задачу
   */
  public stopJob(name: string): boolean {
    const job = this.jobs.get(name);
    if (job) {
      job.stop();
      this.logger.debug(`Stopped job: ${name}`);
      return true;
    }
    return false;
  }

  /**
   * Удаляет задачу полностью
   */
  public removeJob(name: string): boolean {
    const job = this.jobs.get(name);
    if (job) {
      job.destroy();
      this.jobs.delete(name);
      this.logger.info(`Removed job: ${name}`);
      return true;
    }
    return false;
  }

  /**
   * Получает список всех задач
   */
  public getAllJobs(): string[] {
    return Array.from(this.jobs.keys());
  }

  /**
   * Получает список активных задач
   */
  public async getActiveJobs(): Promise<string[]> {
    const activeJobs: string[] = [];
    for (const [name, job] of this.jobs.entries()) {
      const status = await job.getStatus();
      if (status === 'scheduled') {
        activeJobs.push(name);
      }
    }
    return activeJobs;
  }

  /**
   * Проверяет, существует ли задача
   */
  public hasJob(name: string): boolean {
    return this.jobs.has(name);
  }

  /**
   * Получает статус задачи
   */
  public async getJobStatus(name: string): Promise<string | null> {
    const job = this.jobs.get(name);
    return job ? await job.getStatus() : null;
  }
}
