/**
 * Just enough of the PostgreSQL wire protocol (version 3.0) to talk to the driver's byte channel: the
 * startup packet and simple queries going in, and the backend's messages coming out.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const PROTOCOL_3_0 = 196608;

function frame(type: string | undefined, body: Uint8Array): Uint8Array {
  const header = type === undefined ? 0 : 1;
  const out = new Uint8Array(header + 4 + body.length);
  if (type !== undefined) out[0] = type.charCodeAt(0);
  new DataView(out.buffer).setInt32(header, 4 + body.length);
  out.set(body, header + 4);
  return out;
}

/** The startup packet: protocol 3.0 and the given parameters (`user`, `database`, …). */
export function startupMessage(parameters: Readonly<Record<string, string>>): Uint8Array {
  const pairs = Object.entries(parameters).flatMap(([key, value]) => [key, value]);
  const strings = encoder.encode(`${pairs.map((text) => `${text}\0`).join("")}\0`);
  const body = new Uint8Array(4 + strings.length);
  new DataView(body.buffer).setInt32(0, PROTOCOL_3_0);
  body.set(strings, 4);
  return frame(undefined, body);
}

/** A simple Query (`Q`): one or more statements, run in one implicit transaction unless they say otherwise. */
export function queryMessage(sql: string): Uint8Array {
  return frame("Q", encoder.encode(`${sql}\0`));
}

/** Sync (`S`): ends an extended-query batch, and any skip-till-Sync after an error in one. */
export function syncMessage(): Uint8Array {
  return frame("S", new Uint8Array(0));
}

/** CopyFail (`f`): the frontend abandons a `COPY … FROM STDIN`, which then fails with `reason`. */
export function copyFailMessage(reason: string): Uint8Array {
  return frame("f", encoder.encode(`${reason}\0`));
}

/** An ErrorResponse (`E`) with the given fields, by code (`S`, `V`, `C`, `M`, …). */
export function errorResponseMessage(fields: Readonly<Record<string, string>>): Uint8Array {
  const text = Object.entries(fields)
    .map(([code, value]) => `${code}${value}\0`)
    .join("");
  return frame("E", encoder.encode(`${text}\0`));
}

/** The longest startup packet a server accepts (MAX_STARTUP_PACKET_LENGTH, pqcomm.h). */
export const MAX_STARTUP_PACKET_LENGTH = 10000;
const CANCEL_REQUEST_CODE = 80877102;
const SSL_REQUEST_CODE = 80877103;
const GSSENC_REQUEST_CODE = 80877104;

/** A startup-phase packet: an encryption request, a cancel request, or the startup message itself. */
export type StartupPacket =
  | { readonly kind: "ssl" }
  | { readonly kind: "gssenc" }
  | { readonly kind: "cancel" }
  | {
      readonly kind: "startup";
      readonly major: number;
      readonly minor: number;
      /** `user`, `database`, `options`, `application_name`, GUCs, `_pq_.*` protocol options, … */
      readonly parameters: Readonly<Record<string, string>>;
    };

/** Parses one whole startup-phase packet (its Int32 length first; no type byte). */
export function parseStartupPacket(packet: Uint8Array): StartupPacket {
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  if (packet.length < 8 || view.getInt32(0) !== packet.length) {
    throw new Error(`wire: a startup packet of ${packet.length} bytes does not match its length field`);
  }
  const code = view.getInt32(4);
  if (code === SSL_REQUEST_CODE) return { kind: "ssl" };
  if (code === GSSENC_REQUEST_CODE) return { kind: "gssenc" };
  if (code === CANCEL_REQUEST_CODE) return { kind: "cancel" };
  const strings = decoder.decode(packet.subarray(8)).split("\0");
  if (strings.at(-1) !== "" || strings.at(-2) !== "") throw new Error("wire: the startup packet is not terminated");
  const pairs = strings.slice(0, -2);
  if (pairs.length % 2 !== 0) throw new Error("wire: the startup packet has a parameter without a value");
  const parameters: Record<string, string> = {};
  for (let index = 0; index < pairs.length; index += 2) parameters[pairs[index] ?? ""] = pairs[index + 1] ?? "";
  return { kind: "startup", major: code >>> 16, minor: code & 0xffff, parameters };
}

