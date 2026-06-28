import { Client as NotionClient } from '@notionhq/client';
import config from '../config.js';

const notion = new NotionClient({
  auth: config.notion.apiKey,
  timeoutMs: 30000,
});

const DEFAULT_MAX_RETRIES = 5;
const BASE_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 8000;

// Transient network failures surface as plain fetch errors (no HTTP status), so
// the Notion SDK's built-in retry (which only covers 429/5xx) never kicks in.
// These are safe to retry for idempotent reads.
const RETRYABLE_ERROR_PATTERNS = [
  'premature close',
  'econnreset',
  'etimedout',
  'econnrefused',
  'enotfound',
  'eai_again',
  'socket hang up',
  'network',
  'fetch failed',
  'request to', // node-fetch "request to <url> failed" wrapper
];

function isRetryableNetworkError(error) {
  if (!error) return false;

  const haystack = `${error.code || ''} ${error.message || ''} ${error.cause?.code || ''} ${error.cause?.message || ''}`.toLowerCase();
  return RETRYABLE_ERROR_PATTERNS.some(pattern => haystack.includes(pattern));
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Runs a Notion API call, retrying transient network errors with exponential
 * backoff. Non-network errors (auth, validation, etc.) are thrown immediately.
 */
export async function withNotionRetry(operation, { maxRetries = DEFAULT_MAX_RETRIES, label = 'Notion request' } = {}) {
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (attempt === maxRetries || !isRetryableNetworkError(error)) {
        throw error;
      }

      const backoff = Math.min(BASE_RETRY_DELAY_MS * 2 ** attempt, MAX_RETRY_DELAY_MS);
      console.warn(
        `⚠️  ${label} failed (attempt ${attempt + 1}/${maxRetries + 1}): ${error.message}. Retrying in ${backoff}ms...`
      );
      await delay(backoff);
    }
  }

  throw lastError;
}

export default notion;
