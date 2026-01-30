/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { TOKENS } from '../../di/tokens';
import { EventBus } from './event-bus';
import { container } from 'tsyringe';
import { EventName } from './event-bus.types';

export const EVENT_HANDLER_METADATA = Symbol('EVENT_HANDLER_METADATA');

export function EventHandler(eventName: EventName) {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const existingHandlers = Reflect.getMetadata(EVENT_HANDLER_METADATA, target.constructor) || [];

    existingHandlers.push({
      eventName,
      methodName: propertyKey,
      handler: descriptor.value,
    });

    Reflect.defineMetadata(EVENT_HANDLER_METADATA, existingHandlers, target.constructor);
  };
}

export function setupEventHandlers(instance: any) {
  const eventBus = container.resolve<EventBus>(TOKENS.EVENT_BUS);
  const handlers = Reflect.getMetadata(EVENT_HANDLER_METADATA, instance.constructor) || [];

  handlers.forEach(({ eventName, methodName }: any) => {
    const boundMethod = instance[methodName].bind(instance);
    // Оборачиваем обработчик, чтобы добавить eventName в данные
    eventBus.on(eventName, (data: any) => {
      // Добавляем eventName в данные события
      const enrichedData = {
        ...data,
        _eventName: eventName, // Префикс _ чтобы не конфликтовать с пользовательскими полями
      };
      boundMethod(enrichedData);
    });
  });
}

// export function setupEventHandlers(instance: any) {
//   console.log(`🔍 Setting up event handlers for ${instance.constructor.name}`); // ОТЛАДКА

//   const eventBus = container.resolve<EventBus>(TOKENS.EVENT_BUS);
//   const handlers = Reflect.getMetadata(EVENT_HANDLER_METADATA, instance.constructor) || [];

//   console.log(
//     `📡 Found ${handlers.length} handlers:`,
//     handlers.map((h: any) => `${h.eventName} -> ${h.methodName}`)
//   ); // ОТЛАДКА

//   handlers.forEach(({ eventName, methodName }: any) => {
//     console.log(`📡 Registering handler: ${eventName} -> ${methodName}`); // ОТЛАДКА

//     const boundMethod = instance[methodName].bind(instance);
//     eventBus.on(eventName, (data: any) => {
//       console.log(
//         `🎯 Event received: ${eventName} by ${instance.constructor.name}.${methodName}`,
//         data
//       ); // ОТЛАДКА
//       boundMethod(data);
//     });
//   });
// }
