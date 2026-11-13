# PostgreSQL 19 RC2 update assessment

Initially assessed on 2026-11-13 against pgwasm-postgres `port-19` at `4235071`,
which pinned `REL_19_RC1` (`0b8bff042a997fe50fcd1c4c83b9ef1cc9ed8a89`). The
initial assessment below preceded implementation; the final sections record the
authorized update and its qualification.

## Recommendation

Update the existing PG19 port. There are two concrete source/tooling changes before
the normal build-and-release work: allow forward release-candidate transitions in the
bump command, and adapt the exported startup-packet entry point to an upstream C
signature change. Four of the five topic patches apply unchanged to RC2 in an isolated
Git index; the startup export patch needs a deliberate ABI decision.

PostgreSQL released RC2 on November 12. The release includes relevant correctness and
security fixes, and upstream currently plans PG19 general availability for November 19.
This is worth updating even though final release is close. See the
[official announcement](https://www.postgresql.org/about/news/postgresql-187-1712-1616-1520-1425-and-19-rc-2-released-3442/).

## Upstream source and patch compatibility

The fetched upstream tag resolves to
`dffcca2e3c81178c64d4c1f44543a3507d0b7508`, with 293 commits since RC1. The source
comparison is [RC1 to RC2](https://github.com/postgres/postgres/compare/REL_19_RC1...REL_19_RC2).

Application was checked with `git read-tree` and sequential `git apply --cached` in a
separate index under `tmp/agents/pg19-rc2/`, using the existing ignored upstream cache.
The repository index, existing `work/REL_19_RC1`, pin and patches were not changed.
This checks patch application, not compilation or runtime behavior.

| Topic patch                   | RC2 result                                                                  |
| ----------------------------- | --------------------------------------------------------------------------- |
| `0001-build-emscripten`       | Applies; pg_dump Makefile hunks shift by one line.                          |
| `0002-backend-single-process` | Applies; semaphore and file-descriptor hunks shift.                         |
| `0003-startup-packet-export`  | Fails at the startup declarations; upstream changed the function signature. |
| `0004-encoding-shim`          | Applies; pg_dump include hunk shifts by one line.                           |
| `0005-main-loop-unroll`       | Applies; later postgres.c hunks shift by four lines.                        |

### Startup ABI requires attention

Upstream commit
[`f63b47aa`](https://github.com/postgres/postgres/commit/f63b47aa18e6b9b205f51b74d7d5dffe010e8255)
changes `ProcessStartupPacket(Port *)` to
`ProcessStartupPacket(Port *, PendingCancelRequest *)`. Cancellation parsing now fills
that request, and `BackendInitialize()` dispatches it only after the unsafe startup
signal/timeout handlers have been disarmed. This fixes CVE-2026-116322.

Our patch exports that upstream function directly. Both the C repository driver
(`scripts/lib/driver/emscripten.ts`, `scripts/lib/driver/postgres.ts`) and the toolkit
currently call it with one argument. Updating only the patch context and exporting the
new signature would leave callers without storage for the second argument. In
particular, the cancellation-packet branch writes through it.

Prefer preserving the existing one-argument host entry point with a small C wrapper,
while keeping upstream's new internal parsing and safe dispatch arrangement. Its
embedded-session cancellation behavior must be explicit; do not simply pass a null
pointer or reinstate the old pre-authentication dispatch. Alternatively, changing the
exported signature requires coordinated driver and toolkit changes. Review both normal
startup and cancellation behavior, including the hosts' existing cancellation paths.
Update the ABI documentation that currently describes the RC1 signature.

The C driver's `PostgresConnection` ignores `CANCEL_REQUEST` before invoking this
entry point (`scripts/lib/driver/postgres.ts:433`), whereas the toolkit forwards
startup-style messages beginning with zero into the parser
(`packages/pgwasm-c/src/host/postgres-instance.ts:389`). A passing bridge smoke test
could therefore miss this unsafe host call. A wrapper needs a valid, zeroed pending
request and a defined embedded cancellation policy; this assessment does not propose
new cancellation support.

### The bump command currently refuses this update

`scripts/lib/bump.ts` treats an RC pin as having no minor release number and refuses it
before considering the target. It also refuses RC targets. Thus
`bun run bump REL_19_RC2` cannot currently perform this update.

Extend the command's ordering/refusal rules to allow same-major forward RC transitions
and the later RC-to-final transition, while preserving cross-major, equal-version and
downgrade refusals. Then use the normal bump machinery to resolve the tag, apply and
export the series, commit the pin and produce its gate report. Do not hand-edit the pin
as a workaround. Resolve the startup patch through the documented patch work/export
workflow, not by editing the patch file directly.

## Storage and extension compatibility

The upstream diff has no change in `src/include/catalog/catversion.h`,
`src/include/catalog/pg_control.h`, `src/include/access/xlog_internal.h` or
`src/include/pg_config_manual.h`. RC2 still declares catalog version `202610061`.
That supports retaining `dataFormat: 2`, subject to `data-format:check` on the actual
Wasm build. An unchanged tuple does not establish that every RC1 schema or stored
expression remains semantically valid.

Attribute-versioning commit
[`79ddf5bb`](https://github.com/postgres/postgres/commit/79ddf5bb83d835d1a2547919979fe01d3f8c3e36)
is a substantial safety change despite preserving the catalog compatibility number.
It detects unsafe composite-row deformation, introduces an out-of-line
`DatumGetHeapTupleHeader()` and new tuple-descriptor copying APIs, and filters internal
attribute-version options in pg_dump. Rebuild all shipped modules against RC2 and
inspect the resulting export list; do not reuse RC1 extension binaries. The current
build does rebuild its shipped modules together. Any new imports must be traced to
their importing module before updating the export record. Avoid downgrade/re-upgrade
claims: upstream explicitly describes limitations for DDL across such transitions.

The RC2 JSON-constructor volatility revert can invalidate RC1 definitions using arrays,
composites or ranges in expression indexes, generated columns or partition keys.
Upstream says such definitions must be dropped or changed before upgrade. Anton's
previously chosen fresh-store/resync adoption avoids promising a general RC1 migration.
See the announcement's “Changes Since 19 RC1” section linked above.

Keep ICU 79.1 fixed within this major. There is no evidence here that changing the
existing locked Emscripten 6.0.13 builder is required for the PostgreSQL source update;
a toolchain update would be separate work with separate host-glue qualification.

## Fixes with practical value to pgwasm

The official RC2 summary identifies fixes for grouping-set results, `IGNORE NULLS`
window-function hangs, eager aggregation with volatile join expressions, foreign-key
casts and oversized hash execution structures. These affect SQL execution independently
of a multi-process server and are relevant to the embedded build. The release's
standby, parallel-worker and background-process fixes have a different applicability;
the headline vulnerability count is not a count of exploitable pgwasm vulnerabilities.

Source changes also make updating `pgwasm-pg-dump` important:

- [`de7a4a3b`](https://github.com/postgres/postgres/commit/de7a4a3b) correctly quotes
  not-null constraint names in dump SQL.
- [`211e736a`](https://github.com/postgres/postgres/commit/211e736a) protects the tar
  format's `restore.sql` with restrict keys.
- The attribute-versioning change above teaches pg_dump to omit internal attribute
  options from ordinary dumps and preserve versions for binary upgrade.

The upstream `parallel_schedule` also adds four test names relative to RC1:
`portals_inflight`, `alter_column_type`, `rowtypes_alter` and `attribute_version`.
Expect baseline review and classification work, not just changed file hashes. New
failures must be investigated; do not record them away merely because the old baseline
already has known Wasm limitations.

## Build, release and toolkit integration

1. Implement the bump ordering and startup ABI adaptation, then run the C repository's
   normal validation and bump/gate workflow. Investigate every failed smoke check,
   removed core export or changed compatibility tuple before proceeding.
2. Read the gate report, then update only justified export, prepopulated identity and
   regression records through their commands, in the documented order. Review changed
   failures and new tests before recording the multi-run regression baseline.
3. At the final clean commit, obtain two passing engine gates with identical manifests
   and the required CI gate. Publish a new immutable C release `19.0.0-rc.2` through
   `release.yml` when that publication is explicitly authorized. The generic RC release
   workflow already supports this tag; `main` promotion is not required for an RC.
4. In the toolkit, use `bun run pgwasm:pin 19.0.0-rc.2`, then `bun run postinstall` to
   fetch the verified assets. The existing pin command updates both `pgwasm-c` and
   `pgwasm-pg-dump`; they should consume the same C release. Update current-version
   documentation and notices while preserving historical release records.
5. Run the toolkit's cached `bun run validate` and `bun run validate:full`. A toolkit
   RC publication also needs its release CI's integration, IDB/dump browser and OPFS
   browser contracts (Chromium and WebKit). Publish a coordinated toolkit
   `0.6.0-rc.2` at `@rc` if retaining the current release sequence. Source
   `package.json` versions remain `0.0.0`.

The toolkit currently pins `19.0.0-rc.1` with `dataFormat: 2`; its pin and release
scripts already accept generic RC numbers. Its PG19 `CONTINUITY_BUILDS` fixture list
is empty. Qualifying retained RC1 stores would require an explicit continuity fixture
and additional semantic compatibility review; fresh stores/resync do not require
that broader migration promise. The current RC runbook is authoritative over the
older finals-only wording in `docs/port-19.md`'s adoption section.

## Initial assessment limits

Compilation, new dynamic imports, exact regression outcomes, prepopulated image changes
and browser host behavior remain unmeasured. The concrete patch and startup ABI
findings above identify where implementation must begin; they do not predict a green
release gate. No dependency or tool pins were changed for this assessment.

## Implementation and qualification

The checked RC transition and resolved-worktree adoption were added in `54d40d4`.
The update then ran through `bun run bump REL_19_RC2 --resolved --lock`, committing
the pin and generated patch series as `d8a0e66`. Four topic patches are unchanged
apart from their application context; the startup-export topic adds the C adapter
described above. Source `package.json` versions remain placeholders.

The published Emscripten 6.0.13 builder compiled the candidate successfully. Driver
smoke passed normal startup, valid and malformed cancellation refusal, extended-error
recovery, 4,000-error stack recovery, all 27 shipped modules, all 98 default encoding
conversions, ICU collation, amcheck and pg_dump. A fresh initdb confirmed the complete
existing format-2 tuple, including catalog version `202610061` and WAL magic `0xD122`.
The compiler, ICU pin and browser floor were not changed.

The generated glue assigns `Module["_ProcessStartupPacket"]` directly to the Wasm
export. Smoke also requires its function arity to be one: a missing pointer argument
can otherwise become address zero without immediately trapping. Cancellation checks
use key lengths 1, 4, 256, 0 and 257 and verify no handshake output and a successful
subsequent query. They establish the embedded adapter's behavior, not new public
cancellation support in the toolkit.

### Reviewed export changes

The reference now has 1,131 symbols, six additions and one removal. Linked-Wasm
imports were inspected in every shipped module with `wasm-dis`; no mandatory core
export was removed.

| Symbols                                                                 | Importing module                 | Source explanation                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DatumGetHeapTupleHeader`, `heap_datum_check`, `heap_datum_update_type` | `plpgsql.so`                     | Composite-datum safety in [`79ddf5bb`](https://github.com/postgres/postgres/commit/79ddf5bb83d835d1a2547919979fe01d3f8c3e36).                                                                                                                   |
| `PrimaryConnInfo`, `MyBackendType`, `libpqsrv_is_valid_proxy_option`    | `libpqwalreceiver.so`            | Connection-option validation in [`0adbf6bb`](https://github.com/postgres/postgres/commit/0adbf6bb1f4b5d7455ba84bec7bf5d4538487bf9).                                                                                                             |
| Removed `expanded_record_fetch_tupdesc`                                 | No shipped module imports it now | [`4b7a4c2c`](https://github.com/postgres/postgres/commit/4b7a4c2c9e62e94737d0175e5a05173a58d2264e) acquires expanded-record descriptors eagerly, removing the inline accessor's fallback call. The backend compatibility function still exists. |

### Prepopulated directory

The candidate was generated at RC1's published release epoch, `1792895272`, and
compared with that release's archive. Both have 999 entries; 340 entries are
byte-identical. The new tar is 40,782,336 bytes, 245,760 bytes larger; its compressed
asset is 4,473,955 bytes. It boots, has 421 `pg_class` relations and defaults to UTC.

The differences include catalog relations, their indexes, WAL and pointer-bearing
relcache files. Attribute versioning stores `pg_attver` in the existing
`pg_attribute.attoptions` field, deliberately preserving catalog shape; its values
derive from WAL insertion positions rather than wall-clock time. RC2 also adds
`binary_upgrade_set_next_attribute_versions` to `pg_proc` and its description.
Matching epochs therefore does not make RC1 and RC2 catalog bytes or WAL identical.
This comparison does not attribute every changed byte or claim RC1 semantic schema
compatibility. `identity/prepopulated.json` records the new artifacts at that epoch.

### Regression difference review

The initial comparison ran all 243 tests: 188 passed and 55 failed, with no backend
failures. RC1's baseline had 187 passed, 50 failed and two unstable tests across 239
tests. Both previously unstable tests failed in this single comparison. The four
new tests and all changed failing diffs were reviewed before baseline recording.

| Test                                                                         | Actual RC2 difference and reason                                                                                                                                                                                              |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `portals_inflight`, `alter_column_type`                                      | New tests pass.                                                                                                                                                                                                               |
| `rowtypes`                                                                   | Newly fails only on missing `expanded_record_info`, `expanded_record_identity` and `expanded_record_field_text`, defined by `test_setup` using the non-shipped `regress.so`.                                                  |
| `rowtypes_alter`                                                             | New test fails only on the same missing expanded-record helpers. No parallel-plan difference appears in the actual normalized diff.                                                                                           |
| `attribute_version`                                                          | New test cannot define the C helper `make_tuple_unversioned`; its mixed inserts then fail, causing missing-row cascades. This is missing test coverage, not evidence that the composite safety checks fail.                   |
| `test_setup`                                                                 | Three additional `CREATE FUNCTION` statements fail on the same absent test library.                                                                                                                                           |
| `create_function_sql`                                                        | Existing authorization failures remain; upstream adds accepted functions, so its expected cleanup count changes from 38 to 41. Actual cleanup still fails on schema ownership.                                                |
| `constraints`, `inherit`                                                     | Only diff positions move. New constraint cases match expected results; existing authorization failures remain.                                                                                                                |
| `updatable_views`                                                            | New nested security-barrier and hidden-row `ON CONFLICT` cases match expected output. Existing ownership and stale-fixture failures remain; inserted matching cases split their diff hunks.                                   |
| `privileges`                                                                 | New enum-cast cleanup runs after an ineffective `RESET SESSION AUTHORIZATION`, leaving the restricted role active; three ownership errors follow. New security checks themselves match expected output.                       |
| `rowsecurity`                                                                | The new `DROP OWNED` case depends on a role whose creation already failed after the same ineffective reset. Its missing-role/policy cascade replaces an expected warning. New RLS `ON CONFLICT` checks match expected output. |
| `alter_operator`                                                             | New incompatible-commutator rejection matches expected output. Existing ownership failures remain; only hunk positions and boundaries change.                                                                                 |
| `collate.icu.utf8`                                                           | Only a hunk position changes. New Memoize/collation checks match expected output; missing language-specific ICU locales remain the cause.                                                                                     |
| `create_role`, `stats_ext`, `guc`, `copy2`, `alter_table`, `partition_prune` | Diffs are byte-identical after ignoring only hunk headers. Added RC2 cases match expected output; existing authorization, missing test-library, session-persistence and no-worker limitations remain.                         |
| `dependency`                                                                 | The existing failed reassignment now reports `must be able to SET ROLE` after upstream changes its privilege check; the ineffective authorization reset remains the cause of the unexpected refusal.                          |
| `cluster`                                                                    | New aborted-subtransaction rewrite coverage matches expected output. A matching cleanup statement appears as context; existing permission failures remain unchanged.                                                          |

The three additional failing test names belong to the existing `regress-library`
group, with the new helper dependencies documented there. No old limitation was
fixed or hidden as part of this update. Eight repeated runs recorded 188 passed,
53 stable failures and two unstable programs across 243 tests. Every run had the
same pass/fail counts and no backend failures; only the existing `stats` and
`subscription` diffs varied. Release acceptance still requires the clean-commit
engine gates, identical manifests and the published-image release workflow.
