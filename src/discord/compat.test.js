import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  DISCORD_CLIENT_READY_EVENT,
  onDiscordClientReady,
  waitForDiscordClientReady,
} from './compat.js';

class MockDiscordClient extends EventEmitter {
  constructor(isInitiallyReady = false) {
    super();
    this.ready = isInitiallyReady;
  }

  isReady() {
    return this.ready;
  }

  markReady() {
    this.ready = true;
    this.emit(DISCORD_CLIENT_READY_EVENT);
  }
}

test('onDiscordClientReady listens once on clientReady', () => {
  const client = new MockDiscordClient(false);
  let callCount = 0;

  onDiscordClientReady(client, () => {
    callCount += 1;
  });

  client.markReady();
  client.markReady();

  assert.equal(callCount, 1);
});

test('waitForDiscordClientReady resolves immediately when already ready', async () => {
  const client = new MockDiscordClient(true);

  await assert.doesNotReject(async () => {
    await Promise.race([
      waitForDiscordClientReady(client),
      new Promise((_, reject) => setTimeout(() => reject(new Error('wait timed out')), 25)),
    ]);
  });
});

test('waitForDiscordClientReady resolves after clientReady event', async () => {
  const client = new MockDiscordClient(false);

  const waitPromise = waitForDiscordClientReady(client);
  setTimeout(() => client.markReady(), 10);

  await assert.doesNotReject(waitPromise);
});
