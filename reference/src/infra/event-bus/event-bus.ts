import EventEmitter from 'eventemitter3';
import { injectable } from 'tsyringe';
import { EventData, EventName } from './event-bus.types';

@injectable()
export class EventBus {
  private readonly eventBus: EventEmitter<string | symbol, any>;

  constructor() {
    this.eventBus = new EventEmitter();
  }
  public get emitter(): EventEmitter<string | symbol, any> {
    return this.eventBus;
  }

  public emit<T extends EventName>(eventName: T, data: EventData<T>): void {
    this.eventBus.emit(eventName, data);
  }

  public on<T extends EventName>(eventName: T, listener: (data: EventData<T>) => void): void {
    this.eventBus.on(eventName, listener);
  }

  public off<T extends EventName>(eventName: T, listener: (data: EventData<T>) => void): void {
    this.eventBus.off(eventName, listener);
  }

  public removeAllListeners(eventName?: EventName): void {
    this.eventBus.removeAllListeners(eventName);
  }
}
