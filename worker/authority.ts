import { DurableObject } from 'cloudflare:workers';

/** The one authority object (ADR 0008). Handles messages only: no timers, no game loop. */
export class Authority extends DurableObject<Env> {
  override fetch(): Response {
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  override webSocketMessage(): void {
    // Messages arrive with the hub handlers (M2 T5); until then frames are ignored.
  }

  override webSocketClose(ws: WebSocket, code: number): void {
    // A close frame can't echo the reserved "no status" code 1005.
    ws.close(code === 1005 ? 1000 : code);
  }
}