/** The transaction status of the last ReadyForQuery (`I` idle, `T` in a block, `E` in a failed block). */
export function readyStatus(messages: readonly BackendMessage[]): string | undefined {
  const ready = messages.findLast((message) => message.type === "Z");
  return ready === undefined ? undefined : String.fromCharCode(ready.body[0] ?? 0);
}

export interface BackendMessage {
  /** The message's type byte, as a character (`T`, `D`, `C`, `E`, `Z`, …). */
  readonly type: string;
  readonly body: Uint8Array;
}

/** Splits backend bytes into messages; a truncated message at the end is an error. */
export function parseBackendMessages(bytes: Uint8Array): BackendMessage[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const messages: BackendMessage[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 5 > bytes.length) throw new Error(`wire: truncated message header at byte ${offset}`);
    const length = view.getInt32(offset + 1);
    if (length < 4 || offset + 1 + length > bytes.length) {
      throw new Error(`wire: message at byte ${offset} claims ${length} bytes; ${bytes.length - offset - 1} remain`);
    }
    messages.push({
      type: String.fromCharCode(bytes[offset] ?? 0),
      body: bytes.subarray(offset + 5, offset + 1 + length),
    });
    offset += 1 + length;
  }
  return messages;
}

class Reader {
  readonly #view: DataView;
  readonly #bytes: Uint8Array;
  offset = 0;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  int16(): number {
    const value = this.#view.getInt16(this.offset);
    this.offset += 2;
    return value;
  }

  int32(): number {
    const value = this.#view.getInt32(this.offset);
    this.offset += 4;
    return value;
  }

  cstring(): string {
    const end = this.#bytes.indexOf(0, this.offset);
    if (end === -1) throw new Error("wire: unterminated string");
    const value = decoder.decode(this.#bytes.subarray(this.offset, end));
    this.offset = end + 1;
    return value;
  }

  bytes(length: number): Uint8Array {
    const value = this.#bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }
}

/** An ErrorResponse's or NoticeResponse's fields, by their code (`S`, `C`, `M`, `D`, `H`, …). */
export function responseFields(body: Uint8Array): Record<string, string> {
  const reader = new Reader(body);
  const fields: Record<string, string> = {};
  while (reader.offset < body.length) {
    const code = String.fromCharCode(body[reader.offset] ?? 0);
    reader.offset += 1;
    if (code === "\0") break;
    fields[code] = reader.cstring();
  }
  return fields;
}

export interface QueryResult {
  /** The CommandComplete tag (`SELECT 1`, `INSERT 0 3`, `CREATE TABLE`). */
  readonly command: string;
  readonly columns: readonly string[];
  /** Text-format values; `null` for SQL NULL. */
  readonly rows: readonly (readonly (string | null)[])[];
}

export class ServerError extends Error {
  override name = "ServerError";
  readonly fields: Readonly<Record<string, string>>;

  constructor(fields: Readonly<Record<string, string>>) {
    super(`${fields["S"] ?? "ERROR"} ${fields["C"] ?? "?????"}: ${fields["M"] ?? "(no message)"}`);
    this.fields = fields;
  }
}

/**
 * The results of one simple-query exchange, statement by statement. An ErrorResponse becomes a
 * {@link ServerError}; the response must end with ReadyForQuery.
 */
export function queryResults(messages: readonly BackendMessage[]): QueryResult[] {
  const results: QueryResult[] = [];
  let columns: string[] = [];
  let rows: (string | null)[][] = [];
  let error: ServerError | undefined;
  for (const message of messages) {
    const reader = new Reader(message.body);
    switch (message.type) {
      case "T": {
        const count = reader.int16();
        columns = [];
        for (let index = 0; index < count; index += 1) {
          columns.push(reader.cstring());
          reader.offset += 18; // table oid, attnum, type oid, typlen, typmod, format
        }
        rows = [];
        break;
      }
      case "D": {
        const count = reader.int16();
        const row: (string | null)[] = [];
        for (let index = 0; index < count; index += 1) {
          const length = reader.int32();
          row.push(length === -1 ? null : decoder.decode(reader.bytes(length)));
        }
        rows.push(row);
        break;
      }
      case "C":
        results.push({ command: reader.cstring(), columns, rows });
        columns = [];
        rows = [];
        break;
      case "E":
        error ??= new ServerError(responseFields(message.body));
        break;
      default:
        break;
    }
  }
  if (messages.at(-1)?.type !== "Z") throw new Error("wire: the response does not end with ReadyForQuery");
  if (error !== undefined) throw error;
  return results;
}
