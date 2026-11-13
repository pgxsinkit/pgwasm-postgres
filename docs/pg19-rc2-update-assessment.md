# PostgreSQL 19 RC2 update assessment

Assessed on 2026-11-13 against pgwasm-postgres `port-19` at `4235071`, which pins
`REL_19_RC1` (`0b8bff042a997fe50fcd1c4c83b9ef1cc9ed8a89`). This is an assessment,
not a completed upgrade: no engine build, regression run, release or toolkit pin change
was performed.

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

## Remaining uncertainty

Compilation, new dynamic imports, exact regression outcomes, prepopulated image changes
and browser host behavior remain unmeasured. The concrete patch and startup ABI
findings above identify where implementation must begin; they do not predict a green
release gate. No dependency or tool pins were changed for this assessment.
