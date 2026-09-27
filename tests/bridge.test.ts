import { describe, expect, test } from "bun:test";

import { FrontendBuffer, sqlLiteral, splitOptions, startupSettings } from "../scripts/lib/bridge/frontend.ts";
import { createMailboxBuffer, Mailbox, MAILBOX_CAPACITY, MailboxWriter } from "../scripts/lib/bridge/mailbox.ts";
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
} from "../scripts/lib/driver/wire.ts";
import { thrown } from "./helpers.ts";

const concat = (...parts: Uint8Array[]) => new Uint8Array(parts.flatMap((part) => Array.from(part)));
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

function packet(code: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setInt32(0, 8);
  new DataView(out.buffer).setInt32(4, code);
  return out;
}

describe("startup packets", () => {
  test("parses the startup message's version and parameters", () => {
    const parsed = parseStartupPacket(startupMessage({ user: "postgres", database: "regression", options: "-c a=b" }));
    expect(parsed).toEqual({
      kind: "startup",
      major: 3,
      minor: 0,
      parameters: { user: "postgres", database: "regression", options: "-c a=b" },
    });
  });

  test("recognises the SSL, GSS encryption and cancel requests", () => {
    expect(parseStartupPacket(packet(80877103))).toEqual({ kind: "ssl" });
    expect(parseStartupPacket(packet(80877104))).toEqual({ kind: "gssenc" });
    const cancel = concat(packet(80877102), new Uint8Array(8));
    new DataView(cancel.buffer).setInt32(0, 16);
    expect(parseStartupPacket(cancel)).toEqual({ kind: "cancel" });
  });

  test("rejects a packet whose length field lies or whose parameters are cut short", () => {
    const good = startupMessage({ user: "postgres" });
    expect(thrown(() => parseStartupPacket(good.subarray(0, good.length - 1))).message).toContain("length field");
    const unterminated = good.slice(0, good.length - 1);
    new DataView(unterminated.buffer).setInt32(0, unterminated.length);
    expect(thrown(() => parseStartupPacket(unterminated)).message).toContain("not terminated");
  });
});

describe("the bridge's messages", () => {
  test("Sync, CopyFail and an ErrorResponse are framed as the protocol says", () => {
    expect(Array.from(syncMessage())).toEqual([0x53, 0, 0, 0, 4]);
    const fail = copyFailMessage("gone");
    expect(String.fromCharCode(fail[0] ?? 0)).toBe("f");
    expect(text(fail.subarray(5))).toBe("gone\0");
    const [error] = parseBackendMessages(errorResponseMessage({ S: "FATAL", C: "3D000", M: "no" }));
    expect(error?.type).toBe("E");
    expect(responseFields(error?.body ?? new Uint8Array(0))).toEqual({ S: "FATAL", C: "3D000", M: "no" });
  });

  test("readyStatus is the last ReadyForQuery's transaction status", () => {
    const ready = (status: string) => concat(new Uint8Array([0x5a, 0, 0, 0, 5]), new TextEncoder().encode(status));
    expect(readyStatus(parseBackendMessages(concat(ready("I"), ready("T"))))).toBe("T");
    expect(readyStatus(parseBackendMessages(errorResponseMessage({ M: "x" })))).toBeUndefined();
  });
});

