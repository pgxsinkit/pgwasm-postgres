/**
 * The TCP bridge (ADR-0001 decision 6): a native client (pg_regress's psql) talks to the wasm build over TCP,
 * and the bridge hands its bytes to the driver's byte channel and the replies back.
 *
 * The build runs one backend, started once on one database, so the bridge serves one session:
 *
 * - **One connection at a time.** The connection that sent the latest startup packet owns the session; a new
 *   one takes it over from the previous one, which is closed. psql's `\c` opens its new connection before it
 *   closes the old one, so a queue would wait forever. A connection that arrives while the backend is busy
 *   (in the middle of a `COPY … FROM STDIN`) waits for the exchange to end.
 * - **A reset before every startup packet**, so what one connection leaves behind does not reach the next:
 *   Sync (ends a skip-till-Sync and an extended-protocol implicit transaction), `ROLLBACK` if a transaction
 *   block is still open, `DISCARD ALL` (closes cursors, `RESET ALL`, drops prepared statements, `UNLISTEN *`,
 *   releases advisory locks, drops cached plans, temporary tables and sequence state), then
 *   `SET SESSION AUTHORIZATION postgres`. The last is needed because single-user mode never gives the
 *   `session_authorization` setting a value, so `DISCARD ALL`'s `SET SESSION AUTHORIZATION DEFAULT` (like a
 *   test's `RESET SESSION AUTHORIZATION`) leaves the session as whatever user it was set to. What the reset
 *   leaves as it is, a real new session would not: its backend pid and start time, loaded libraries, the
 *   catalog caches, cumulative statistics, custom setting names once used, `random()`'s state, and login
 *   event triggers, which never fire again.
 * - **The startup packet's settings are the session's defaults**, as a real server makes them (the backend's
 *   own startup-packet handler only parses them): each non-protocol parameter and each `-c name=value` of
 *   `options`. They are applied with `set_config`, and every one but `application_name` is also a start
 *   parameter of the backend (`-c`), so that `RESET` and `RESET ALL` return to it: when a connection asks for
 *   other settings than the backend was started with, the backend is shut down and started again with them
 *   (for pg_regress, once, at its first connection). A setting the backend refuses ends the connection with a
 *   FATAL, as it would at a real server's login.
 * - **The session's user and database are fixed.** A startup packet for another user or database is refused
 *   with a FATAL, so `\c otherdb` fails visibly instead of silently landing in the served database.
 * - **Only whole messages reach the backend**, and a Terminate never does (the backend would stop sending
 *   output). A backend that reads on mid-exchange (a `COPY … FROM STDIN`) blocks until the client's next
 *   whole messages arrive; if the client is gone, it gets a CopyFail, which fails the COPY cleanly.
 * - **A failed backend is restarted from its data directory**, as a postmaster restarts after a backend
 *   crash: the connection it was serving is closed, the instance's files go to a new instance, and its start
 *   runs crash recovery. The log says `BACKEND FAILED` and which connection (application_name) it served.
 */
import type { Artefacts } from "../driver/artefacts.ts";
import { deterministicHost } from "../driver/determinism.ts";
import { initdb } from "../driver/initdb.ts";
import { Postgres, START_PARAMS, type DataDirEntry, type ExchangeStream } from "../driver/postgres.ts";
import {
  copyFailMessage,
  errorResponseMessage,
  parseBackendMessages,
  parseStartupPacket,
  queryMessage,
  readyStatus,
  responseFields,
  startupMessage,
  syncMessage,
  type BackendMessage,
  type StartupPacket,
} from "../driver/wire.ts";
import { FrontendBuffer, ProtocolError, sqlLiteral, startupSettings } from "./frontend.ts";
import { createMailboxBuffer, Mailbox, type BridgeEvent, type WorkerCommand } from "./mailbox.ts";

/** initdb's bootstrap superuser: the backend's user, whatever the startup packet says. */
export const SESSION_USER = "postgres";

