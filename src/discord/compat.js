export const DISCORD_CLIENT_READY_EVENT = 'clientReady';

export function onDiscordClientReady(client, handler) {
  client.once(DISCORD_CLIENT_READY_EVENT, handler);
}

export async function waitForDiscordClientReady(client) {
  if (typeof client?.isReady === 'function' && client.isReady()) {
    return;
  }

  await new Promise(resolve => {
    onDiscordClientReady(client, resolve);
  });
}