describe("FrontendBuffer", () => {
  test("hands out only whole messages, however the bytes arrive", () => {
    const buffer = new FrontendBuffer();
    const stream = concat(queryMessage("SELECT 1"), syncMessage(), queryMessage("SELECT 2"));
    const cut = queryMessage("SELECT 1").length + 3;
    buffer.push(stream.subarray(0, 3));
    expect(buffer.takeMessages().length).toBe(0);
    buffer.push(stream.subarray(3, cut));
    expect(buffer.takeMessages()).toEqual(queryMessage("SELECT 1"));
    buffer.push(stream.subarray(cut));
    expect(buffer.takeMessages()).toEqual(concat(syncMessage(), queryMessage("SELECT 2")));
    expect(buffer.terminated).toBe(false);
  });

  test("stops at a Terminate, which it never returns, and drops what follows", () => {
    const buffer = new FrontendBuffer();
    buffer.push(concat(queryMessage("SELECT 1"), new Uint8Array([0x58, 0, 0, 0, 4]), queryMessage("SELECT 2")));
    expect(buffer.takeMessages()).toEqual(queryMessage("SELECT 1"));
    expect(buffer.terminated).toBe(true);
    buffer.push(queryMessage("SELECT 3"));
    expect(buffer.takeMessages().length).toBe(0);
  });

  test("splits the startup phase's untyped packets one at a time", () => {
    const buffer = new FrontendBuffer();
    const ssl = packet(80877103);
    const startup = startupMessage({ user: "postgres" });
    buffer.push(concat(ssl, startup.subarray(0, 5)));
    expect(buffer.takeStartupPacket()).toEqual(ssl);
    expect(buffer.takeStartupPacket()).toBeUndefined();
    buffer.push(startup.subarray(5));
    expect(buffer.takeStartupPacket()).toEqual(startup);
  });

  test("refuses impossible lengths", () => {
    const buffer = new FrontendBuffer();
    buffer.push(new Uint8Array([0, 0, 0, 2]));
    expect(thrown(() => buffer.takeStartupPacket()).message).toContain("invalid length of startup packet");
    const typed = new FrontendBuffer();
    typed.push(new Uint8Array([0x51, 0, 0, 0, 1]));
    expect(thrown(() => typed.takeMessages()).message).toContain("invalid length 1");
  });
});

describe("startup settings", () => {
  test("are the non-protocol parameters, then each setting of options", () => {
    expect(
      startupSettings({
        user: "postgres",
        database: "regression",
        replication: "false",
        _pq_: "x",
        "_pq_.option": "x",
        application_name: "pg_regress/boolean",
        datestyle: "Postgres, MDY",
        options: " -c intervalstyle=postgres_verbose --work-mem=64kB -cfoo.bar=a\\ b",
      }),
    ).toEqual([
      ["_pq_", "x"],
      ["application_name", "pg_regress/boolean"],
      ["datestyle", "Postgres, MDY"],
      ["intervalstyle", "postgres_verbose"],
      ["work_mem", "64kB"],
      ["foo.bar", "a b"],
    ]);
  });

  test("refuses options that are not settings", () => {
    expect(thrown(() => startupSettings({ options: "-B 100" })).message).toContain('"-B"');
    expect(thrown(() => startupSettings({ options: "-c" })).message).toContain("ends with -c");
    expect(thrown(() => startupSettings({ options: "-c work_mem" })).message).toContain("has no value");
  });

  test("options split as the server splits them", () => {
    expect(splitOptions("  a\tb\\ c  d\\\\e ")).toEqual(["a", "b c", "d\\e"]);
    expect(splitOptions("")).toEqual([]);
  });

  test("values become SQL literals", () => {
    expect(sqlLiteral("it's \\ fine")).toBe("'it''s \\ fine'");
  });
});

describe("the mailbox", () => {
  test("carries events one at a time, splits large data and reports the slot free", () => {
    const buffer = createMailboxBuffer();
    const writer = new MailboxWriter(buffer);
    let freed = 0;
    const mailbox = new Mailbox(buffer, () => {
      freed += 1;
      writer.pump();
    });
    expect(mailbox.take(0)).toBeUndefined();
    const big = new Uint8Array(MAILBOX_CAPACITY + 10).map((_, index) => index % 251);
    writer.post({ kind: "listening", port: 5432 });
    writer.post({ kind: "open", id: 7 });
    writer.post({ kind: "data", id: 7, data: big });
    writer.post({ kind: "close", id: 7 });
    writer.post({ kind: "error", message: "boom" });
    expect(mailbox.take(0)).toEqual({ kind: "listening", port: 5432 });
    expect(mailbox.take(0)).toEqual({ kind: "open", id: 7 });
    const first = mailbox.take(0);
    const second = mailbox.take(0);
    expect(first?.kind === "data" && second?.kind === "data" && concat(first.data, second.data)).toEqual(big);
    expect(mailbox.take(0)).toEqual({ kind: "close", id: 7 });
    expect(mailbox.take(0)).toEqual({ kind: "error", message: "boom" });
    expect(mailbox.take(0)).toBeUndefined();
    expect(freed).toBe(6);
  });
});
