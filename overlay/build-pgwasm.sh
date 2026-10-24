#!/bin/bash

### NOTES ###
# $INSTALL_PREFIX is expected to point to the installation folder of various libraries built to wasm (see pgwasm-builder)
#
# pgwasm-postgres runs this with `bun run build`, in its builder image, with the source at /build and:
#   PGWASM_POSTGRES_VERSION  the release version version() names (required)
#   SOURCE_DATE_EPOCH        the commit time the extension archives' member mtimes are set to (required)
#   LC_ALL=C                 so that sorting and messages do not depend on the host's locale
#   DEBUG=true               a debug build (-g); HOST_SOURCE_DIR then maps /build back to the host's checkout
#############

: "${PGWASM_POSTGRES_VERSION:?must be the release version that version() names}"
: "${SOURCE_DATE_EPOCH:?must be the commit time, which the extension archives carry as member mtimes}"
export PGWASM_POSTGRES_VERSION SOURCE_DATE_EPOCH

emcc --clear-cache

# final output folder
INSTALL_FOLDER=${INSTALL_FOLDER:-"/pgwasm"}

# The browser floor (ADR-0001 decision 11): Safari and iOS 18.4, Chrome 137, Firefox 131, the first releases with
# standard wasm exceptions (exnref). Emscripten encodes Safari's version as MMmmVV. Bun runs the artefacts as `node`
# (ENVIRONMENT), whose floor stays Emscripten's own (MIN_NODE_VERSION). These are link settings: they go with the
# compiler flags because those reach every link (pgwasm, the tools, the shared modules), as ENVIRONMENT does.
PGWASM_BROWSER_FLOOR="-sMIN_SAFARI_VERSION=180400 -sMIN_CHROME_VERSION=137 -sMIN_FIREFOX_VERSION=131"

# build with optimizations by default aka release
# setjmp/longjmp stay Emscripten's JavaScript implementation (SUPPORT_LONGJMP=emscripten, invoke_* trampolines), which
# Emscripten 6 still supports; wasm exceptions (SUPPORT_LONGJMP=wasm), which the floor allows, belong to the
# performance work.
# (-sWASM_BIGINT is gone: BigInt integration is Emscripten 6's default, and the setting is deprecated.)
PGWASM_CFLAGS="-m32 -fpic -sENVIRONMENT=node,web,worker $PGWASM_BROWSER_FLOOR -sSUPPORT_LONGJMP=emscripten -Wno-declaration-after-statement -Wno-macro-redefined -Wno-unused-function -Wno-missing-prototypes -Wno-incompatible-pointer-types"
if [ "$DEBUG" = true ]
then
    echo "pgwasm: building debug version."
    PGWASM_CFLAGS="$PGWASM_CFLAGS -g -gsource-map --no-wasm-opt"
    # the source is built at a fixed path; the debug info points at the host's checkout, where a debugger finds it
    if [ -n "$HOST_SOURCE_DIR" ]; then
        PGWASM_CFLAGS="$PGWASM_CFLAGS -ffile-prefix-map=$(pwd)=$HOST_SOURCE_DIR"
    fi
else
    echo "pgwasm: building release version."
    PGWASM_CFLAGS="$PGWASM_CFLAGS -O2"
    # we shouldn't need to do this, but there's a bug somewhere that prevents a successful build if this is set
    unset DEBUG
fi

# PGWASM_OTHER_FLAGS="-sUSE_PTHREADS=0 -fPIC -m32 -mno-bulk-memory -mnontrapping-fptoint -mno-reference-types -mno-sign-ext -mno-extended-const -mno-atomics -mno-tail-call -mno-multivalue -mno-relaxed-simd -mno-simd128 -mno-multimemory -mno-exception-handling -Wno-unused-command-line-argument -Wno-unreachable-code-fallthrough -Wno-unused-function -Wno-invalid-noreturn -Wno-declaration-after-statement -Wno-invalid-noreturn"
# PGWASM_CFLAGS="$PGWASM_CFLAGS"

# first build pgwasm-libc object WITHOUT the overriding flags
# pushd pgwasm/src/pgwasmc && emcc -g --no-wasm-opt -gsource-map -static -fPIC -o pgwasmc.o -c pgwasmc.c && popd
pushd pgwasm/src/pgwasmc && emcc $PGWASM_CFLAGS -static -fpic -o pgwasmc.o -c pgwasmc.c && popd

