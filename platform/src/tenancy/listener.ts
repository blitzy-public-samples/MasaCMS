import type pg from 'pg';

/** Callbacks of a notification listener. */
export interface NotificationHandlers {
  /** Receives the payload of each notification sent on the channel. */
  onNotification(payload: string): void;
  /** Runs each time the session starts listening; notifications sent while it was not listening are lost. */
  onListening(): void;
  /** Runs when a connection attempt fails or the listening session ends; the listener then reconnects with backoff. */
  onLost(err: Error): void;
}

/** A LISTEN session on its own connection, re-established until closed. */
export interface NotificationListener {
  /** Stops listening and closes the connection; no handler runs once it is called. */
  close(): Promise<void>;
}

const CHANNEL = /^[a-z_][a-z0-9_]*$/;
const MAX_CHANNEL_BYTES = 63;
const FIRST_RETRY_MS = 1000;
const MAX_RETRY_MS = 30_000;

/** Listens on `channel` over clients from `newClient`, reconnecting after 1 s doubling to 30 s; throws TypeError for an invalid channel. */
export function openListener(newClient: () => pg.Client, channel: string, handlers: NotificationHandlers): NotificationListener {
  if (typeof channel !== 'string' || !CHANNEL.test(channel) || channel.length > MAX_CHANNEL_BYTES) {
    throw new TypeError(`Invalid notification channel ${JSON.stringify(channel)}`);
  }
  let closed = false;
  let current: pg.Client | undefined;
  let retry: NodeJS.Timeout | undefined;
  let delayMs = FIRST_RETRY_MS;

  const lose = (client: pg.Client, err: unknown): void => {
    if (current !== client) return;
    current = undefined;
    void client.end().catch(() => undefined);
    handlers.onLost(err instanceof Error ? err : new Error(String(err)));
    // onLost may have closed the listener.
    if (closed) return;
    retry = setTimeout(() => {
      retry = undefined;
      attempt();
    }, delayMs);
    retry.unref();
    delayMs = Math.min(delayMs * 2, MAX_RETRY_MS);
  };

  const attempt = (): void => {
    const client = newClient();
    current = client;
    client.on('error', (err) => lose(client, err));
    client.on('end', () => lose(client, new Error('Notification listener connection ended')));
    client.on('notification', (message) => {
      if (current === client && message.channel === channel) handlers.onNotification(message.payload ?? '');
    });
    client
      .connect()
      .then(() => client.query(`LISTEN "${channel}"`))
      .then(() => {
        if (current !== client) return;
        delayMs = FIRST_RETRY_MS;
        handlers.onListening();
      })
      .catch((err: unknown) => lose(client, err));
  };

  attempt();
  return {
    close: async () => {
      closed = true;
      clearTimeout(retry);
      const client = current;
      current = undefined;
      await client?.end();
    },
  };
}
