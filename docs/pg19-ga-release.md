# PostgreSQL 19 final release

The client runtime adopts PostgreSQL 19.0, released on 2026-11-19. The pin is
`REL_19_0`, commit `5c839a2a08b9b87a349be97371fac6c5a2873b10`. The C candidate
version is `19.0.0`; server, initdb, pg_dump and the prepopulated seed ship together.
The native Circuits and service-stack upgrades are a subsequent task.

## Source and ABI

The final tag has 47 commits after RC2. `bun run bump REL_19_0 --lock` applied
all five topic patches cleanly and proved their export round trip. The source
has no new changes to the startup-packet entry point or the control/catalog/WAL
version declarations. The single-argument host startup adapter remains intact.

The locked published Emscripten 6.0.13 builder compiles the release. Driver smoke
verifies startup, cancellation refusal, recovery, shipped modules, encodings,
ICU and pg_dump. All 1,131 export-list symbols remain present, including the 676
core symbols; the reference requires no change.

## Store format

A fresh initdb confirms the same physical data format 2 as RC2, with control version
1905, catalog version 202610061 and WAL magic `0xD122`. PG18 stores use format 1
and must be recreated and resynced when moving to PG19.

## Prepopulated identity

The ordinary seed generator and archive layout are retained. The reference
identity keeps epoch `1792895272`. Reproducing RC2 at that epoch gives exactly
its committed archive and gzip hashes. Against that seed, the final build
changes the SQL implementation version from `19.00.0002` to `19.00.0000` in each
database, its statistics, page checksums and corresponding WAL records.
The other 992 of 999 entries are byte-identical. The resulting GA asset is
4,473,964 bytes and regenerates byte-identically through `prepopulated --check`.

## Regression review

The upstream schedule still contains 243 tests. Two independent eight-run series
each produced 188 passes, 55 failures and zero backend failures in every run.
The `stats` diff varied in both series. The `subscription` diff was uniform in
both, so the generated GA record contains 188 passes, 54 recorded failures and
one unstable program. RC2 had reproduced clock-resolution variation in
`subscription`; its existing failure-group explanation preserves that evidence.
Its SQL and the relevant clock implementation are unchanged by this bump.

Four previously failing tests have changed diffs, reviewed against their upstream
SQL and expected output.

| Test                  | Explanation                                                                                                                                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `merge`               | The failure body is unchanged. New upstream MERGE cases move its hunk coordinates.                                                                                                                         |
| `collate.icu.utf8`    | The failure body is unchanged. New ICU test cases move one hunk.                                                                                                                                           |
| `create_function_sql` | New OUT-parameter cases add four successfully created functions to the final cleanup notice. The existing suppressed cascade notice and other failure causes persist.                                      |
| `cluster`             | Upstream adds shared-catalog CLUSTER coverage and changes REPACK diagnostics. The existing standalone role-reset limitation leaves the test underprivileged, so both new checks receive permission errors. |

Every newly added case in previously passing tests passes. The existing known
failure groups retain their causes, recorded in the baseline and the
[remaining Wasm gaps assessment](pgwasm-remaining-gaps.md).

The release acceptance requires the reviewed eight-run regression record,
two passing gates from the same final clean commit with identical manifests,
and a successful CI gate on that exact commit. The release job must reproduce
the gated build before publication. Toolkit adoption then qualifies its worker,
IndexedDB, OPFS and dump contracts against these server and dump assets.

## Completed release qualification

Commit `77228df75b0b80e633c6153cbc17db69ca3a7f6e` passed two independent clean
local gates using the locked published builder. Their complete manifests were
byte-identical, with SHA-256
`89e117f0eea51612a5b917466158047c8ce540b5ba226c60e6c1828986524c49`.
Every release checksum verified in both gate outputs. CI gate `44861023009` also
passed on that exact commit. The final `19.0.0` tag identifies this commit.
[CI gate](https://github.com/pgxsinkit/pgwasm-postgres/actions/runs/44861023009)

## Post-release clock variation

The first `19.0.1` develop CI gate reported a changed `subscription` diff while
retaining 188 passes, 55 failures and zero backend failures. Its success-only
artifact step was skipped, so the changed hunk cannot be recovered from that
run. The CI result establishes output variation independently of the uniform
local samples. [Failed CI gate](https://github.com/pgxsinkit/pgwasm-postgres/actions/runs/44865645005)

Supplementary local investigation used the existing runner and cached native
tools against the already-built `19.0.1` Wasm. Thirty-two focused executions of
an exact upstream `subscription.sql` copy all matched the committed full-suite
diff byte-for-byte, with zero backend failures. They establish the same local
variant, without exposing the CI hunk.

A separate focused SQL probe used the existing driver with its real host clock
and the upstream reset/capture/reset/strict-comparison sequence. In three
comparisons it observed both results. One pair advanced from
`04:38:42.565+00` to `04:38:42.566+00` and returned true. Another pair had both
timestamps at `04:38:42.569+00` and returned false. The focused output variants
differ only in that boolean. The Wasm SHA-256 was
`545cfdab5d664f1c8e382c497f8ee06abd98781369b70c4a6376807b9f1bf10f`.
This reproduces the previously recorded millisecond-clock limitation on the
current runtime. The missing CI hunk leaves its precise content unverified.

The existing `combineRuns` and `recordBaseline` logic records this supplementary
evidence for `subscription`. The develop baseline again classifies `stats` and
`subscription` as unstable, with 188 passing programs and 53 recorded failures.
Its original eight-run full-suite provenance and artefact hashes are retained.
Every other program classification and retained diff is byte-identical to the
previous record. The published `19.0.0` qualification remains in its tagged
commit.