# -Dread=pgwasm_read -Dwrite=pgwasm_write
PGWASM_CFLAGS="$PGWASM_CFLAGS \
-D__PGWASM__ \
-Dsystem=pgwasm_system -Dpopen=pgwasm_popen -Dpclose=pgwasm_pclose \
-Dgeteuid=pgwasm_geteuid -Dgetuid=pgwasm_getuid -Dgetpwuid=pgwasm_getpwuid \
-Dexit=pgwasm_exit \
-Dmunmap=pgwasm_munmap \
-Dfcntl=pgwasm_fcntl \
-Datexit=pgwasm_atexit \
-Dsetsockopt=pgwasm_setsockopt -Dgetsockopt=pgwasm_getsockopt -Dgetsockname=pgwasm_getsockname \
-Dsocket=pgwasm_socket -Drecv=pgwasm_recv -Dsend=pgwasm_send -Dconnect=pgwasm_connect \
-Dpoll=pgwasm_poll \
-Dshmget=pgwasm_shmget -Dshmat=pgwasm_shmat -Dshmdt=pgwasm_shmdt -Dshmctl=pgwasm_shmctl \
-Dlongjmp=pgwasm_longjmp -Dsiglongjmp=pgwasm_siglongjmp"
# we don't want to override sigsetjmp and setjmp!
# -Dsigsetjmp=pgwasm_sigsetjmp -Dsiglongjmp=pgwasm_siglongjmp \
# -Dsetjmp=pgwasm_setjmp -Dlongjmp=pgwasm_longjmp"

echo "pgwasm: PGWASM_CFLAGS=$PGWASM_CFLAGS"

# run ./configure only if config.status is older than this file
# TODO: we should ALSO check if any of the PGWASM_CFLAGS have changed and trigger a ./configure if they did!!!
REF_FILE="build-pgwasm.sh"
CONFIG_STATUS="config.status"
RUN_CONFIGURE=false

if [ ! -f "$CONFIG_STATUS" ]; then
    echo "$CONFIG_STATUS does not exist, need to run ./configure"
    RUN_CONFIGURE=true
elif [ "$REF_FILE" -nt "$CONFIG_STATUS" ]; then
    echo "$CONFIG_STATUS is older than $REF_FILE. Need to run ./configure."
    RUN_CONFIGURE=true
else
    echo "$CONFIG_STATUS exists and is newer than $REF_FILE. ./configure will NOT be run."
fi

# Every link resolves `-lpq`, `-lpgport`, ... to the static archive, as Emscripten did until 6.0.0 (FAKE_DYLIBS, on
# by default until then): libpq is also built as a real shared library (libpq.so, a side module), which without it
# would become a runtime dependency of initdb, pg_dump and libpqwalreceiver.so, none of which ships it.
# -sUSE_PTHREADS=0 undoes the `-pthread` libpq's links carry (configure's PTHREAD_CFLAGS), which would otherwise link
# them with shared memory; the setting is deprecated in Emscripten 6 in favour of -pthread, and nothing replaces its
# =0 yet. -sDEFAULT_TO_CXX links libc++ and libc++abi when emcc (the build's CC) links, as it did by default until
# Emscripten 6.0.6: ICU is C++, and the backend and initdb link it.
PGWASM_LDFLAGS="-sFAKE_DYLIBS=1 -sDEFAULT_TO_CXX=1 -sUSE_PTHREADS=0"
PGWASM_LDFLAGS_SL="-shared -sSIDE_MODULE=1 -Wno-unused-function"

# we define here "all" emscripten flags in order to allow native builds (like libpgwasm)
# The runtime members the hosts use (pgxsinkit's pgwasm-c and pgwasm-pg-dump, and scripts/lib/driver/): Emscripten 4
# stopped exporting the heap views by default, so HEAP8 and HEAPU8 are listed.
EXPORTED_RUNTIME_METHODS="addFunction,removeFunction,FS,MEMFS,PROXYFS,callMain,ENV,UTF8ToString,stringToNewUTF8,stringToUTF8OnStack,HEAP8,HEAPU8"
PGWASM_LDFLAGS_EX="\
-sINITIAL_MEMORY=64MB \
-sSUPPORT_LONGJMP=emscripten \
-sFORCE_FILESYSTEM=1 \
-sEXIT_RUNTIME=1 -sENVIRONMENT=node,web,worker \
-sMAIN_MODULE=2 -sMODULARIZE=1 -sEXPORT_ES6=1 \
-sEXPORT_NAME=Module -sALLOW_TABLE_GROWTH -sALLOW_MEMORY_GROWTH \
-sERROR_ON_UNDEFINED_SYMBOLS=0 \
-sEXPORTED_RUNTIME_METHODS=$EXPORTED_RUNTIME_METHODS \
-sINVOKE_RUN=0 \
-sEXPORTED_FUNCTIONS=_main,_fgets,_fputs,_pclose,_fopen,_fclose,_fflush,___errno_location,_strerror \
$(pwd)/pgwasm/src/pgwasmc/pgwasmc.o \
-lproxyfs.js \
--post-js $(pwd)/pgwasm/scripts/doNotSetExitCode.js"

