// Response relay both forwarders share: an exchange settles before its client sees the last byte, and never after an upstream failure.
import { PassThrough, finished, type Readable } from 'node:stream';

/** Relay of `origin` that ends after `onEnd` resolved; destroying it leaves `origin` draining, an origin failure calls `onFail`. */
export function settlingRelay(origin: Readable, onEnd: () => Promise<void>, onFail: (error: Error) => void): PassThrough {
  const relay = new PassThrough();
  // The last byte so far waits for the next chunk, so a Content-Length response completes only after `onEnd`.
  let held: Buffer = Buffer.alloc(0);
  origin.on('data', (chunk: Buffer) => {
    if (relay.destroyed || chunk.length === 0) return;
    const ready = held.length === 0 ? chunk.subarray(0, -1) : Buffer.concat([held, chunk.subarray(0, -1)]);
    held = chunk.subarray(-1);
    if (ready.length > 0 && !relay.write(ready)) origin.pause();
  });
  relay.on('drain', () => origin.resume());
  relay.on('close', () => origin.resume());
  finished(origin, (error) => {
    if (error) {
      onFail(error);
      // Without an error, so a relay nobody reads yet emits none; its readers see a premature close.
      relay.destroy();
      return;
    }
    void onEnd().then(() => {
      if (relay.destroyed) return;
      if (held.length > 0) relay.end(held);
      else relay.end();
    });
  });
  return relay;
}
