import http from 'http';
import config from '../config.js';
import logger from './logger.js';

const healthState = {
  startedAt: new Date().toISOString(),
  lastSyncAt: null,
  lastSyncCardCount: null,
  lastSyncOk: null,
  lastError: null,
};

export function recordSyncSuccess({ cardCount } = {}) {
  healthState.lastSyncAt = new Date().toISOString();
  healthState.lastSyncCardCount = typeof cardCount === 'number' ? cardCount : null;
  healthState.lastSyncOk = true;
  healthState.lastError = null;
}

export function recordSyncFailure(error) {
  healthState.lastSyncAt = new Date().toISOString();
  healthState.lastSyncOk = false;
  healthState.lastError = error?.message || String(error);
}

export function getHealthSnapshot() {
  return {
    status: healthState.lastSyncOk === false ? 'degraded' : 'ok',
    startedAt: healthState.startedAt,
    uptimeSeconds: Math.round(process.uptime()),
    ...healthState,
  };
}

/**
 * Start an HTTP health server when HEALTH_PORT is configured (non-zero).
 * Returns the server instance, or null when disabled.
 */
export function startHealthServer() {
  const port = config.health?.port || 0;
  if (!port) {
    return null;
  }

  const server = http.createServer((req, res) => {
    const snapshot = getHealthSnapshot();
    res.writeHead(snapshot.status === 'ok' ? 200 : 503, {
      'Content-Type': 'application/json',
    });
    res.end(JSON.stringify(snapshot, null, 2));
  });

  server.on('error', error => {
    logger.error(`Health server error: ${error.message}`);
  });

  server.listen(port, () => {
    logger.info(`🩺 Health endpoint listening on port ${port}`);
  });

  return server;
}
