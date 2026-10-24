import { UserError } from "../git.ts";
import type { Postgres } from "./postgres.ts";
import {
  bindMessage,
  executeMessage,
  flushMessage,
  parseBackendMessages,
  parseMessage,
  queryMessage,
  queryResults,
  readyStatus,
  responseFields,
  syncMessage,
  type BackendMessage,
} from "./wire.ts";

const concat = (...parts: Uint8Array[]) => new Uint8Array(parts.flatMap((part) => Array.from(part)));

function expect(condition: boolean, what: string, messages: readonly BackendMessage[]): void {
  if (!condition) {
    throw new UserError(`driver:smoke FAILED: ${what}; got ${JSON.stringify(messages.map((message) => message.type))}`);
  }
}

/** Real wire-level regression: recovery must discard input until Sync, then emit exactly one readiness. */
export function assertExtendedQueryRecovery(postgres: Pick<Postgres, "exchange">): void {
  const exchange = (bytes: Uint8Array) => parseBackendMessages(postgres.exchange(bytes));
  const boundQuery = (sql: string, parameter: string) =>
    concat(parseMessage(sql, [23]), bindMessage([parameter]), executeMessage());
  const cases = [
    {
      phase: "Parse",
      code: "42601",
      completions: [],
      input: concat(parseMessage("SELECT FROM"), bindMessage(), executeMessage()),
    },
    { phase: "Bind", code: "22P02", completions: ["1"], input: boundQuery("SELECT $1::integer", "invalid-integer") },
    {
      phase: "Execute",
      code: "22012",
      completions: ["1", "2"],
      // Volatility prevents custom-plan constant folding from raising this during Bind.
      input: boundQuery("SELECT 1 / ($1::integer + (random() * 0)::integer)", "0"),
    },
  ];

  for (const transaction of [false, true]) {
    for (const { phase, code, completions, input } of cases) {
      const context = `${phase} error ${transaction ? "inside" : "outside"} a transaction`;
      if (transaction) queryResults(exchange(queryMessage("BEGIN")));
      const failed = exchange(concat(input, flushMessage()));
      const errors = failed.filter((message) => message.type === "E");
      expect(
        errors.length === 1 && responseFields(errors[0]?.body ?? new Uint8Array(0))["C"] === code,
        `${context} reports ${code}`,
        failed,
      );
      expect(
        JSON.stringify(
          failed
            .slice(
              0,
              failed.findIndex((message) => message.type === "E"),
            )
            .map((message) => message.type),
        ) === JSON.stringify(completions),
        `${context} follows exactly the preceding phases' completion messages`,
        failed,
      );
      expect(
        !failed.some((message) => message.type === "Z"),
        `${context} does not send ReadyForQuery before Sync`,
        failed,
      );

      const flushed = exchange(flushMessage());
      expect(flushed.length === 0, `${context} stays silent on a further Flush before Sync`, flushed);
      const skipped = exchange(concat(boundQuery("SELECT $1::integer + 1000", "1"), flushMessage()));
      expect(skipped.length === 0, `${context} discards subsequent extended-query input before Sync`, skipped);

      const synced = exchange(syncMessage());
      expect(
        synced.length === 1 && synced[0]?.type === "Z" && readyStatus(synced) === (transaction ? "E" : "I"),
        `${context} sends exactly one ReadyForQuery with the correct transaction status at Sync`,
        synced,
      );
      if (transaction) {
        const rolledBack = exchange(queryMessage("ROLLBACK"));
        queryResults(rolledBack);
        expect(readyStatus(rolledBack) === "I", `${context} can roll back to idle`, rolledBack);
      }

      const recovered = exchange(concat(boundQuery("SELECT $1::integer + 1", "41"), syncMessage()));
      const rows = queryResults(recovered)[0]?.rows;
      expect(
        JSON.stringify(rows) === JSON.stringify([["42"]]) &&
          recovered.filter((message) => message.type === "Z").length === 1 &&
          readyStatus(recovered) === "I",
        `${context} permits the next bound query and returns one idle ReadyForQuery`,
        recovered,
      );
    }
  }
}
