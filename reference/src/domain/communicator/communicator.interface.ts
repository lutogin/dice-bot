import { EventData } from 'infra/event-bus/event-bus.types';

/**
 * Interface for communicator service
 */
export interface ICommunicatorService {
  sendErrorMessage(params: EventData<'error'>): Promise<void>;
}
