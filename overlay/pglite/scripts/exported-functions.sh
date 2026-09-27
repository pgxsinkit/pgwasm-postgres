#!/bin/bash
# exported-functions.sh <included exports> <excluded names> <shared module>...
#
# Prints pglite.wasm's export list, the input of -sEXPORTED_FUNCTIONS: the symbols of <included exports> (one per
# line: what the host calls) and every symbol one of the shared modules imports from the main module, less the
# names of <excluded names>, sorted, each with the leading underscore Emscripten expects.
#
# A module's imports are read from its linked wasm with binaryen's wasm-dis: the functions and globals it imports
# from `env`, and its `GOT.mem` and `GOT.func` entries, which the dynamic linker binds to the addresses of data
# and functions. Left out are the symbols the module exports itself (the linker binds a module's GOT entries to its
# own definitions, as it does for libpq's in libpqwalreceiver) and what the dynamic linker hands every module
# itself: its memory, table, stack pointer, memory and table bases, and the invoke_* trampolines.
#
# <excluded names> is libpq's API (src/interfaces/libpq/exports.list): the backend defines none of it. A module
# that links libpq statically (libpqwalreceiver) carries its own; the two functions of it libpq takes from
# libpgcommon (pg_char_to_encoding, pg_encoding_to_char) exist in the backend only as *_private, so they stay
# unresolved in the module. Emscripten refuses to link an export list naming a symbol the link does not define.
set -euo pipefail
export LC_ALL=C

if [ "$#" -lt 2 ]; then
    echo "usage: $0 <included exports> <excluded names> <shared module>..." >&2
    exit 2
fi
included=$1
excluded=$2
shift 2
wasm_dis=${WASM_DIS:-/emsdk/upstream/bin/wasm-dis}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

awk '{ sub(/[[:space:]]+$/, "") } NF' "$excluded" | sort -u > "$work/excluded"
{
    awk '{ sub(/[[:space:]]+$/, "") } NF' "$included"
    for module in "$@"; do
        "$wasm_dis" "$module" > "$work/module.wat"
        sed -n -E 's/^ \(import "(env|GOT\.mem|GOT\.func)" "([^"]+)".*/\2/p' "$work/module.wat" | sort -u > "$work/imports"
        sed -n -E 's/^ \(export "([^"]+)".*/\1/p' "$work/module.wat" | sort -u > "$work/exports"
        comm -23 "$work/imports" "$work/exports" | comm -23 - "$work/excluded"
    done
} | grep -v -x -E 'memory|__indirect_function_table|__stack_pointer|__memory_base|__table_base|invoke_.*' |
    sort -u | sed 's/^/_/'
