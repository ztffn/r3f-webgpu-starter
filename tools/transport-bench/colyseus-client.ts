// Colyseus SDK half of the bench load client: joins the bench room and drives
// it with the same scripted command bytes the ws client sends, over the same
// raw-bytes message types the room registers. Joins are staggered because 64
// simultaneous joinOrCreate calls race room creation in the matchmaker, and
// the bench wants one dense room, not several sparse ones.

import { Client } from "@colyseus/sdk";

export interface BenchClientOptions {
  sendHz: number;
  staggerMs: number;
  registerStarter: (start: () => void) => void;
  commandTail: (tick: number) => Uint8Array;
  onConnected: () => void;
  onMessageBytes: (bytes: Uint8Array) => void;
}

const COMMANDS_UP = 1;
const PACKET_DOWN = 2;

export async function joinBenchRoom(
  url: string,
  seat: number,
  options: BenchClientOptions
): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, seat * 30));
  const client = new Client(url);
  const room = await client.joinOrCreate("bench");
  options.onConnected();
  room.onMessage(PACKET_DOWN, (bytes: Uint8Array) => options.onMessageBytes(bytes));
  let tick = 0;
  options.registerStarter(() => {
    setTimeout(() => {
      setInterval(() => {
        tick += 1;
        room.sendBytes(COMMANDS_UP, options.commandTail(tick));
      }, 1000 / options.sendHz);
    }, options.staggerMs);
  });
}
