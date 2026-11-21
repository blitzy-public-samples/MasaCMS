// Time bounds of the Cloud Storage adapter: each wait owns the node:http requests made in its async context and cancels them on expiry.
import { AsyncLocalStorage } from 'node:async_hooks';
import { subscribe } from 'node:diagnostics_channel';
import type { ClientRequest } from 'node:http';
import { Readable, Writable } from 'node:stream';
import { untilAborted } from '../auth/deadline.js';
import { StorageTimeoutError } from './port.js';

/** Operation, object and budget of one wait on Cloud Storage. */
export interface StorageWaitTarget {
  operation: StorageTimeoutError['operation'];
  bucket: string;
  key: string;
  timeoutMs: number;
}

const currentWait = new AsyncLocalStorage<StorageWait | undefined>();

subscribe('http.client.request.created', (message) => {
  currentWait.getStore()?.track((message as { request: ClientRequest }).request);
});

/** Runs `fn` outside every wait, so caller code it reaches never makes requests a wait owns. */
function outsideWaits<T>(fn: () => T): T {
  return currentWait.run(undefined, fn);
}

/** A restartable timer over one operation; on expiry it aborts its signal and destroys its open requests and registered streams. */
class StorageWait {
  private readonly controller = new AbortController();
  private readonly requests = new Set<ClientRequest>();
  private readonly streams = new Set<Readable | Writable>();
  private timer: NodeJS.Timeout | undefined;
  private settled = false;

  constructor(private readonly target: StorageWaitTarget) {}

  /** Aborts with the StorageTimeoutError once the wait expires. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Starts the timer unless it is running, has expired, or the wait is settled. */
  arm(): void {
    if (this.timer !== undefined || this.settled || this.signal.aborted) return;
    this.timer = setTimeout(() => this.expire(), this.target.timeoutMs);
  }

  /** Stops the timer. */
  disarm(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Runs `fn` with this wait owning the requests it makes. */
  run<T>(fn: () => T): T {
    return currentWait.run(this, fn);
  }

  /** Ends the wait without cancelling anything; later requests from its context are not tracked unless it expired. */
  settle(): void {
    this.disarm();
    this.settled = true;
    this.requests.clear();
    this.streams.clear();
  }

  /** Settles the wait and destroys the requests it still owns. */
  cancel(): void {
    const open = [...this.requests];
    this.settle();
    for (const request of open) request.destroy();
  }

  /** Owns `request` until it closes; destroys it at once when the wait has expired. */
  track(request: ClientRequest): void {
    if (this.signal.aborted) {
      request.destroy(this.signal.reason as Error);
      return;
    }
    if (this.settled) return;
    this.requests.add(request);
    request.once('close', () => this.requests.delete(request));
  }

  /** Destroys `stream` with the StorageTimeoutError on expiry. */
  register(stream: Readable | Writable): void {
    this.streams.add(stream);
  }

  private expire(): void {
    this.timer = undefined;
    const { operation, bucket, key, timeoutMs } = this.target;
    const reason = new StorageTimeoutError(operation, bucket, key, timeoutMs);
    this.controller.abort(reason);
    for (const request of [...this.requests]) request.destroy(reason);
    for (const stream of [...this.streams]) stream.destroy(reason);
  }
}

/** Settles as `work` does; rejects with StorageTimeoutError, cancelling its requests, once it runs `target.timeoutMs` unanswered. */
export async function withinStorageDeadline<T>(target: StorageWaitTarget, work: () => Promise<T>): Promise<T> {
  const wait = new StorageWait(target);
  wait.arm();
  try {
    return await untilAborted(wait.run(work), wait.signal);
  } finally {
    wait.settle();
  }
}

/** Readable over `source`, attached on its first read, failing with StorageTimeoutError when the next chunk takes `target.timeoutMs` while its consumer waits. */
export function boundedReadStream(target: StorageWaitTarget, source: Readable): Readable {
  const wait = new StorageWait(target);
  let attached = false;
  const body = new Readable({
    read() {
      if (!attached) {
        attached = true;
        wait.run(() => source.on('data', onData));
      } else if (source.isPaused()) {
        wait.run(() => source.resume());
      }
      wait.arm();
    },
    destroy(error, callback) {
      wait.cancel();
      source.destroy();
      callback(error);
    },
  });
  const onData = (chunk: Buffer): void => {
    wait.disarm();
    if (!outsideWaits(() => body.push(chunk))) source.pause();
  };
  source.once('end', () => {
    wait.settle();
    outsideWaits(() => body.push(null));
  });
  source.on('error', (error: Error) => {
    wait.disarm();
    outsideWaits(() => body.destroy(error));
  });
  wait.register(body);
  return body;
}

/** Writable into `sink` that fails with StorageTimeoutError when a write, or the upload's answer after `end`, takes `target.timeoutMs`. */
export function boundedWriteStream(target: StorageWaitTarget, sink: Writable): Writable {
  const wait = new StorageWait(target);
  const bounded = new Writable({
    write(chunk: Buffer, encoding, callback) {
      wait.arm();
      wait.run(() =>
        sink.write(chunk, encoding, (error) => {
          wait.disarm();
          outsideWaits(() => callback(error));
        }),
      );
    },
    final(callback) {
      wait.arm();
      sink.once('finish', () => {
        wait.settle();
        outsideWaits(() => callback());
      });
      wait.run(() => sink.end());
    },
    destroy(error, callback) {
      wait.cancel();
      sink.destroy(error ?? undefined);
      callback(error);
    },
  });
  sink.on('error', (error: Error) => {
    outsideWaits(() => bounded.destroy(error));
  });
  wait.register(bounded);
  return bounded;
}