export interface BridgeOptions {
  readonly artefacts: Artefacts;
  /** The database the session runs in; a startup packet must ask for it. */
  readonly database: string;
  /** Queries run in `postgres`, one after the other, before the session starts (`CREATE DATABASE …`). */
  readonly setup: readonly string[];
  /** Host directories mounted at the same paths in the backend's filesystem. */
  readonly mounts: readonly string[];
  readonly host: string;
  /** 0 for any free port. */
  readonly port: number;
  /** SOURCE_DATE_EPOCH: the cluster is made (initdb and the setup queries) on a deterministic host. */
  readonly epoch: number;
  /** The bridge's own events. */
  readonly log: (line: string) => void;
  /** Every line the backend prints. */
  readonly backendLog: (line: string) => void;
}

type Setting = [name: string, value: string];

/** A restart the serve loop makes before anything else runs. */
type Restart =
  | { readonly kind: "failed" }
  | {
      readonly kind: "settings";
      /** The new start settings. */
      readonly start: readonly Setting[];
      /** The connection whose startup waits for the restart, its packet and all its settings. */
      readonly connection: Connection;
      readonly packet: Uint8Array;
      readonly settings: readonly Setting[];
    };

interface Connection {
  readonly id: number;
  readonly input: FrontendBuffer;
  /** `startup` until its startup packet is handled; `session` once it owns the session. */
  state: "startup" | "session";
  /** The client's side is gone. */
  closed: boolean;
  /** Its application_name, for the log. */
  name: string;
  /** A CopyFail was already handed to the backend for it. */
  copyFailed: boolean;
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function firstError(messages: readonly BackendMessage[]): Record<string, string> | undefined {
  const error = messages.find((message) => message.type === "E");
  return error === undefined ? undefined : responseFields(error.body);
}

/** Runs one exchange that must succeed and leave the session idle. */
function expectIdle(postgres: Postgres, message: Uint8Array, what: string): void {
  const messages = parseBackendMessages(postgres.exchange(message));
  const error = firstError(messages);
  if (error !== undefined) throw new Error(`${what} failed: ${error["M"] ?? JSON.stringify(error)}`);
  if (readyStatus(messages) !== "I") throw new Error(`${what} did not leave the session idle`);
}

/** initdb, then the setup queries in `postgres` and a clean shutdown, on a deterministic host. */
async function makeCluster(options: BridgeOptions): Promise<DataDirEntry[]> {
  const host = deterministicHost(options.epoch);
  const cluster = await initdb(options.artefacts, { host, log: options.backendLog });
  if (options.setup.length === 0) return cluster;
  const setup = await Postgres.create(options.artefacts, { host, log: options.backendLog });
  try {
    setup.writeDataDir(cluster);
    setup.start();
    expectIdle(setup, startupMessage({ user: SESSION_USER, database: "postgres" }), "the setup session's startup");
    for (const sql of options.setup) expectIdle(setup, queryMessage(sql), `The setup query ${JSON.stringify(sql)}`);
    setup.shutdown();
    return setup.readDataDir();
  } finally {
    setup.dispose();
  }
}

/** A backend on `entries`, with the mounts, started on the served database with `settings` as `-c`s. */
async function launch(
  options: BridgeOptions,
  entries: readonly DataDirEntry[],
  settings: readonly Setting[],
): Promise<Postgres> {
  const postgres = await Postgres.create(options.artefacts, {
    log: options.backendLog,
    user: SESSION_USER,
    database: options.database,
  });
  postgres.writeDataDir(entries);
  for (const path of options.mounts) postgres.mountHostDirectory(path);
  postgres.start([...START_PARAMS, ...settings.flatMap(([name, value]) => ["-c", `${name}=${value}`])]);
  return postgres;
}

/** The settings that become start parameters: all but `application_name`, which changes with every test. */
function startSettings(settings: readonly Setting[]): Setting[] {
  return settings.filter(([name]) => name.toLowerCase() !== "application_name");
}

function sameSettings(a: readonly Setting[], b: readonly Setting[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export class Bridge {
  readonly port: number;
  readonly #options: BridgeOptions;
  readonly #worker: Worker;
  readonly #mailbox: Mailbox;
  readonly #connections = new Map<number, Connection>();
  #postgres: Postgres;
  #active: Connection | undefined;
  /** The settings the backend was started with. */
  #startSettings: readonly Setting[] = [];
  #restart: Restart | undefined;
  #restarts = 0;

  private constructor(options: BridgeOptions, postgres: Postgres, worker: Worker, mailbox: Mailbox, port: number) {
    this.#options = options;
    this.#postgres = postgres;
    this.#worker = worker;
    this.#mailbox = mailbox;
    this.port = port;
  }

  /** Makes the cluster, starts the backend on it, and listens. */
  static async start(options: BridgeOptions): Promise<Bridge> {
    const cluster = await makeCluster(options);
    const postgres = await launch(options, cluster, []);
    const worker = new Worker(new URL("./tcp-worker.ts", import.meta.url).href);
    const buffer = createMailboxBuffer();
    const mailbox = new Mailbox(buffer, () => worker.postMessage({ type: "freed" } satisfies WorkerCommand));
    worker.postMessage({
      type: "listen",
      mailbox: buffer,
      host: options.host,
      port: options.port,
    } satisfies WorkerCommand);
    const first = mailbox.take(30_000);
    if (first?.kind !== "listening") {
      worker.terminate();
      postgres.close();
      const why = first?.kind === "error" ? first.message : `no answer (${JSON.stringify(first)})`;
      throw new Error(`The bridge could not listen on ${options.host}:${options.port}: ${why}`);
    }
    options.log(
      `listening on ${options.host}:${first.port}; the session runs in ${options.database} as ${SESSION_USER}`,
    );
    return new Bridge(options, postgres, worker, mailbox, first.port);
  }

  /** Serves connections until the process ends. The main thread blocks while no client sends anything. */
  async serve(): Promise<never> {
    for (;;) {
      this.#receive(this.#take());
      this.#drain();
      while (this.#restart !== undefined) {
        await this.#restartBackend(this.#restart);
        this.#drain();
      }
    }
  }

  #take(): BridgeEvent {
    for (;;) {
      const event = this.#mailbox.take();
      if (event !== undefined) return event;
    }
  }

  /** Records a socket event; nothing reaches the backend here. */
  #receive(event: BridgeEvent): void {
    switch (event.kind) {
      case "open":
        this.#connections.set(event.id, {
          id: event.id,
          input: new FrontendBuffer(),
          state: "startup",
          closed: false,
          name: "",
          copyFailed: false,
        });
        break;
      case "data":
        this.#connections.get(event.id)?.input.push(event.data);
        break;
      case "close": {
        const connection = this.#connections.get(event.id);
        if (connection === undefined) break;
        connection.closed = true;
        if (connection.state === "startup") this.#connections.delete(event.id);
        break;
      }
      case "error":
        throw new Error(`The bridge's TCP server failed: ${event.message}`);
      case "listening":
        break;
    }
  }

  /** Hands everything that can run now to the backend: the owner's messages, then startup packets. */
  #drain(): void {
    drain: while (this.#restart === undefined) {
      const active = this.#active;
      if (active !== undefined) {
        let messages: Uint8Array;
        try {
          messages = active.input.takeMessages();
        } catch (error) {
          if (!(error instanceof ProtocolError)) throw error;
          this.#refuse(active, "08P01", error.message);
          continue;
        }
        if (messages.length > 0) {
          this.#exchange(active, messages);
          continue;
        }
        if (active.input.terminated || active.closed) {
          this.#end(active, active.input.terminated ? "terminated" : "disconnected");
          continue;
        }
      }
      for (const connection of this.#connections.values()) {
        if (connection.state !== "startup") continue;
        let packet: Uint8Array | undefined;
        try {
          packet = connection.input.takeStartupPacket();
        } catch (error) {
          if (!(error instanceof ProtocolError)) throw error;
          this.#refuse(connection, "08P01", error.message);
          continue drain;
        }
        if (packet !== undefined) {
          this.#startup(connection, packet);
          continue drain;
        }
      }
      return;
    }
  }

  #send(connection: Connection, data: Uint8Array): void {
    if (!connection.closed)
      this.#worker.postMessage({ type: "write", id: connection.id, data } satisfies WorkerCommand);
  }

  #end(connection: Connection, why: string): void {
    if (this.#active === connection) this.#active = undefined;
    this.#connections.delete(connection.id);
    if (!connection.closed) this.#worker.postMessage({ type: "close", id: connection.id } satisfies WorkerCommand);
    this.#options.log(`#${connection.id} ${connection.name}: ${why}`);
  }

  /** A FATAL to the client, and the connection closed. */
  #refuse(connection: Connection, code: string, message: string): void {
    this.#send(connection, errorResponseMessage({ S: "FATAL", V: "FATAL", C: code, M: `pgwasm bridge: ${message}` }));
    this.#end(connection, `refused: ${message}`);
  }

  #stream(connection: Connection): ExchangeStream {
    return { write: (chunk) => this.#send(connection, chunk), read: () => this.#pull(connection) };
  }

  /** The backend reads on mid-exchange: wait for the client's next whole messages. */
  #pull(connection: Connection): Uint8Array | null {
    for (;;) {
      let messages: Uint8Array;
      try {
        messages = connection.input.takeMessages();
      } catch (error) {
        if (!(error instanceof ProtocolError)) throw error;
        connection.closed = true;
        messages = new Uint8Array(0);
      }
      if (messages.length > 0) return messages;
      if (connection.input.terminated || connection.closed) {
        if (connection.copyFailed) return null;
        connection.copyFailed = true;
        return copyFailMessage("pgwasm bridge: the client went away");
      }
      this.#receive(this.#take());
    }
  }

  #exchange(connection: Connection, message: Uint8Array): void {
    try {
      this.#postgres.exchange(message, this.#stream(connection));
    } catch (error) {
      this.#fail(connection, error);
    }
  }

  #startup(connection: Connection, packet: Uint8Array): void {
    let request: StartupPacket;
    let settings: Setting[];
    try {
      request = parseStartupPacket(packet);
      settings = request.kind === "startup" ? startupSettings(request.parameters) : [];
    } catch (error) {
      this.#refuse(connection, "08P01", error instanceof Error ? error.message : String(error));
      return;
    }
    if (request.kind === "ssl" || request.kind === "gssenc") {
      this.#send(connection, new Uint8Array([0x4e])); // 'N': no encryption, go on in the clear
      return;
    }
    if (request.kind === "cancel") {
      this.#end(connection, "a cancel request, which the bridge does not support");
      return;
    }
    const user = request.parameters["user"] ?? "";
    const database = request.parameters["database"] || user;
    connection.name = request.parameters["application_name"] ?? "";
    if (request.major !== 3) {
      this.#refuse(connection, "0A000", `unsupported frontend protocol ${request.major}.${request.minor}`);
      return;
    }
    if (user !== SESSION_USER) {
      this.#refuse(connection, "28000", `the session's user is "${SESSION_USER}", not "${user}"`);
      return;
    }
    if (database !== this.#options.database) {
      this.#refuse(connection, "3D000", `the session runs in database "${this.#options.database}", not "${database}"`);
      return;
    }

    const previous = this.#active;
    if (previous !== undefined) this.#end(previous, `taken over by #${connection.id}`);
    this.#active = connection;
    connection.state = "session";
    this.#options.log(`#${connection.id} ${connection.name}: connected`);
    try {
      this.#reset();
      if (!this.#apply(connection, settings)) return;
    } catch (error) {
      this.#fail(connection, error);
      return;
    }
    const start = startSettings(settings);
    if (!sameSettings(start, this.#startSettings)) {
      // The settings are valid (the backend just took them); the serve loop restarts it with them.
      this.#restart = { kind: "settings", start, connection, packet, settings };
      return;
    }
    this.#exchange(connection, packet);
  }

  /** The startup that waited for a restart with its settings. */
  #resumeStartup(connection: Connection, packet: Uint8Array, settings: readonly Setting[]): void {
    if (this.#active !== connection) return;
    try {
      if (!this.#apply(connection, settings)) return;
    } catch (error) {
      this.#fail(connection, error);
      return;
    }
    this.#exchange(connection, packet);
  }

  /** Leaves the session as a new one would find it (see the module comment). */
  #reset(): void {
    const status = readyStatus(parseBackendMessages(this.#postgres.exchange(syncMessage())));
    if (status !== "I") expectIdle(this.#postgres, queryMessage("ROLLBACK"), "The reset's ROLLBACK");
    expectIdle(this.#postgres, queryMessage("DISCARD ALL"), "The reset's DISCARD ALL");
    expectIdle(
      this.#postgres,
      queryMessage(`SET SESSION AUTHORIZATION ${SESSION_USER}`),
      "The reset's SET SESSION AUTHORIZATION",
    );
  }

  /**
   * Applies the startup packet's settings to the session. When the backend refuses one, the client gets its
   * error as a FATAL and the connection ends: false.
   */
  #apply(connection: Connection, settings: readonly Setting[]): boolean {
    if (settings.length === 0) return true;
    const sql = settings
      .map(([name, value]) => `SELECT pg_catalog.set_config(${sqlLiteral(name)}, ${sqlLiteral(value)}, false)`)
      .join("; ");
    const messages = parseBackendMessages(this.#postgres.exchange(queryMessage(sql)));
    const error = firstError(messages);
    if (error !== undefined) {
      this.#send(connection, errorResponseMessage({ ...error, S: "FATAL", V: "FATAL" }));
      this.#end(connection, `a startup setting was refused: ${error["M"] ?? ""}`);
      return false;
    }
    if (readyStatus(messages) !== "I") throw new Error("Applying the startup settings did not leave the session idle");
    return true;
  }

  #fail(connection: Connection, error: unknown): void {
    this.#restart = { kind: "failed" };
    const log = this.#options.log;
    log(`#${connection.id} ${connection.name}: BACKEND FAILED: ${describe(error).split("\n")[0] ?? ""}`);
    for (const line of this.#postgres.recentOutput.split("\n").slice(-8)) log(`  | ${line}`);
    this.#end(connection, "closed: the backend failed");
  }

  /**
   * A new backend on the old one's files. After a failure, its start runs crash recovery; for new settings,
   * the old one is shut down cleanly first.
   */
  async #restartBackend(restart: Restart): Promise<void> {
    const settings = restart.kind === "settings" ? restart.start : this.#startSettings;
    if (restart.kind === "settings") this.#postgres.shutdown();
    const entries = this.#postgres.readDataDir();
    this.#postgres.dispose();
    this.#postgres = await launch(this.#options, entries, settings);
    this.#startSettings = settings;
    this.#restart = undefined;
    this.#restarts += 1;
    const why = restart.kind === "failed" ? "after the failure" : "with the connection's settings";
    const flags = settings.map(([name, value]) => `-c ${name}=${value}`).join(" ");
    this.#options.log(`backend restarted ${why} (restart ${this.#restarts})${flags === "" ? "" : `: ${flags}`}`);
    if (restart.kind === "settings") this.#resumeStartup(restart.connection, restart.packet, restart.settings);
  }
}
