/**
 * In-process event bus used to push real-time updates (upload progress, job
 * state, new files) to browsers over Server-Sent Events.
 */
import { EventEmitter } from 'node:events';
import { createLogger } from './logger.js';

const log = createLogger('events');

class Bus extends EventEmitter {
  emitScoped(scope, event, payload) {
    this.emit(`${scope}:${event}`, payload);
    this.emit('*', { scope, event, payload, at: Date.now() });
  }
}

export const bus = new Bus();
bus.setMaxListeners(0);

/** Per-user helper: bus.user(userId).emit('file:progress', {...}) */
export function userBus(userId) {
  const scope = `user:${userId}`;
  return {
    emit: (event, payload) => bus.emitScoped(scope, event, payload),
    on: (event, handler) => bus.on(`${scope}:${event}`, handler),
    off: (event, handler) => bus.off(`${scope}:${event}`, handler),
  };
}

/** Global (server-wide) events, e.g. storage backend health. */
export const systemBus = {
  emit: (event, payload) => bus.emitScoped('system', event, payload),
};

export function logEvent(...args) {
  log.debug(...args);
}

export default bus;
