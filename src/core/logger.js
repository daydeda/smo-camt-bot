// Lightweight leveled logger. Keeps the project's emoji style for messages but
// gates output by LOG_LEVEL and stamps each line with a level + ISO timestamp.

const LEVELS = ['debug', 'info', 'warn', 'error'];

function resolveLevel(rawLevel) {
  const normalized = typeof rawLevel === 'string' ? rawLevel.trim().toLowerCase() : '';
  return LEVELS.includes(normalized) ? normalized : 'info';
}

const activeLevel = resolveLevel(process.env.LOG_LEVEL);
const activeLevelIndex = LEVELS.indexOf(activeLevel);

function shouldLog(level) {
  return LEVELS.indexOf(level) >= activeLevelIndex;
}

function emit(level, consoleMethod, args) {
  if (!shouldLog(level)) {
    return;
  }

  const prefix = `[${new Date().toISOString()}] ${level.toUpperCase()}`;
  consoleMethod(prefix, ...args);
}

const logger = {
  level: activeLevel,
  debug: (...args) => emit('debug', console.log, args),
  info: (...args) => emit('info', console.log, args),
  warn: (...args) => emit('warn', console.warn, args),
  error: (...args) => emit('error', console.error, args),
};

export default logger;