# --with-blocksize=16 
# --disable-largefile 
# --with-blocksize=1 

CONFIGURE_PARAMS="\
ac_cv_exeext=.js \
--host wasm32-unknown-emscripten \
--disable-spinlocks \
--without-llvm  \
--without-pam \
--disable-largefile \
--with-openssl=no \
--without-readline \
--with-icu \
--with-includes=$INSTALL_PREFIX/include:$INSTALL_PREFIX/include/libxml2 \
--with-libraries=$INSTALL_PREFIX/lib \
--with-zlib \
--with-libxml \
--with-template=emscripten \
--prefix=$INSTALL_FOLDER"

# Step 1: configure the project
if [ "$RUN_CONFIGURE" = true ]; then
    LDFLAGS=$PGWASM_LDFLAGS \
    LDFLAGS_SL=$PGWASM_LDFLAGS_SL \
    LDFLAGS_EX=$PGWASM_LDFLAGS_EX \
    ICU_CFLAGS="-I/install/libs/include" \
    ICU_LIBS="-L/install/libs/lib -licui18n -licuuc -licudata" \
    CFLAGS=${PGWASM_CFLAGS} emconfigure ./configure $CONFIGURE_PARAMS || { echo 'error: emconfigure failed' ; exit 11; }
else
    echo "Warning: configure has not been run because RUN_CONFIGURE=${RUN_CONFIGURE}"
fi

# Step 2: make and install all
emmake make PORTNAME=emscripten -j || { echo 'error: emmake make PORTNAME=emscripten -j' ; exit 21; }
emmake make PORTNAME=emscripten install || { echo 'error: emmake make PORTNAME=emscripten install' ; exit 23; }

# Step 3: the shipped extensions: each contrib module of PGWASM_CONTRIB, built and packaged by contrib/dist.mk as
# $INSTALL_FOLDER/extensions/<module>.tar.gz
PGWASM_CONTRIB="amcheck"
emmake make PORTNAME=emscripten -C contrib/ $(for module in $PGWASM_CONTRIB; do echo "$module.tar.gz"; done) || { echo 'error: emmake make PORTNAME=emscripten -C contrib/ <module>.tar.gz' ; exit 31; }

