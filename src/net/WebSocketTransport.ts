// Browser-side WebSocket transport. Deliberately disposable.
//
// §5 of the decision record: build the interface, then the cheapest real
// implementation behind it, and let the §7 measurements decide the framework.
// Nothing here is meant to survive that decision — it exists so a two-client
// session can run today.
//
// Buffers sends made before the socket opens, because the client starts
// predicting the moment it is constructed and would otherwise lose its opening
// commands.

import type { ClientTransport, TransportMessageHandler } from "./Transport.ts";

export class WebSocketClientTransport implements ClientTransport {
  private readonly socket: WebSocket;
  private readonly pending: Uint8Array[] = [];
  private messageHandler: TransportMessageHandler | null = null;
  private closeHandler: (() => void) | null = null;

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.binaryType = "arraybuffer";

    this.socket.addEventListener("open", () => {
      for (const bytes of this.pending) this.socket.send(bytes);
      this.pending.length = 0;
    });
    this.socket.addEventListener("message", (event: MessageEvent) => {
      if (!(event.data instanceof ArrayBuffer)) return;
      this.messageHandler?.(new Uint8Array(event.data));
    });
    this.socket.addEventListener("close", () => this.closeHandler?.());
  }

  get connected(): boolean {
    return this.socket.readyState === WebSocket.OPEN;
  }

  send(bytes: Uint8Array): void {
    if (this.socket.readyState === WebSocket.CONNECTING) {
      // Only the most recent batch matters: each one already carries the
      // unacknowledged tail, so an older batch is strictly redundant.
      this.pending.length = 0;
      this.pending.push(bytes);
      return;
    }
    if (this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(bytes);
  }

  onMessage(handler: TransportMessageHandler): void {
    this.messageHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  close(): void {
    this.socket.close();
  }
}
