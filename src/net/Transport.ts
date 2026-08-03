// The transport seam.
//
// §5 of the decision record builds this interface now and one disposable
// WebSocket implementation behind it, so the session framework question stays
// open. Colyseus, WebTransport or a custom room loop all have to fit through
// these four methods; nothing above this file may know which one is in use.
//
// Deliberately byte oriented. Framing, ordering and reliability are the
// implementation's problem, and the codec above decides what the bytes mean.

export type TransportMessageHandler = (bytes: Uint8Array) => void;

/** The client half: one connection to one server. */
export interface ClientTransport {
  send(bytes: Uint8Array): void;
  onMessage(handler: TransportMessageHandler): void;
  onClose(handler: () => void): void;
  close(): void;
  readonly connected: boolean;
}

/** One connected peer, from the server's side. */
export interface ServerConnection {
  readonly id: number;
  send(bytes: Uint8Array): void;
  close(): void;
}

/** The server half: accepts connections and hands them over. */
export interface ServerTransport {
  onConnection(handler: (connection: ServerConnection) => void): void;
  onMessage(handler: (connection: ServerConnection, bytes: Uint8Array) => void): void;
  onDisconnection(handler: (connection: ServerConnection) => void): void;
  close(): Promise<void>;
}