# Step 4: postgres.wasm's export list. postgres.wasm is linked with -sMAIN_MODULE=2, which exports only the symbols
# exported_functions.txt lists, and a shared module loads (and runs) only if postgres.wasm exports every symbol it
# imports. So the list is pgwasm/static/included.pgwasm.exports (what the host calls) plus the imports of every
# module the build ships: the core modules postgres.data carries (lib/postgresql/*.so) and those of the extension
# archives; less libpq's API, which the backend does not define (see the script). It is an output too:
# pgwasm-postgres diffs it against its reference.
SHIPPED_MODULES=$(mktemp -d)
for archive in "$INSTALL_FOLDER"/extensions/*.tar.gz; do
    tar -xzf "$archive" -C "$SHIPPED_MODULES" --wildcards 'lib/postgresql/*.so' || { echo "error: no modules in $archive" ; exit 41; }
done
pgwasm/scripts/exported-functions.sh pgwasm/static/included.pgwasm.exports src/interfaces/libpq/exports.list \
    "$INSTALL_FOLDER"/lib/postgresql/*.so "$SHIPPED_MODULES"/lib/postgresql/*.so \
    > "$INSTALL_FOLDER/exported_functions.txt" || { echo 'error: pgwasm/scripts/exported-functions.sh' ; exit 42; }
rm -rf "$SHIPPED_MODULES"

# Step 5: make and install pgwasm: the backend the host embeds, linked as pgwasm/postgres.js with postgres.wasm and
# postgres.data (src/backend/Makefile's pgwasm target), and installed into $INSTALL_FOLDER/pgwasm
PGROOT=/pgwasm
# PG_IMPORTS_DIR=$PGROOT/imports
PGPRELOAD="\
--preload-file $(pwd)/pgwasm/static/PGPASSFILE@/home/postgres/.pgpass \
--preload-file $(pwd)/pgwasm/static/empty@/pgwasm/bin/initdb \
--preload-file $(pwd)/pgwasm/static/empty@/pgwasm/bin/pg_dump \
--preload-file $(pwd)/pgwasm/static/empty@/pgwasm/bin/postgres \
--preload-file $PGROOT/share/postgresql@/pgwasm/share/postgresql \
--preload-file $PGROOT/lib/postgresql@/pgwasm/lib/postgresql \
--preload-file $(pwd)/pgwasm/static/password@/pgwasm/password \
--preload-file $(pwd)/pgwasm/static/empty@/pgwasm/pgstdin \
--preload-file $(pwd)/pgwasm/static/empty@/pgwasm/pgstdout \
--preload-file $(pwd)/pgwasm/static/locale-a@/pgwasm/locale-a \
--preload-file $(pwd)/pgwasm/static/minimal-icu/79.1@/pgwasm/icu"

# Filesystem types are module exports, not FS.filesystems, on Emscripten 6.0.13.
# NODEFS is needed by the regression bridge's server-side COPY fixtures.
PGWASM_EXPORTED_RUNTIME_METHODS="MEMFS,IDBFS,NODEFS,FS,PROXYFS,setValue,getValue,UTF8ToString,stringToNewUTF8,stringToUTF8OnStack,addFunction,removeFunction,callMain,ENV,HEAP8,HEAPU8"

# The module options postgres.js reads: Emscripten's default list (settings.js, INCOMING_MODULE_JS_API) and
# wasmMemory, which Emscripten 6.0.2 dropped from it and the hosts pass (a memory of their own, initial 128 MB).
PGWASM_INCOMING_MODULE_JS_API="ENVIRONMENT,arguments,canvas,dynamicLibraries,elementPointerLock,instantiateWasm,locateFile,monitorRunDependencies,noExitRuntime,noInitialRun,onAbort,onExit,onRuntimeInitialized,postRun,preInit,preRun,print,printErr,setStatus,statusMessage,stderr,stdin,stdout,thisProgram,wasm,websocket,wasmMemory"

# -sDYLINK_DEBUG=2 use this for debugging missing exported symbols (ex when an extension calls a pgcore function that hasn't been exported)
# -Wl,--no-export-dynamic: postgres.wasm exports exported_functions.txt, not every symbol. The backend's link carries
# configure's LDFLAGS_EX_BE (-Wl,--export-dynamic, for a native postgres whose modules resolve against it); Emscripten
# up to 3.1.74 overrode it with its own --no-export-dynamic, while since 4.0.20 the command line's linker flags come
# last, so without this the wasm exports all 9,649 symbols of the link (ICU's, libxml2's, libc++'s, ...).
POSTGRES_PGWASM_FLAGS="\
-Wl,--no-export-dynamic \
-sSTACK_SIZE=8MB \
-sINITIAL_MEMORY=128MB \
-sIMPORTED_MEMORY=1 \
-sEXPORTED_RUNTIME_METHODS=$PGWASM_EXPORTED_RUNTIME_METHODS \
-sINCOMING_MODULE_JS_API=$PGWASM_INCOMING_MODULE_JS_API \
-sEXPORTED_FUNCTIONS=@$INSTALL_FOLDER/exported_functions.txt \
$PGPRELOAD \
--pre-js $(pwd)/pgwasm/scripts/loadBundleFirst.js \
-lnodefs.js -lidbfs.js"

# Building pgwasm itself needs to be the last step because of the PRELOAD_FILES parameter (a list of files and folders) need to be available.
POSTGRES_PGWASM_FLAGS="$PGWASM_CFLAGS $POSTGRES_PGWASM_FLAGS" emmake make PORTNAME=emscripten -C src/backend/ -j pgwasm || { echo 'emmake make OPTFLAGS="" PORTNAME=emscripten -j -C pgwasm' ; exit 51; }
emmake make PORTNAME=emscripten -C src/backend/ install-pgwasm || { echo 'emmake make PORTNAME=emscripten -C src/backend/ install-pgwasm' ; exit 52; }
