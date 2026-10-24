# pgwasm-postgres backend

The source tree is upstream PostgreSQL plus pgwasm-postgres's topic patches and this overlay. The port
originated in ElectricSQL's PGlite; `NOTICE` and pgwasm-postgres's ADR-0001 retain that provenance.

## Build and entry points

`build-pgwasm.sh` configures PostgreSQL for Emscripten and builds the core, shipped modules and tools.
The backend's `pgwasm` and `install-pgwasm` Makefile targets link and install `postgres.js`,
`postgres.wasm` and `postgres.data`. The module's filesystem root is `/pgwasm`.

`pgwasm/src/pgwasmc/pgwasmc.c` contains libc overrides, callback registration and the shared state the
host uses. The build compiles this file before applying the libc replacement macros to PostgreSQL, so
the wrappers can call the real libc functions. Backend changes use `__PGWASM__`; Emscripten-only
changes also use `__EMSCRIPTEN__` or the `emscripten` port name.

`pgwasm/static/included.pgwasm.exports` lists the core symbols the host calls. The final export list
also includes the imports of every shipped shared module, computed by
`pgwasm/scripts/exported-functions.sh`. The driver in pgwasm-postgres's `scripts/lib/driver/` is an
executable example of the module contract.

## Host-driven loop

The host starts single-user PostgreSQL with `pgwasm_setPostgresActive(1)`, calls `main()` and checks
the status through `pgwasm_setPostgresExitStatus()`. It then calls `pgwasm_startPostgres()` to switch
to the embedded backend session. `ProcessStartupPacket()` accepts one `Port *` on PostgreSQL 19.

The `main-loop-unroll` patch keeps upstream's loop and error handler in place and introduces function
boundaries around them when `__PGWASM__` is defined. The host calls `PostgresMainLoopOnce()` for each
frontend message and `PostgresSendReadyForQueryIfNecessary()` after the exchange. The backend returns
control when it has consumed a message instead of waiting for another one.

PostgreSQL ERRORs normally longjmp to the top of that loop. `pgwasm_longjmp()` intercepts that jump,
records `POSTGRES_MAIN_LONGJMP` and unwinds to the host while keeping the Emscripten runtime alive.
The host restores the wasm shadow stack pointer captured before the call and invokes
`PostgresMainLongJmp()` to run the error handler. The stack restoration is required after every such
unwind; otherwise repeated errors exhaust the shadow stack.

## Callbacks and cleanup

`pgwasm_set_rw_cbs()` registers host read/write callbacks. Socket overrides such as `pgwasm_recv()`
and `pgwasm_send()` route PostgreSQL's wire protocol through those callbacks. The same interface lets
the host run `pg_dump` against the embedded session.

`pgwasm_set_system_fn()`, `pgwasm_set_popen_fn()` and `pgwasm_set_pclose_fn()` let initdb run its
backend commands on scratch instances. `pgwasm_freopen()` redirects stdin and stdout for those
commands. Other overrides emulate user identity and shared-memory operations, suppress unsupported
socket operations, and keep Emscripten's `munmap()` from corrupting MEMFS files.

To close a running backend cleanly, the host clears the active flag and calls
`pgwasm_run_atexit_funcs()`. This runs PostgreSQL's exit callbacks, including its shutdown checkpoint,
before the host disposes of the Emscripten instance.
