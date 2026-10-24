# PGlite fixes reviewed on 2026-10-24

The useful changes are one C backend fix for both Postgres branches and three
host fixes in the sibling `pgxsinkit` repository. No fix is implemented by this
review. Apply the extended-query recovery fix first; the host changes can follow
independently of the PG19 port.

## Scope and evidence

Reviewed all 24 commits returned by GitHub's main-branch commit API with
`since=2026-09-01T00:00:00Z`, including their changed-file lists and the relevant
implementation diffs. The newest is `e752dbe0a550ee74e5e175ae799e556758201682`
(October 23); the oldest is `d9eadc63cf16db6d40fd13b5cf2c06e2e645fbd9` (October 6).
There were no September commits in this result. The inventory below includes
version-only, documentation and extension changes, not just commits titled fixes.
Source: [GitHub commit API](https://api.github.com/repos/electric-sql/pglite/commits?sha=main&since=2026-09-01T00:00:00Z&per_page=100).

Local source snapshots inspected without switching branches:

- `pgwasm-postgres` develop: `22df204af7f2251a09f6f58f80506d872c8324f6`,
  pinned to `REL_18_6`.
- `pgwasm-postgres` port-19: `c30ea802da903448beb2fbaf302fc9b784e455b3`,
  pinned to `REL_19_RC1`.
- Sibling `pgxsinkit`: `d0308b6870d9aa07163377d9d8192e97e1815324`.
  Its common TypeScript host would need the same fixes whether it drives PG18
  or adopts PG19. This audit does not claim the existing host already supports
  the renamed PG19 C ABI.

## Recommended work

| Order | Fix                                                    | PG18 develop                                | PG19 port                                   | Impact                                                       |
| ----- | ------------------------------------------------------ | ------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------ |
| 1     | Schedule readiness after extended-query error recovery | Applicable; defect present                  | Applicable; defect present                  | High: wire desynchronization after ordinary query errors     |
| 2     | Set UTC in initdb's module environment                 | Applicable to host and normal driver initdb | Applicable to host and normal driver initdb | Medium: host-dependent defaults and timestamp interpretation |
| 3     | Decode parameter counts as unsigned 16-bit             | Applicable in sibling host                  | Applicable in sibling host                  | Medium, bounded to queries with at least 32,768 parameters   |
| 4     | Deallocate windowed live-query count statement         | Applicable in sibling live layer            | Applicable in sibling live layer            | Lower: prepared-statement leak over repeated subscriptions   |

### 1. Extended-query recovery: take the C fix on both branches

[PGlite #1144 / 4321a415](https://github.com/electric-sql/pglite/commit/4321a415ea9260931ed8e74fed1b6c335d10c09f)
updates its C submodule and adds raw-protocol and node-postgres regression tests.
The actual fix is
[5daf4db6](https://github.com/electric-sql/postgres-pglite/commit/5daf4db6e7b1cb718d420adb3dd326f1e6d0db14),
subsequently retained as
[29b6424a / postgres-pglite #96](https://github.com/electric-sql/postgres-pglite/commit/29b6424aa312ec3556247db069939006dd27f878).

The longjmp wrapper sets `send_ready_for_query` while `ignore_till_sync` still
has its pre-recovery value. Error cleanup establishes the skip-until-Sync state
later. This can send a premature or duplicate ReadyForQuery and make clients
associate later responses with the wrong query. Upstream removes that assignment
from `pgl_longjmp` and schedules readiness at the end of
`PostgresMainLongJmp`, after `RESUME_INTERRUPTS`, only when
`!ignore_till_sync`.

Both local overlays still perform the early assignment:
`develop:overlay/pglite/src/pglitec/pglitec.c` and
`port-19:overlay/pgwasm/src/pgwasmc/pgwasmc.c` (`pgl_longjmp` /
`pgwasm_longjmp`). Both `0005-main-loop-unroll` patches split out recovery
without the upstream fix's final readiness assignment. This is also the existing
early-ReadyForQuery defect recorded in ADR-0001 decision 6 and the regression
baseline, rather than a newly inferred failure.

Adapt the small behavior change to each branch's own names and minimal-surface
patch. Do not copy upstream's rewritten `postgres.c`. Change the topic worktree,
export the patch, and add a driver regression covering Parse/Bind/Execute error,
Flush before Sync, Sync, and a successful bound query afterwards. Assert no
ReadyForQuery before Sync and exactly one afterwards. Re-run both branches'
engine gates and investigate the improved psql baselines before re-recording.
No on-disk format or exported-symbol change is implied by this fix.

### 2. initdb timezone: applicable, with a deterministic-build qualification

[e752dbe0 / #1156](https://github.com/electric-sql/pglite/commit/e752dbe0a550ee74e5e175ae799e556758201682)
sets `mod.ENV.TZ = 'UTC'` in initdb, matching the backend. The upstream test
initializes under `America/New_York` and verifies the resulting configuration.
Previously initdb could write a fixed-offset zone to `postgresql.conf`, giving
different interpretations of offset-free `timestamptz` input across hosts.

Our production host has the same missing setting:
`pgxsinkit/packages/pgwasm-c/src/host/initdb.ts` sets PGDATA/HOME/USER/LOGNAME/
ICU_DATA but no TZ, while `postgres-instance.ts` sets both TZ and PGTZ to UTC.
Both branches' own `scripts/lib/driver/initdb.ts` also omit TZ while their backend
driver sets it. Set UTC explicitly on the initdb module and test non-UTC creation;
test `SHOW TimeZone`, configuration and an offset-free timestamp, including a DST
date. Existing stores' configuration will not be repaired by changing initdb.

The deterministic prepopulated release asset is a separate case:
`scripts/lib/driver/determinism.ts` already sets the process timezone to UTC
before deterministic generation. That prevents host-dependent generation today;
do not describe the existing prepopulated asset as unqualified. Explicit module
TZ may still alter its chosen timezone spelling and therefore its bytes, so
compare the asset before deliberately updating its identity record. Runtime
reproduction of this issue in our build was not performed in this audit.

### 3. ParameterDescription decoding: confirmed in the sibling host

[f75ff110 / #1123](https://github.com/electric-sql/pglite/commit/f75ff110b20dd83446c16cde6cb9f77c83cd3e85)
adds unsigned reader/writer methods and uses them for ParameterDescription's
count and Bind's counts.

Our `pgxsinkit/packages/pgwasm/src/protocol/wire/parser.ts` still reads
ParameterDescription with `BufferReader.int16()`. A direct, database-free probe
of the actual parser confirmed: 32,767 type OIDs decode correctly, while 32,768
and 65,535 both decode as zero OIDs. This can discard parameter type information
used by query encoding. The backend major is irrelevant to this TypeScript bug.

Use unsigned decoding and add boundary coverage. Changing Bind serialization to
`addUint16` also expresses the right wire contract, but do not claim its current
`DataView.setInt16` encoding corrupts valid counts above 32,767: for integer
counts through 65,535 it emits the same lower 16 bits. Rejecting counts above the
protocol maximum is a separate guard worth considering. Do not globally change
all signed 16-bit reads: fields such as type size have meaningful negative values.

### 4. Windowed live-query cleanup: applicable in the sibling live layer

[78012cad / #1108](https://github.com/electric-sql/pglite/commit/78012cadabf2859e4e145a293bcd4af3df8fca71)
conditionally deallocates `live_query_<id>_get_total_count` when the final
subscriber leaves a windowed query, in addition to its main prepared statement.

Our `pgxsinkit/packages/pgwasm/src/live/index.ts` prepares and executes the count
statement for windowed queries but its `unsubscribe` only deallocates
`live_query_<id>_get`. Dropping the view does not deallocate the separate prepared
statement. Repeated teardown can therefore retain statements until the database
session ends. Add the conditional cleanup and test repeated windowed teardown,
zero-valued offset/limit, non-windowed teardown and an unaffected concurrent live
query. This is a host resource-lifetime fix, not a C-branch patch or demonstrated
data-corruption issue.

## Already covered or not directly transferable

- **Close and data-directory dump locking**:
  [cb06c218 / #1140](https://github.com/electric-sql/pglite/commit/cb06c218bcf1886866c00c5c1b47d06fd991f14d),
  [367ee2f0 / #1143](https://github.com/electric-sql/pglite/commit/367ee2f05b09ae2f8fbfdfa692b0f1b23c6af8cb),
  [5573bb0d / #1149](https://github.com/electric-sql/pglite/commit/5573bb0d4c33450e4aaaf51efeabbc02fef39a2f)
  add query-mutex protection and wait for initialization outside close's mutex.
  Our rewritten `core/pgwasm.ts` already checks readiness before close, takes
  transaction/query locks before shutdown, waits for persistence before release,
  and reads dump entries under its query lock. No direct backport is needed.
  This is a source comparison, not proof that every possible queued-close or
  paused-transaction backup interleaving is correct.
- **Multiple live subscribers**:
  [cd17853b / #1141](https://github.com/electric-sql/pglite/commit/cd17853b0d393b5f0cf974d0482e5d6297fb9470)
  is a test addition; local unsubscribe already removes only the named callback
  and tears down when the callback list is empty. The preceding
  [35f363bd / #1142](https://github.com/electric-sql/pglite/commit/35f363bd57f84fb5daf4cfe4eb45e19ec6a4539e)
  has no changed files. The tests are useful coverage examples, not additional
  missing implementation fixes.
- **OPFS handle-map consolidation**:
  [816cf904 / #1135](https://github.com/electric-sql/pglite/commit/816cf904e69e23ac41aa90a7167c1358ba38343a)
  pairs file and access handles in upstream's access-handle pool. Our OPFS uses
  the separately implemented packed-filesystem/broker architecture, not that
  `opfs-ahp.ts`; this refactor is not a patch for our storage implementation.
- **PG18.6/toolchain/host modernization**:
  [389b731d / #1117](https://github.com/electric-sql/pglite/commit/389b731d328bbe39dc7b056c2eca5851d1906081)
  includes the PG18.6 bump, shadow-stack restoration, module/runtime updates,
  pg_dump and filesystem changes. Our PG18 pin is already 18.6; PG19 carries
  the port. Both build drivers and the sibling C host already restore the
  shadow stack. Its backend loader already orders preRun after bundle loading,
  and the sibling pg_dump runs in a fresh module with explicit session recovery.
  No missing fix was identified from these portions. New extension packages and
  their exports are outside our shipped amcheck-only extension set.
- **Intermediate C socket/toolchain change**: the submodule move in #1140 includes
  [6af777aa](https://github.com/electric-sql/postgres-pglite/commit/6af777aaeb4e7c1c177f7e3912693fd2c243f20f),
  whose socket override returns descriptor 10, and a move to Emscripten 6.0.12.
  Both local C branches already use an actual `/dev/null` descriptor for this
  emulation and have separately qualified toolchains (6.0.10 for PG18, 6.0.13
  for PG19). Do not replace that with an
  arbitrary descriptor or copy upstream's build flags wholesale. The later
  [2372f39c / #1152](https://github.com/electric-sql/pglite/commit/2372f39c682805d499e8cba9d6be8617c1520ebb)
  points at 29b6424a, retaining the readiness fix on its other submodule line.

## Complete main-commit inventory

Each abbreviated SHA links to its implementation or changed-file list. The three
version commits only publish the changes already reviewed above.

| Date   | Commit                                                                                             | Disposition                                                                   |
| ------ | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Oct 23 | [e752dbe0](https://github.com/electric-sql/pglite/commit/e752dbe0a550ee74e5e175ae799e556758201682) | initdb UTC: applicable                                                        |
| Oct 21 | [967432ba](https://github.com/electric-sql/pglite/commit/967432ba0e8d2c71e0c9899edc1325bd8d68d6e8) | Package/CI cleanup and extension moves; no missing core fix identified        |
| Oct 21 | [f3820232](https://github.com/electric-sql/pglite/commit/f38202322fc56f2ee231598c2b2a168b5658422f) | Version packages                                                              |
| Oct 21 | [286cfdec](https://github.com/electric-sql/pglite/commit/286cfdec90639c5312e39042b4c8879693077aa9) | node-postgres documentation                                                   |
| Oct 21 | [5d3832fb](https://github.com/electric-sql/pglite/commit/5d3832fb287be271ae39c465e83991aaab6db2a0) | Experimental node-postgres adapter; new feature, no backport needed           |
| Oct 21 | [2372f39c](https://github.com/electric-sql/pglite/commit/2372f39c682805d499e8cba9d6be8617c1520ebb) | Submodule to 29b6424a: same recovery fix                                      |
| Oct 21 | [4321a415](https://github.com/electric-sql/pglite/commit/4321a415ea9260931ed8e74fed1b6c335d10c09f) | Extended-query recovery: applicable                                           |
| Oct 19 | [5573bb0d](https://github.com/electric-sql/pglite/commit/5573bb0d4c33450e4aaaf51efeabbc02fef39a2f) | Initialization before close: already covered                                  |
| Oct 14 | [550943fb](https://github.com/electric-sql/pglite/commit/550943fbca8c40a0185a2d02d11afdcea97fa869) | Version packages                                                              |
| Oct 14 | [367ee2f0](https://github.com/electric-sql/pglite/commit/367ee2f05b09ae2f8fbfdfa692b0f1b23c6af8cb) | Dump query locking: already covered                                           |
| Oct 14 | [35f363bd](https://github.com/electric-sql/pglite/commit/35f363bd57f84fb5daf4cfe4eb45e19ec6a4539e) | No changed files                                                              |
| Oct 14 | [cb06c218](https://github.com/electric-sql/pglite/commit/cb06c218bcf1886866c00c5c1b47d06fd991f14d) | Close locking covered; intermediate C build changes inspected                 |
| Oct 14 | [cd17853b](https://github.com/electric-sql/pglite/commit/cd17853b0d393b5f0cf974d0482e5d6297fb9470) | Multiple-subscriber test only                                                 |
| Oct 13 | [4470a5df](https://github.com/electric-sql/pglite/commit/4470a5df0e2bbe1fd6b0dc80fdf537fc11e92b57) | Node CI matrix; no core fix                                                   |
| Oct 13 | [9c7555a0](https://github.com/electric-sql/pglite/commit/9c7555a07fdf0c5e73c82b6d79356edb5eaa780a) | Socket package name/docs correction; package not used here                    |
| Oct 13 | [816cf904](https://github.com/electric-sql/pglite/commit/816cf904e69e23ac41aa90a7167c1358ba38343a) | OPFS refactor; different implementation                                       |
| Oct 12 | [88672bf5](https://github.com/electric-sql/pglite/commit/88672bf53f357bd1b9c9efc8d074c38cb3a3b4e4) | New pg_partman package; not shipped here                                      |
| Oct 12 | [27a8b87b](https://github.com/electric-sql/pglite/commit/27a8b87b63997e191b70841ea1666fba0659381c) | C submodule adds SQL-only pg_partman; not shipped here                        |
| Oct 12 | [78012cad](https://github.com/electric-sql/pglite/commit/78012cadabf2859e4e145a293bcd4af3df8fca71) | Window count statement leak: applicable                                       |
| Oct 12 | [f75ff110](https://github.com/electric-sql/pglite/commit/f75ff110b20dd83446c16cde6cb9f77c83cd3e85) | Unsigned count: applicable                                                    |
| Oct 12 | [65996e8e](https://github.com/electric-sql/pglite/commit/65996e8eb49f779481a33b4d4161a389ce6ecb84) | PostGIS license declaration; PostGIS not shipped here                         |
| Oct 12 | [11df48e2](https://github.com/electric-sql/pglite/commit/11df48e283ed556441a101707088f3235d58a32a) | Version packages                                                              |
| Oct 12 | [389b731d](https://github.com/electric-sql/pglite/commit/389b731d328bbe39dc7b056c2eca5851d1906081) | PG18.6 and modernization: inspected, already covered or outside shipped scope |
| Oct 6  | [d9eadc63](https://github.com/electric-sql/pglite/commit/d9eadc63cf16db6d40fd13b5cf2c06e2e645fbd9) | Sync mapColumns documentation                                                 |

Validation for this research: source/diff comparison and the actual local parser
boundary probe above. No C rebuild, database timezone reproduction or full test
suite was run; no implementation or dependency changed.
