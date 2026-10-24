# PostgreSQL 19 port

`port-19` starts from main's `18.6.2` release (`bf7938a`) and pins PostgreSQL
`REL_19_RC1`, commit `0b8bff042a997fe50fcd1c4c83b9ef1cc9ed8a89`. This was the newest
PG19 tag returned by upstream on 2026-10-24. It is a release candidate; this branch
does not adopt PG19 in main or publish a release.

The starting evidence is [readiness issue 1](https://github.com/pgxsinkit/pgwasm-postgres/issues/1),
especially [the RC1 report](https://github.com/pgxsinkit/pgwasm-postgres/issues/1#issuecomment-6266756227).
That report found two conflicts and did not build or run pg_regress. The branch
implements [the major-port checklist](port-checklist.md).

## Source changes

The series remains five topic patches, regenerated from commits in
`work/REL_19_RC1` with `patches:export` and checked for a byte-identical round trip.

- The backend Makefile keeps PG19's platform conditionals and adds a separate
  Emscripten link rule. The embedded backend targets are `pgwasm` and
  `install-pgwasm`; generated files remain `postgres.{js,wasm,data}`.
- `ProcessStartupPacket` is exported with PG19's single `Port *` argument. The
  driver declaration and call follow it.
- The single-process, encoding-shim and main-loop patches are rebased onto RC1.
  Upstream's loop body and bootstrap remain in place.
- Internal PGlite names become `pgwasm` names throughout the patches, overlay,
  driver and tooling. Attribution to PostgreSQL and ElectricSQL remains.
- `Float8GetDatum` and `Int64GetDatum` leave the explicit core exports: PG19
  makes them static inline functions with its always-64-bit `Datum`, so those
  global definitions no longer exist. Rebuilt modules use the inline definitions.

## Host ABI changes

The 19 build requires coordinated changes in pgxsinkit's `pgwasm-c` and
`pgwasm-pg-dump` hosts. The release has not been adopted there by this branch.

| Before                                            | On this branch                                    |
| ------------------------------------------------- | ------------------------------------------------- |
| `_pgl_startPGlite`                                | `_pgwasm_startPostgres`                           |
| `_pgl_setPGliteActive`                            | `_pgwasm_setPostgresActive`                       |
| `_pgl_getPGliteExitStatus`                        | `_pgwasm_getPostgresExitStatus`                   |
| `_pgl_setPGliteExitStatus`                        | `_pgwasm_setPostgresExitStatus`                   |
| Other `_pgl_*` names                              | Corresponding `_pgwasm_*` names                   |
| `_ProcessStartupPacket(port, sslDone, gssDone)`   | `_ProcessStartupPacket(port)`                     |
| `__PGLITE__`, `PGLITE_*`, `POSTGRES_PGLITE_FLAGS` | `__PGWASM__`, `PGWASM_*`, `POSTGRES_PGWASM_FLAGS` |
| `overlay/pglite/`, `pglitec.c`, `build-pglite.sh` | `overlay/pgwasm/`, `pgwasmc.c`, `build-pgwasm.sh` |

The prefix change includes callback registration, socket wrappers, flushing,
connection setup and cleanup. The renamed `system`, `popen` and `pclose` callback
variables have a `_callback` suffix so they do not collide with wrapper functions.
The module filesystem root stays `/pgwasm`.

Emscripten 6.0.13 also removes its `FS.filesystems` map. The glue preserves that
map, including `NODEFS`, `IDBFS`, `MEMFS` and `PROXYFS`, before host `preRun`
callbacks, while exporting `NODEFS` explicitly for the driver. This preserves
pgxsinkit's file mount, IndexedDB mount and IndexedDB handle cleanup. Unit tests
cover callback ordering and existing custom filesystem entries; the smoke test
checks the built module's NODEFS/IDBFS alias identity. Browser persistence remains
part of the consuming host's qualification.

## Builder and stores

The new builder is `6.0.13-p1`: Emscripten 6.0.13 by its linux/amd64 image digest,
ICU 79.1 from its checksum-verified release source, and Ubuntu's 2026-10-24
snapshot. zlib 1.3.2 and libxml2 2.15.4 remain the latest releases when verified.
The image must be published and its digest recorded before any release.

Local and CI Bun pins are both 1.4.4, verified as the latest published version.
The workspace dependencies were refreshed together: Bun types 1.4.4, oxfmt
0.74.0, oxlint 1.89.0 and oxlint-tsgolint 7.0.2005; TypeScript 7.0.2 remained
latest. Validation and gate commands run directly through `bun run`.

The minimal data retains the root-only selection: `coll/root.res` and
`coll/ucadata.icu`, extracted from the release's `source/data/in/icudt79l.dat`
with the native ICU 79.1 `icupkg` built in the builder stage. The release's full
license accompanies them. The smoke test creates a root ICU collation, checks
its catalog version against the runtime version, and sorts non-ASCII text.

`dataFormat` advances from 1 to 2. The old tuple is preserved under `previous`.
PG19 RC1 uses control version 1905, catalog version 202610061 and WAL magic
`0xD122`. Its control layout also adds `slru_pages_per_segment` (32), which the
server checks, and records `float8ByVal` as true on wasm32. The parser retains
PG18's layout and rejects unknown layouts or a bad CRC. Historical 18 manifests
keep their original tuple schema.

An 18 data directory cannot be opened as a 19 directory. The consuming host must
recreate or migrate stores when adopting format 2; that policy and adoption remain
the maintainer's release decision. A subsequent PG19 prerelease may change the
tuple again and must be checked before updating this pin.

## Export audit

The first PG19 build has 1,126 listed symbols: 32 additions and 31 removals
against 18.6.2. Sixteen on each side are the `_pgl_*` to `_pgwasm_*` rename.
The other changes were checked against both actual WebAssembly module imports
and RC1's source before recording the new reference:

| Module                              | New imports                                                                                                                            |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `pgrepack.so` (new upstream module) | `AmRepackWorker`, `BufFileWrite`                                                                                                       |
| `pgoutput.so`                       | `GetRelationIncludedPublications`, `GetRelationExcludedPublications`                                                                   |
| `amcheck.so`                        | `FunctionCall2Coll`, `LockBufferInternal`, `get_am_name`, `palloc_mul`                                                                 |
| `libpqwalreceiver.so`               | `MemoryContextAllocExtended`, `MemoryContextUnregisterResetCallback`, `errhidestmt`, `errhidecontext`, `strtok_r`, `TupleDescFinalize` |
| `plpgsql.so`                        | `palloc_mul`, `palloc0_mul`, `TupleDescFinalize`, `copyObjectImpl`                                                                     |
| `dict_snowball.so`                  | `palloc0_mul`                                                                                                                          |

Shared imports are listed on each importing module; there are sixteen distinct
new non-rename symbols. The source changes include publication exclusion APIs
(`pgoutput.c`), checked multiplication in `palloc.h`, explicit tuple descriptor
finalization, memory-context-safe libpq result wrappers (`libpq-be-fe.h`), the
libpq notice receiver (`libpq-be-fe-helpers.h`), and copying a PL/pgSQL type name
out of short-lived storage (`pl_comp.c`). The `strtok_r` import is libpq's
`oauth-debug.h` parser. These are upstream PG19 changes, not new enabled services.

The fifteen non-rename removals are intentional: `Float8GetDatum`,
`Int64GetDatum`, `LockBuffer`, `MultiXactIdPrecedes`, `MultiXactIdPrecedesOrEquals`,
`TransactionIdPrecedes` and `ginCompareAttEntries` become inline operations;
`GetRelationPublications` is replaced by the included/excluded APIs;
`slot_getsomeattrs_int` becomes tuple-slot operations dispatch; amcheck no longer
needs `_bt_freestack`; the WAL receiver obtains the server LSN from its identify
operation instead of `WalRcvIdentifySystemLsn`; and MULE_INTERNAL removal deletes
`latin2mic`, `latin2mic_with_table`, `mic2latin` and `mic2latin_with_table`.
MULE_INTERNAL removal also reduces default conversions from 128 to 98 and the
shipped module count to 27 including amcheck. Smoke still exercises every default
conversion and all seventeen non-ASCII round-trip encodings.

## Validation

The builder was compiled and its 225 installed packages checked. All five
patches apply and round-trip on RC1; format, typecheck, lint and all 195 unit
tests pass. A real initdb verifies format 2's complete fourteen-field tuple.

Runtime smoke passes exact version matching, filesystem interface identity,
ICU root collation, SQL/error recovery, amcheck, all 27 shipped modules, all 98
default conversions, seventeen non-ASCII encoding round trips, stemming, 4,000
consecutive handled SQL errors without shadow-stack loss, and pg_dump. The
prepopulated archive boots with 999 entries and 421 catalog relations, and its
record reproduces under Bun 1.4.4. Export, identity and regression records are
separate commits.

Eight complete native regression runs each executed 239 tests: 185 passed and
54 failed, with no backend failure. Their combined baseline records 185 passed,
50 stable failures and the same four unstable tests as PG18 (`psql`,
`psql_pipeline`, `subscription`, `stats`). Of eight new tests, seven pass; the
new `nls` failure requires the same deliberately unshipped `regress.so` helper
library as existing tests. `compression_lz4` matches upstream's unsupported-build
skip and establishes no LZ4 execution coverage.

PG19's live diff output exposed a harness defect: combined stdout/stderr could
obscure status lines, reading 237 tests where PostgreSQL's own summary had 239.
The harness now reads canonical `regression.out` and rejects missing, truncated
or duplicate TAP plans, test names and test numbers. The incomplete recording
attempt was rejected; the eight-run record above uses this corrected reader.

Every changed stable diff was reviewed against upstream's SQL/expected output
and the previous failure cause before accepting the baseline:

| Changed tests                                                                                                                             | Explanation                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create_schema`, `create_function_sql`, `constraints`, `inherit`, `matview`, `merge`, `rules`, `plpgsql`, `copy2`                         | Existing failure bodies are unchanged after removing only hunk coordinates. `publication` likewise retains its sole current-user role-drop failure, with new surrounding test context.                                                                                                                                                                                                                    |
| `type_sanity`, `opr_sanity`, `encoding`, `create_type`, `create_view`, `lock`, `misc`, `indirect_toast`, `conversion`, `compression_pglz` | Existing missing C helpers persist. PG19 adds precise missing-function DETAIL text and changes hunk context. MULE_INTERNAL removal and the new GB18030-2022 case explain encoding/conversion expected-output changes.                                                                                                                                                                                     |
| `misc_functions`, `foreign_data`, new `nls`                                                                                               | New C helpers remain in the unshipped test library: SUPPORT inlining, timing, locale, FDW connection and translation helpers. NLS-disabled mode itself has an upstream fallback and is not the failure cause.                                                                                                                                                                                             |
| `updatable_views`, `privileges`, `cluster`, `guc`                                                                                         | New ON CONFLICT DO SELECT, GRANTED BY, REPACK and GUC checks execute after existing failed authorization resets; ownership, cleanup and permissions cascade. Existing preloaded-PL/pgSQL and zero-worker limitations remain.                                                                                                                                                                              |
| `rowsecurity`                                                                                                                             | New policy-command and self-join-elimination tests leave restricted roles and undeleted fixtures. A surviving one-row table blocks the following 100-row fixture, explaining 400-to-202 UNION output and later column mismatches. New tests that explicitly restore Alice also remove some former missing-table errors. These follow the same reset defect, not a newly demonstrated RLS semantic defect. |
| `stats_ext`, `alter_table`, `partition_prune`                                                                                             | New statistics rendering, description/publication headings, cursor context and InitPlan labels change expected text. The existing authorization, `-O` and disabled-parallel-worker failures remain.                                                                                                                                                                                                       |
| `collate.icu.utf8`                                                                                                                        | Only hunk positions, cursor context and missing-function diagnostics change. ICU 79.1's root-only data still lacks imported language locales; root collation is separately verified by smoke.                                                                                                                                                                                                             |

The final reproducibility acceptance is two `bun run gate --lock` runs from the
same clean commit, with byte-identical `manifest.json` files. Each gate rebuilds,
runs smoke and record checks, then compares a fresh regression run with this
baseline. The accepted gate's files are under `.cache/gate/<commit>/`.

## Adoption after this branch

1. Refresh and qualify the pin when upstream tags the next RC or final release.
2. Publish the builder through the existing workflow and record its digest with
   `builder:lock`; run the published-image gate.
3. Coordinate the host ABI and format-2 store policy in pgxsinkit, then run its
   contract gate on the candidate artefacts.
4. Follow the existing rebase, review, fast-forward and tag release procedure.

### RC publication alongside PG18

The current branch builds PG19 RC1 only. Retaining the PG18 control-file parser
and historical format declaration supports tooling and comparisons; it does not
make the PG19 patches or binaries work as PG18.

The release tooling supports an opt-in `19.0.0-rc.1` GitHub prerelease while
PG18 remains the stable line. Publication follows this path:

1. The release workflow's tag filter and `release:check` accept the exact RC
   candidate derived from the upstream pin. Stable version derivation continues
   to ignore prerelease tags; beta builds remain unpublished.
2. `release:publish` marks RCs as prereleases and explicitly passes
   `--latest=false`, retaining tag verification, checksums and identical-manifest
   checks. These flags are documented by the [GitHub CLI](https://cli.github.com/manual/gh_release_create).
3. RC publication uses the reviewed `port-19` commit without promoting PG19 onto
   main; stable releases retain their existing integration procedure. The CI
   gate runs on port-branch pushes, review PRs and manual dispatch, and must pass
   on that exact commit.
4. Publish builder `6.0.13-p1` from this branch through the builder workflow,
   record its registry digest with `builder:lock`, and qualify the final candidate
   using the published image. The current local-image gates cannot supply the
   release's required published-image manifest.
5. Once the final commit passes its gate, tag that commit `19.0.0-rc.1` and use
   the release workflow to publish the checked assets. Keep PG18's stable release
   available separately.

Publication and host adoption are separate. pgxsinkit's `scripts/pgwasm-pin.ts`
currently accepts only final `N.N.N` tags and refuses a data-format change. An
experimental consumer branch needs prerelease pin support, the host ABI changes
above, an explicit format-2 store policy and its contract/browser checks before
using this build. Publishing an RC alone does not migrate existing stores.

## Further Wasm work to investigate

These are follow-up options from the code audit, not additions to this port or
maintainer policy:

- **Protocol and role correctness:** reproduce the baseline's early
  ReadyForQuery after extended-query errors, and standalone mode's incomplete
  `RESET SESSION AUTHORIZATION`. Fix and tighten their existing baseline groups
  separately rather than recording new failures away. The
  [October PGlite audit](pglite-fixes-2026-10.md) identifies the exact upstream
  readiness fix and confirms that both our PG18 and PG19 branches need it.
- **Browser memory:** pgxsinkit's C host starts at 128 MiB with a 2 GiB maximum.
  Measure smaller starting allocations, growth, OOM handling and stack limits on
  supported browsers. The regression bridge's 256 MiB native stack does not
  establish browser limits.
- **Native Wasm longjmp:** benchmark `SUPPORT_LONGJMP=wasm` against the retained
  `emscripten` setting. [Emscripten documents potential size and speed gains](https://emscripten.org/docs/porting/setjmp-longjmp.html);
  mixed modules, ERROR/FATAL handling and host unwinding need qualification before
  changing the default.
- **Packed OPFS durability:** pgxsinkit's packed OPFS backend now exists, so
  revisit its backlog 0006 strict-durability experiment with that backend and
  current browsers. Measure before choosing a different durability default.

SharedWorker placement, packed OPFS and production shadow-stack restoration are
already implemented in pgxsinkit. Memory64, pthreads and JSPI are larger interface
or architecture changes and need a concrete workload benefit first.
