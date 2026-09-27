/**
 * The bridge's TCP side, in a worker (see mailbox.ts): accepts connections, hands every socket event to the
 * main thread through the mailbox, and writes and closes sockets when the main thread says so.
 */
import { createServer, type Socket } from "node:net";

import { MailboxWriter, type WorkerCommand } from "./mailbox.ts";

declare const self: Worker;

let writer: MailboxWriter | undefined;
const sockets = new Map<number, Socket>();
let nextId = 1;

function listen(command: Extract<WorkerCommand, { type: "listen" }>): void {
  const mailbox = new MailboxWriter(command.mailbox);
  writer = mailbox;
  const server = createServer({ noDelay: true }, (socket) => {
    const id = nextId;
    nextId += 1;
    sockets.set(id, socket);
    mailbox.post({ kind: "open", id });
    socket.on("data", (data: Buffer) => {
      // A copy: the event waits in the queue, and the socket's buffer may be reused.
      mailbox.post({ kind: "data", id, data: Uint8Array.from(data) });
    });
    // A reset or a write after the client left: the close that follows reports it.
    socket.on("error", () => undefined);
    socket.once("close", () => {
      sockets.delete(id);
      mailbox.post({ kind: "close", id });
    });
  });
  server.on("error", (error: Error) => mailbox.post({ kind: "error", message: error.message }));
  server.listen(command.port, command.host, () => {
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : command.port;
    mailbox.post({ kind: "listening", port });
  });
}

self.onmessage = (event: MessageEvent<WorkerCommand>) => {
  const command = event.data;
  switch (command.type) {
    case "listen":
      listen(command);
      break;
    case "freed":
      writer?.pump();
      break;
    case "write": {
      const socket = sockets.get(command.id);
      if (socket !== undefined && !socket.destroyed) socket.write(command.data);
      break;
    }
    case "close":
      // After whatever was written: a server that closes its end once its last reply is out.
      sockets.get(command.id)?.end();
      break;
  }
};
