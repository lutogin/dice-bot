/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { TOKENS } from '../../di/tokens';
import { EventBus } from './event-bus';
import { container } from 'tsyringe';
import { EventName } from './event-bus.types';

export const EVENT_HANDLER_METADATA = Symbol('EVENT_HANDLER_METADATA');

export function EventHandler(eventName: EventName) {
  return function (
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor,
  ) {
    const existingHandlers =
      Reflect.getMetadata(EVENT_HANDLER_METADATA, target.constructor) || [];

    existingHandlers.push({
      eventName,
      methodName: propertyKey,
      handler: descriptor.value,
    });

    Reflect.defineMetadata(
      EVENT_HANDLER_METADATA,
      existingHandlers,
      target.constructor,
    );
  };
}

export function setupEventHandlers(instance: any) {
  const eventBus = container.resolve<EventBus>(TOKENS.EVENT_BUS);
  const handlers =
    Reflect.getMetadata(EVENT_HANDLER_METADATA, instance.constructor) || [];

  handlers.forEach(({ eventName, methodName }: any) => {
    const boundMethod = instance[methodName].bind(instance);
    eventBus.on(eventName, (data: any) => {
      const enrichedData = {
        ...data,
        _eventName: eventName,
      };
      boundMethod(enrichedData);
    });
  });
}
