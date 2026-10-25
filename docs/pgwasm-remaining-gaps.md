# Known pgwasm gaps and the value of addressing them

Assessment date: 2026-10-25. Scope: the known PostgreSQL regression failures,
PG19 adoption work, and Wasm follow-ups identified during the October review.
This is not a claim to enumerate every possible defect in PostgreSQL, PGlite or
the wider pgxsinkit toolkit.

The remaining failures do not establish that ordinary client queries fail at a
roughly 22% rate. They combine a few real compatibility defects, missing test
fixtures, configuration differences and capabilities an embedded single-process
database does not provide. Several deserve work, but their urgency depends on
which capability an application uses. The evidence reviewed here does not
demonstrate silent data corruption in the toolkit's ordinary CRUD/sync path.

Priority needs to follow client exposure. In particular, the
session-authorization failure is not evidence that the toolkit's
normal security boundary is broken, and the JSON regression mismatch does not
by itself show that normal JSON input crashes clients. Those distinctions matter
when deciding what to fix next.

## What the numbers mean

After the October correctness fixes, eight native regression runs on each branch gave:

| Branch           | Upstream     | Test programs | Passed | Stable failures | Unstable programs | Failures observed per run |
| ---------------- | ------------ | ------------: | -----: | --------------: | ----------------: | ------------------------: |
| `develop` / PG18 | `REL_18_6`   |           231 |    180 |              49 |                 2 |                        51 |
| `port-19` / PG19 | `REL_19_RC1` |           239 |    187 |              50 |                 2 |                        52 |

Only `stats` and `subscription` remain unstable; their diffs vary. Both `psql`
and `psql_pipeline` now pass every run. The other stable failure diffs did not
change. The branch's [baseline](../regress/baseline.json) records the results and
primary causes; [the recorded diffs](../regress/diffs/) show the actual output
differences. Read those paths on the branch named in the table.

Each entry is a substantial test program, often containing many assertions. One
failed assertion makes the whole program fail, and a missing fixture or incorrect
role can produce many later errors. Conversely, an upstream program can pass by
skipping an unavailable capability: PG19's `compression_lz4` result does not
establish LZ4 execution coverage. A passing engine gate means the build satisfies
its smoke/export/format/identity checks and matches this documented regression
baseline. It does not mean all native PostgreSQL tests pass.

The groups below assign each failing program one primary cause; some contain
secondary failures too. Counts must not be interpreted as independent bugs or
added to estimates of affected clients.

| Primary cause                           |   PG18 |   PG19 | Kind of work                                        | Main benefit                                                          |
| --------------------------------------- | -----: | -----: | --------------------------------------------------- | --------------------------------------------------------------------- |
| Session-authorization reset             |     21 |     21 | Embedding compatibility fix                         | Correct reset semantics and usable role-dependent regression fixtures |
| Missing C regression helpers            |     18 |     19 | Test/build infrastructure                           | More real coverage and fewer fixture-induced cascades                 |
| Reused session in the bridge            |      3 |      3 | Harness isolation / session capability              | More faithful reconnect and session-lifecycle tests                   |
| Background/parallel process assumptions |      3 |      3 | Capability decision; potentially architectural      | Parallel plans and native worker-dependent features if needed         |
| Recursion / stack-depth mismatch        |      2 |      2 | Resource-limit investigation and hardening          | Predictable handling of unusually deep input                          |
| Root-only ICU data                      |      1 |      1 | Optional feature/data packaging                     | Language-tailored SQL collations                                      |
| Startup defaults                        |      1 |      1 | Configuration review                                | Intentional, documented schema-resolution/catalog behavior            |
| Clock/statistics behavior               |      1 |      1 | Timing/statistics fidelity                          | Better diagnostic precision and more stable reset comparisons         |
| WAL receiver/libpq linkage              |      1 |      1 | Linkage fix, then a replication capability decision | Correct connection handling; groundwork for an optional capability    |
| **Total**                               | **51** | **52** |                                                     |                                                                       |

## Why this can coexist with PGlite being useful and widely adopted

