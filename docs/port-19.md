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

The five patches apply and round-trip on RC1. Builder compilation, the actual
initdb tuple, smoke tests, generated records, pg_regress and the two final engine
gates are pending while this port is being implemented. Replace this paragraph
with measured results before considering the branch complete.

## Adoption after this branch

1. Refresh and qualify the pin when upstream tags the next RC or final release.
2. Publish the builder through the existing workflow and record its digest with
   `builder:lock`; run the published-image gate.
3. Coordinate the host ABI and format-2 store policy in pgxsinkit, then run its
   contract gate on the candidate artefacts.
4. Follow the existing rebase, review, fast-forward and tag release procedure.

## Further Wasm work to investigate

These are follow-up options from the code audit, not additions to this port or
maintainer policy:

- **Protocol and role correctness:** reproduce the baseline's early
  ReadyForQuery after extended-query errors, and standalone mode's incomplete
  `RESET SESSION AUTHORIZATION`. Fix and tighten their existing baseline groups
  separately rather than recording new failures away.
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
