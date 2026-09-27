/**
 * The frontend side of a bridge connection: its bytes split into the whole messages the backend is given,
 * and the settings its startup packet asks for.
 */

const TERMINATE = 0x58; // 'X'
/** No frontend message the bridge passes on may claim more (the backend's own limit is lower). */
const MAX_MESSAGE_LENGTH = 0x40000000;

export class ProtocolError extends Error {
  override name = "ProtocolError";
}

/**
 * A connection's bytes that have not been handed to the backend. Only whole messages leave it, so a client
 * that goes away mid-message never leaves half a message in the backend's buffer for the next one.
 */
export class FrontendBuffer {
  #bytes = new Uint8Array(0);
  #offset = 0;
  #terminated = false;

  push(chunk: Uint8Array): void {
    if (this.#terminated) return;
    const rest = this.#bytes.subarray(this.#offset);
    const next = new Uint8Array(rest.length + chunk.length);
    next.set(rest);
    next.set(chunk, rest.length);
    this.#bytes = next;
    this.#offset = 0;
  }

  /** Whether a Terminate (`X`) arrived; nothing after it is kept. */
  get terminated(): boolean {
    return this.#terminated;
  }

  /** The next startup-phase packet (Int32 length first, no type byte), once it has arrived whole. */
  takeStartupPacket(): Uint8Array | undefined {
    const available = this.#bytes.length - this.#offset;
    if (available < 4) return undefined;
    const length = new DataView(this.#bytes.buffer, this.#bytes.byteOffset + this.#offset).getInt32(0);
    if (length < 8 || length > 10000) throw new ProtocolError(`invalid length of startup packet (${length})`);
    if (available < length) return undefined;
    const packet = this.#bytes.subarray(this.#offset, this.#offset + length);
    this.#offset += length;
    return packet;
  }

  /**
   * Every whole typed message that has arrived, as one run of bytes (empty when none has), up to a
   * Terminate, which is consumed and not returned: the connection ends there.
   */
  takeMessages(): Uint8Array {
    const view = new DataView(this.#bytes.buffer, this.#bytes.byteOffset, this.#bytes.byteLength);
    const start = this.#offset;
    let end = start;
    while (!this.#terminated && this.#bytes.length - end >= 5) {
      const length = view.getInt32(end + 1);
      if (length < 4 || length > MAX_MESSAGE_LENGTH) {
        throw new ProtocolError(`invalid length ${length} of a message of type ${this.#bytes[end]}`);
      }
      if (this.#bytes.length - end < 1 + length) break;
      if (this.#bytes[end] === TERMINATE) {
        this.#terminated = true;
        this.#offset = this.#bytes.length;
        return this.#bytes.subarray(start, end);
      }
      end += 1 + length;
    }
    this.#offset = end;
    return this.#bytes.subarray(start, end);
  }
}

/** The startup parameters that are not settings: they name the session, or belong to the protocol. */
const NOT_SETTINGS = new Set(["user", "database", "options", "replication"]);

/**
 * The settings a startup packet asks for, in order: every parameter that is not the user, the database, the
 * replication flag or a `_pq_.` protocol option, then each `-c name=value` or `--name=value` of `options`
 * (split as the server splits it: whitespace separates, a backslash escapes the next character). Any other
 * command-line switch in `options` is refused: those need a backend start, which this session had already.
 */
export function startupSettings(parameters: Readonly<Record<string, string>>): [string, string][] {
  const settings: [string, string][] = Object.entries(parameters).filter(
    ([name]) => !NOT_SETTINGS.has(name) && !name.startsWith("_pq_."),
  );
  const words = splitOptions(parameters["options"] ?? "");
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? "";
    let setting: string | undefined;
    if (word === "-c") {
      setting = words[index + 1];
      index += 1;
      if (setting === undefined) throw new ProtocolError(`the options parameter ends with -c and no setting`);
    } else if (word.startsWith("-c")) {
      setting = word.slice(2);
    } else if (word.startsWith("--")) {
      setting = word.slice(2);
    } else {
      throw new ProtocolError(`the options parameter's ${JSON.stringify(word)} is not a -c or --name=value setting`);
    }
    const equals = setting.indexOf("=");
    if (equals <= 0) throw new ProtocolError(`the option ${JSON.stringify(setting)} has no value`);
    settings.push([setting.slice(0, equals).replaceAll("-", "_"), setting.slice(equals + 1)]);
  }
  return settings;
}

/** `pg_split_opts`: words separated by whitespace, where a backslash makes the next character literal. */
export function splitOptions(options: string): string[] {
  const words: string[] = [];
  let word: string | undefined;
  for (let index = 0; index < options.length; index += 1) {
    const char = options.charAt(index);
    if (/\s/.test(char)) {
      if (word !== undefined) words.push(word);
      word = undefined;
    } else if (char === "\\" && index + 1 < options.length) {
      index += 1;
      word = (word ?? "") + options.charAt(index);
    } else {
      word = (word ?? "") + char;
    }
  }
  if (word !== undefined) words.push(word);
  return words;
}

/** A SQL string literal (standard_conforming_strings on, as the session's reset leaves it). */
export function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