PGlite's documented model is an embedded application database, including use with
a subset of a server database. Its own documentation explicitly describes one
exclusive connection and provides a worker that shares that instance between
tabs. Full ICU locale data is a separate optional package. These are supported
workload boundaries, not evidence that common SQL operations are generally
unreliable. [PGlite overview](https://pglite.dev/docs/about),
[single-connection usage](https://pglite.dev/docs/),
[worker sharing](https://pglite.dev/docs/multi-tab-worker),
[locale packaging](https://pglite.dev/docs/localesupport).

It is therefore reasonable to question an inference from a native-server test
failure to an urgent application defect. Adoption can coexist with limitations
that most applications never exercise. It also cannot prove that an edge case is
correct. No user/download count was verified for this assessment, and none is
needed for that reasoning.

Our build and host have also diverged from PGlite. For example, this repository
deliberately ships `amcheck` and PostgreSQL's core modules, rather than PGlite's
broader third-party extension catalogue. An application's experience with a
different PGlite version, extension set or filesystem does not establish this
build's exact behavior. See [the build contract](../README.md#layout) and
[ADR-0001](adr/0001-postgres-as-a-patch-series.md).

For pgxsinkit, the normal topology is server PostgreSQL → Circuits → durable
streams → the local pgwasm applier. The server remains the integrity/security
authority and local RLS is explicitly outside the parity boundary. The local
engine serializes queries and transactions. This substantially narrows the
exposure to native server-session and replication features. It does not excuse
incorrect behavior when the lower-level SQL API exposes those features.
[Toolkit topology and parity boundary](https://github.com/pgxsinkit/pgxsinkit/blob/d0308b6870d9aa07163377d9d8192e97e1815324/CONTEXT.md),
[query/transaction serialization](https://github.com/pgxsinkit/pgxsinkit/blob/d0308b6870d9aa07163377d9d8192e97e1815324/packages/pgwasm/src/core/pgwasm.ts).

## The remaining regression gaps

### 1. Session authorization: a real, narrowly triggered compatibility defect

**Observed:** standalone initialization leaves `session_authorization` without a
reset value. After `SET SESSION AUTHORIZATION`, `RESET SESSION AUTHORIZATION` or
`SET SESSION AUTHORIZATION DEFAULT` fails to restore the original user. The
regression programs then remain in a restricted role when they expect to regain
the superuser; permission, ownership and cleanup failures cascade. This is not
21 separate security defects or evidence of privilege escalation. See the
`session-authorization` group in the [baseline](../regress/baseline.json).

**Client trigger:** SQL explicitly using that session-authorization sequence.
The reviewed production paths do not issue it. The `username` option uses the
different command `SET ROLE`, and existing unit tests verify that option's
permission behavior. The broken reset therefore does not establish a broken
`username` API, RLS evaluator or ordinary toolkit security boundary.
[Role setup](https://github.com/pgxsinkit/pgxsinkit/blob/d0308b6870d9aa07163377d9d8192e97e1815324/packages/pgwasm/src/core/pgwasm.ts#L248),
[role-permission tests](https://github.com/pgxsinkit/pgxsinkit/blob/d0308b6870d9aa07163377d9d8192e97e1815324/tests/unit/pgwasm-user.test.ts).

**Value of fixing:** honor the exposed SQL command and restore meaningful
role-dependent test coverage, including the RLS tests currently contaminated by
bad fixtures. This looks like targeted initialization/compatibility work, not a
multi-process redesign, but the reset and role-stack semantics need regression
tests. It is a sensible bounded follow-up for confidence; urgency rises if an
application uses session authorization. Fixing it may reveal additional failures
currently hidden by the first wrong-role error.

### 2. Missing regression helpers: primarily a coverage gap

**Observed:** the gate omits PostgreSQL's test-only `regress.so`. C functions such
as `binary_coercible`, the widget type handlers and test compression/encoding
helpers cannot be created. Assertions using those fixtures fail or cannot reach
their intended path. PG19 adds helpers, including the translation test, to this
same limitation. This does not show that ordinary conversions, triggers,
compression or type creation are generally broken. Those test programs can
still execute unrelated assertions; the helper-dependent coverage is what is
blocked. See `regress-library` in the [baseline](../regress/baseline.json).

**Value of fixing:** obtain substantially better evidence about the engine and
identify any real defects behind the fixture failures. It cannot responsibly be
sold as a guaranteed gain of 18/19 passing programs. Work is in the test module's
build, imports and backend export contract. The project deliberately builds what
it ships; a test-build/export strategy should be explicit rather than silently
expanding the production extension contract just to turn tests green.

This is useful engineering assurance, not an observed reason for ordinary
clients to fail. It should accompany compatibility cleanup so that later claims
about SQL coverage are stronger.

### 3. Session reuse and worker processes: separate two different problems

The bridge handles psql reconnects by resetting the same backend. That does not
reproduce a fresh native session: login triggers do not run, temporary-buffer
state persists, and a previously loaded PL/pgSQL module has already reserved its
prefix. Prepared transactions are also disabled by the default configuration.
Improving bridge isolation/restart behavior would make these tests more useful;
it would not automatically add independent concurrent sessions to the product.
[Bridge design and limitations](adr/0001-postgres-as-a-patch-series.md).

Separately, the embedded backend has no background or parallel workers and
explicitly sets their counts to zero. Worker-dependent tests therefore cannot
obtain the native plans or process activity they expect. Ordinary queries still
run serially; the cost is unavailable server capabilities and possible missed
parallel performance, not a demonstrated incorrect result from every query in a
failing program. [Production start parameters](https://github.com/pgxsinkit/pgxsinkit/blob/d0308b6870d9aa07163377d9d8192e97e1815324/packages/pgwasm-c/src/host/postgres-instance.ts#L19).

Full worker/multi-session support is potentially architectural work. It should
be justified by a concrete application workload, not undertaken solely for the
native pass percentage. Better test-session isolation is the smaller and more
immediate opportunity.

### 4. Recursion limits: establish the supported-runtime boundary

**Observed now:** `json`/`jsonb` feed malformed input with 10,000 nested open
containers. The build rejects it as invalid JSON where native PostgreSQL expects
a stack-depth error. The recorded mismatch does not show acceptance of invalid
JSON, wrong stored JSON or a current crash in the raised-stack bridge.
[JSON diff](../regress/diffs/json.diff), [JSONB diff](../regress/diffs/jsonb.diff).

**Earlier observation:** the default Bun/native stack could overflow before
PostgreSQL's guard. The guard measures the Wasm shadow stack, while recursion can
consume the host's native stack. Raising the bridge's stack made the regression
result stable; it did not establish browser safety. Exact failure thresholds on
supported browsers remain unmeasured. [Recorded investigation](adr/0001-postgres-as-a-patch-series.md).

The current host treats an unexpected exception as a failed instance rather than
swallowing it as a normal PostgreSQL unwind. Thus instance failure/resource
exhaustion is the relevant concern to investigate; silent corruption was not
demonstrated here. [Failure handling](https://github.com/pgxsinkit/pgxsinkit/blob/d0308b6870d9aa07163377d9d8192e97e1815324/packages/pgwasm-c/src/host/postgres-instance.ts#L437),
[RangeError classification test](https://github.com/pgxsinkit/pgxsinkit/blob/d0308b6870d9aa07163377d9d8192e97e1815324/tests/unit/pgwasm-c-unwind.test.ts#L39).

**Value of fixing:** predictable limits and controlled errors for exceptionally
deep JSON/recursive workloads. First reproduce and bound the risk on actual
supported runtimes. Urgency is higher for applications accepting untrusted,
deeply nested data or arbitrary recursive SQL; this evidence alone does not make
it an unconditional blocker for ordinary embedded workloads.

### 5. Locale data, defaults and clock precision

- **ICU:** only root Unicode data is bundled, so language-tailored collations
  such as the locale names used by the upstream test are unavailable. Root
  collation is exercised separately. Adding selected/full data would benefit
  applications requiring SQL language-specific sorting, at a download/packaging
  cost. Keep ICU/index compatibility explicit; do not silently change existing
  indexed collation behavior. This is an optional feature boundary, also present
  in PGlite's separately packaged full ICU model. Expanded data must match our
  pinned ICU 76.1 on PG18 or 79.1 on PG19 and our packaging. The upstream package
  illustrates the choice; it is not a qualified drop-in replacement for this build.
  [Baseline](../regress/baseline.json),
  [upstream locale packaging](https://pglite.dev/docs/localesupport).
- **Defaults:** `search_path=public` differs from native's user-schema lookup;
  `-O` also permits catalog changes that a native test expects refused. Review
  whether inherited settings are necessary and document intentional differences.
  Removing them merely for test parity could change existing application
  behavior. The benefit is predictable configuration and a smaller unnecessary
  capability surface, not a demonstrated remote security repair.
  [Start parameters](https://github.com/pgxsinkit/pgxsinkit/blob/d0308b6870d9aa07163377d9d8192e97e1815324/packages/pgwasm-c/src/host/postgres-instance.ts#L19).
- **Clock/statistics:** two resets can fall in one millisecond and fail a strict
  “later than” assertion. Missing native process statistics also contribute.
  Better timing precision/statistics would improve diagnostics and native
  fidelity; the failures do not demonstrate incorrect ordinary row values.
  Explicit timestamp values retaining PostgreSQL precision is a different claim
  from the resolution of the clock used to generate current timestamps.
  [Clock group](../regress/baseline.json).

### 6. WAL receiver and failed-module recovery

**WAL receiver:** `libpqwalreceiver.so` loads, but its static libpq is incorrectly
linked to backend rather than frontend helpers. Connection handling fails its
link canary. Repairing the linkage would improve correctness and let the test
progress; it would not by itself prove working browser logical subscriptions,
which also need a viable transport/worker model. The normal toolkit read path
uses Circuits streams and a local applier, not `CREATE SUBSCRIPTION` in the
embedded database. Prioritize broader replication support only if an application
actually requires it. [Baseline](../regress/baseline.json),
[toolkit topology](https://github.com/pgxsinkit/pgxsinkit/blob/d0308b6870d9aa07163377d9d8192e97e1815324/CONTEXT.md).

**Failed `dlopen`:** earlier PG18 qualification observed that a failed module
load could poison later loads until restart. The current regression gate omits
the unavailable helper file before reaching that failure mode; the historical
import count and loader behavior were not remeasured on PG19. Reproduce on the
current toolchains before asserting that both builds still have this defect.
If present, fixing it would let clients recover after an unavailable/incompatible
extension attempt. All shipped modules are loaded by smoke tests; this remains
particularly relevant to extending the module set, not evidence that normal
loads of those shipped modules currently fail. [Historical evidence](adr/0001-postgres-as-a-patch-series.md),
[current qualification limits](../regress/baseline.json).

## PG19 adoption work, distinct from PG18 defects

The port changes the C export names and startup ABI, and declares data format 2
where PG18 uses format 1. An old data directory cannot be opened directly by the
new major. The consuming host needs its ABI update, prerelease pin support and a
chosen store transition: for example, a controlled re-sync after pending writes
are drained, or a dump/restore migration. Its pin command currently refuses a
data-format change. That refusal is protective, not an accidental compatibility
failure. [Build permanence](https://github.com/pgxsinkit/pgxsinkit/blob/d0308b6870d9aa07163377d9d8192e97e1815324/docs/adr/0063-build-permanence-and-storage-build.md),
[adoption contract](https://github.com/pgxsinkit/pgxsinkit/blob/d0308b6870d9aa07163377d9d8192e97e1815324/docs/adr/0064-c-build-supply-chain.md).

Consumer unit, integration and browser/storage lanes then need to qualify the
candidate. Driver filesystem aliases and Bun smoke tests alone do not qualify
browser persistence after adoption. Publishing also requires the builder's
registry digest and the CI/tag release checks. Benefits are access to the new
major and a tested upgrade route; this work is required before adopting PG19,
not a reason to rewrite a working PG18 store immediately. The branch-specific
port details remain in `docs/port-19.md` on `port-19`.

The current RC workflow models one immutable publication per upstream RC,
such as `19.0.0-rc.1`. Publishing a revised pgwasm build of that same upstream
RC would need an agreed revision-tag scheme and corresponding version tests;
replacing the existing tag or assets is not the solution. That is release-process
work if a second build is needed before the next upstream RC, rather than a
blocker to the first RC publication.

## Measurement and coverage opportunities, not established defects

| Opportunity                           | Evidence and limits                                                                                                                                                                                                            | What the work would buy                                                                                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser memory, growth and OOM        | The C host creates 128 MiB initial linear memory with a 2 GiB maximum. That is not a measurement of resident memory or proof of excessive usage. Actual mobile/browser limits and failure behavior need workload measurements. | Evidence for changing allocations/limits, predictable resource failure, and budgets for multiple stores. Avoid promising a memory saving before measuring. |
| Wasm-native longjmp                   | The build retains `SUPPORT_LONGJMP=emscripten`. Emscripten documents possible size/performance gains from `wasm`, with runtime and mixed-module requirements. Current handled-error stack restoration already exists.          | A benchmarked optimization if it wins, after ERROR/FATAL, module and browser qualification; it is not a known missing correctness fix.                     |
| Packed OPFS durability costs/defaults | Strict and relaxed modes have explicit different contracts. Existing fault-injection and real-browser tests cover substantial crash/reopen behavior. `fsync=off` does not mean the host performs no persistence.               | Measurements of latency, throughput and recovery tradeoffs to inform a deliberate default; not repair of a demonstrated current corruption problem.        |
| OPFS WAL-segment transition coverage  | The documented crash matrix uses preallocated WAL and explicitly does not cover a segment switch requiring file creation/rename through metadata.                                                                              | Stronger crash/recovery evidence across that transition. This is a coverage gap; no failure of that transition has been demonstrated.                      |

Sources: [memory construction](https://github.com/pgxsinkit/pgxsinkit/blob/d0308b6870d9aa07163377d9d8192e97e1815324/packages/pgwasm-c/src/host/postgres-instance.ts#L14),
[Emscripten longjmp modes](https://emscripten.org/docs/porting/setjmp-longjmp.html),
[OPFS testing and limits](https://github.com/pgxsinkit/pgxsinkit/blob/d0308b6870d9aa07163377d9d8192e97e1815324/packages/pgwasm/docs/opfs/testing-strategy.md).

The persistence distinction matters: strict mode waits for the required host
storage barrier before returning; relaxed mode can return before background
persistence completes. If unflushed writes do not survive a failure, relaxed
mode admits a loss window. That is its stated contract, not by itself a bug.
The host/VFS owns these barriers because guest fsync is disabled. Reasoning from
`-F` alone would therefore misstate the durability model. The recorded OPFS
campaign met its promised floors; re-measuring strict-mode cost could inform a
different default without implying that the present implementation is corrupt.

The OPFS record also describes already-fixed uncoded I/O-error handling; it must
not be relisted as an unresolved defect. It does not claim protection against
physical media failure or every power-loss scenario.

## Recommended decisions and completion evidence

1. Treat PG19 ABI/store transition and consumer qualification as adoption gates
   when choosing to use PG19.
2. Prefer bounded session-reset and regression-helper work for stronger SQL
   compatibility evidence. Their large program counts are leverage, not a measure
   of current production damage or a promise that every blocked program will pass.
3. Give recursion/browser resource characterization priority when the intended
   inputs are untrusted, unusually deep or memory-heavy. Make the trigger and
   measured limit part of the decision.
4. Pursue locale, replication, native sessions/workers and additional extensions
   for named application needs. Keep accepted limitations explicit instead of
   either calling them emergencies or hiding them by removing tests.
5. Benchmark performance/durability alternatives before changing defaults.

The October fixes are already outside this remaining-gap list: extended-query
readiness scheduling on both majors, UTC initdb configuration, unsigned parameter
counts and windowed live-query statement cleanup. Functional validation includes
eight native runs per major, full runtime smoke on the new binaries, unchanged
export/data-format contracts, and green host validation. Reproducibility gate
pairs separately check deterministic builds; they do not fill the SQL coverage
or consumer-adoption gaps described here.

The host validation uses the toolkit's current PG18 `18.6.2` artefact pins;
driver/native runs use the newly built C candidates. These are complementary
checks, not a completed PG19 consumer-contract/browser adoption run.
[Current consumer pin snapshot](https://github.com/pgxsinkit/pgxsinkit/blob/d0308b6870d9aa07163377d9d8192e97e1815324/packages/pgwasm-c/src/artefact-pins.ts).

Evidence here is source/diff comparison and the recorded qualification, not a new
fault campaign or population study. Upstream PGlite may supply useful patches,
but ownership of this build's behavior and of decisions about its capabilities
stays here. None of these findings requires treating all native-server
capabilities as mandatory for a useful embedded database.
