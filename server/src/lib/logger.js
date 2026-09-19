/** Tiny leveled logger with timestamps. Avoids a dependency for something this small. */
import config from '../config.js';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const activeLevel = LEVELS[(process.env.LOG_LEVEL || (config.isProd ? 'info' : 'debug')).toLowerCase()] ?? 2;

const colors = { error: '\x1b[31m', warn: '\x1b[33m', info: '\x1b[36m', debug: '\x1b[90m' };
const reset = '\x1b[0m';

function log(level, scope, args) {
  if (LEVELS[level] > activeLevel) return;
  const ts = new Date().toISOString().slice(11, 23);
  const prefix = `${colors[level]}${ts} ${level.toUpperCase().padEnd(5)} [${scope}]${reset}`;
  // eslint-disable-next-line no-console
  console[level === 'debug' ? 'log' : level](prefix, ...args);
}

export function createLogger(scope = 'app') {
  return {
    error: (...a) => log('error', scope, a),
    warn: (...a) => log('warn', scope, a),
    info: (...a) => log('info', scope, a),
    debug: (...a) => log('debug', scope, a),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}

export const logger = createLogger();
export default logger;
