import { DurableObject } from 'cloudflare:workers';

/** The one authority object (ADR 0008). Handles messages only: no timers, no game loop. */
export class Authority extends DurableObject<Env> {
  override fetch(_request: Request): Response {
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  override webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): void {}

  override webSocketClose(ws: WebSocket, code: number, _reason: string): void {
    ws.close(code === 1005 ? 1000 : code);
  }
}
