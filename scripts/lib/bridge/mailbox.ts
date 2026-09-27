/**
 * The bridge's two threads: the backend runs synchronously on the main thread, and the TCP server runs in a
 * worker. Socket events reach the main thread through this mailbox, one at a time, in a SharedArrayBuffer the
 * main thread can wait on with `Atomics.wait`: that is how a backend in the middle of a `COPY … FROM STDIN`
 * blocks until the client's next bytes arrive, as it would on a socket. Everything the main thread sends the
 * worker (bytes for a client, a close, "the slot is free") goes by `postMessage`, which the worker receives
 * while the main thread waits.
 */

export type BridgeEvent =
  | { readonly kind: "listening"; readonly port: number }
  | { readonly kind: "open"; readonly id: number }
  | { readonly kind: "data"; readonly id: number; readonly data: Uint8Array }
  | { readonly kind: "close"; readonly id: number }
  | { readonly kind: "error"; readonly message: string };

/** What the main thread posts to the worker. */
export type WorkerCommand =
  | { readonly type: "listen"; readonly mailbox: SharedArrayBuffer; readonly host: string; readonly port: number }
  | { readonly type: "write"; readonly id: number; readonly data: Uint8Array }
  | { readonly type: "close"; readonly id: number }
  | { readonly type: "freed" };

const KINDS = ["listening", "open", "data", "close", "error"] as const;
/** The control words: the slot's state (empty or full), the event's kind, its connection id, its payload length. */
const STATE = 0;
const KIND = 1;
const ID = 2;
const LENGTH = 3;
const HEADER_BYTES = 16;
const EMPTY = 0;
const FULL = 1;
/** The payload capacity; a larger chunk of data is split. */
export const MAILBOX_CAPACITY = 1 << 20;

export function createMailboxBuffer(): SharedArrayBuffer {
  return new SharedArrayBuffer(HEADER_BYTES + MAILBOX_CAPACITY);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The worker's end: queues events and fills the slot whenever the main thread has emptied it. */
export class MailboxWriter {
  readonly #control: Int32Array;
  readonly #payload: Uint8Array;
  readonly #queue: { kind: number; id: number; payload: Uint8Array }[] = [];

  constructor(buffer: SharedArrayBuffer) {
    this.#control = new Int32Array(buffer, 0, HEADER_BYTES / 4);
    this.#payload = new Uint8Array(buffer, HEADER_BYTES);
  }

  post(event: BridgeEvent): void {
    const kind = KINDS.indexOf(event.kind);
    switch (event.kind) {
      case "listening":
        this.#queue.push({ kind, id: event.port, payload: new Uint8Array(0) });
        break;
      case "error":
        this.#queue.push({ kind, id: 0, payload: encoder.encode(event.message).subarray(0, MAILBOX_CAPACITY) });
        break;
      case "data":
        for (let offset = 0; offset < event.data.length; offset += MAILBOX_CAPACITY) {
          this.#queue.push({ kind, id: event.id, payload: event.data.subarray(offset, offset + MAILBOX_CAPACITY) });
        }
        break;
      default:
        this.#queue.push({ kind, id: event.id, payload: new Uint8Array(0) });
    }
    this.pump();
  }

  /** Fills the slot with the next queued event, if the slot is empty. Call it when the main thread frees it. */
  pump(): void {
    const next = this.#queue[0];
    if (next === undefined || Atomics.load(this.#control, STATE) !== EMPTY) return;
    this.#queue.shift();
    this.#payload.set(next.payload);
    this.#control[KIND] = next.kind;
    this.#control[ID] = next.id;
    this.#control[LENGTH] = next.payload.length;
    Atomics.store(this.#control, STATE, FULL);
    Atomics.notify(this.#control, STATE);
  }
}

/** The main thread's end. */
export class Mailbox {
  readonly #control: Int32Array;
  readonly #payload: Uint8Array;
  readonly #freed: () => void;

  /** `freed` tells the worker the slot is empty again. */
  constructor(buffer: SharedArrayBuffer, freed: () => void) {
    this.#control = new Int32Array(buffer, 0, HEADER_BYTES / 4);
    this.#payload = new Uint8Array(buffer, HEADER_BYTES);
    this.#freed = freed;
  }

  /** The next event, waiting for it (the thread blocks) up to `timeoutMs`; `undefined` when none came. */
  take(timeoutMs = Number.POSITIVE_INFINITY): BridgeEvent | undefined {
    if (Atomics.load(this.#control, STATE) === EMPTY) {
      Atomics.wait(this.#control, STATE, EMPTY, timeoutMs);
      if (Atomics.load(this.#control, STATE) === EMPTY) return undefined;
    }
    const kind = KINDS[this.#control[KIND] ?? -1];
    const id = this.#control[ID] ?? 0;
    const payload = this.#payload.slice(0, this.#control[LENGTH] ?? 0);
    Atomics.store(this.#control, STATE, EMPTY);
    this.#freed();
    switch (kind) {
      case "listening":
        return { kind, port: id };
      case "open":
      case "close":
        return { kind, id };
      case "data":
        return { kind, id, data: payload };
      case "error":
        return { kind, message: decoder.decode(payload) };
      default:
        throw new Error(`mailbox: unknown event kind ${String(this.#control[KIND])}`);
    }
  }
}
