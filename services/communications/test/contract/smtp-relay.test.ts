// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** SMTP contract of the mail transport: its 10 s timeout against a loopback relay that accepts and never greets. */
import { type AddressInfo, type Server, type Socket, createServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSmtpTransport } from '../../src/domain/mail-transport.js';

const sockets = new Set<Socket>();
let relay: Server;

beforeAll(async () => {
  relay = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
});

afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => relay.close(() => resolve()));
});

describe('createSmtpTransport against a relay that accepts and never greets', () => {
  it('rejects the send once the 10 s SMTP timeout passes', async () => {
    const transport = createSmtpTransport({ host: '127.0.0.1', port: (relay.address() as AddressInfo).port });
    const started = performance.now();

    const failure = await transport
      .send({
        to: 'silent@example.com',
        from: { name: 'Masa', address: 'noreply@opt2.local' },
        subject: 'Stalled',
        text: 'Body',
        messageId: 'A1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6',
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    const elapsed = performance.now() - started;
    await transport.close();

    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({ code: 'ETIMEDOUT' });
    expect(elapsed).toBeGreaterThanOrEqual(9_900);
    expect(elapsed).toBeLessThan(15_000);
  });
});
