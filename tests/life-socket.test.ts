import { expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import type { SocketLike } from '../src/net/hub-client';
import { LifeClient, SnapBus } from './life-client';

// The soak's clients ride `ws` with compression off: Node's own `WebSocket` inflates every message on
// the libuv thread pool, and 200 clients heard their fights' frames and ends a minute late (M14 T14g).
it('opens its socket without permessage-deflate, and still hears the hub', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1', perMessageDeflate: true });
  const offered: (string | undefined)[] = [];
  server.on('connection', (ws, req) => {
    offered.push(req.headers['sec-websocket-extensions'] as string | undefined);
    ws.send('{"t":"pong","id":1,"now":0}');
  });
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as { port: number };
  try {
    const client = new LifeClient({
      url: `ws://127.0.0.1:${port}/v1/hub`,
      index: 1,
      bus: new SnapBus(),
      scales: { lifespan: 1, mating: 1 },
      dropEveryMs: 0,
    });
    const socket = (client as unknown as { socket(url: string): SocketLike }).socket(
      `ws://127.0.0.1:${port}/v1/hub`,
    );
    const heard = await new Promise<unknown>((resolve) => {
      socket.onmessage = (ev) => resolve(ev.data);
    });
    expect(heard).toBe('{"t":"pong","id":1,"now":0}');
    expect(offered).toEqual([undefined]);
    socket.close();
  } finally {
    server.close();
  }
});
