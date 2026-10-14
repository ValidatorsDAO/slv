#!/usr/bin/env bash
set -euo pipefail

# Keep the recipe portable across the three native host families. GNU
# readlink/sha256sum are not assumed on macOS; recorded identities use Python.
PYTHON="${PYTHON:-python3}"
command -v "$PYTHON" >/dev/null 2>&1 || {
  echo "python3 is a required native build prerequisite" >&2
  exit 65
}
python_version="$($PYTHON -c 'import sys; print(".".join(map(str, sys.version_info[:3])))')"
"$PYTHON" - <<'PYEOF' || {
import sys
raise SystemExit(0 if sys.version_info >= (3, 11) else 1)
PYEOF
  echo "Python 3.11 or newer is required for the lock guard" >&2
  exit 65
}
canonical_path() {
  "$PYTHON" - "$1" <<'PYEOF'
import os
import sys
print(os.path.realpath(sys.argv[1]))
PYEOF
}
sha256_file() {
  "$PYTHON" - "$1" <<'PYEOF'
import hashlib
import pathlib
import sys
path = pathlib.Path(sys.argv[1])
hash = hashlib.sha256()
with path.open('rb') as source:
    for chunk in iter(lambda: source.read(1024 * 1024), b''):
        hash.update(chunk)
print(hash.hexdigest())
PYEOF
}
resource_snapshot() {
  "$PYTHON" - "$1" <<'PYEOF'
import json
import resource
import shutil
import sys
usage = shutil.disk_usage(sys.argv[1])
children = resource.getrusage(resource.RUSAGE_CHILDREN)
print(json.dumps({
    'disk_total_bytes': usage.total,
    'disk_free_bytes': usage.free,
    'disk_used_bytes': usage.used,
    'children_max_rss': children.ru_maxrss,
}, sort_keys=True, separators=(',', ':')))
PYEOF
}

# MACOS_BINDGEN_PREFLIGHT_BEGIN
write_macos_bindgen_preflight() {
  local preflight_dir="$1"
  local receipt="$preflight_dir/preflight.json"
  local diagnostics_log="$preflight_dir/diagnostics.log"
  mkdir -p "$preflight_dir"
  [[ ! -e "$receipt" && ! -e "$diagnostics_log" ]] || {
    echo "macOS bindgen preflight output already exists: $preflight_dir" >&2
    return 65
  }
  "$PYTHON" - "$receipt" "$diagnostics_log" "$libclang" "$apple_sdk_path" "$apple_sdk_version" "$apple_link_target" "$BINDGEN_EXTRA_CLANG_ARGS" <<'PYEOF'
import ctypes
import hashlib
import json
import pathlib
import shlex
import sys

receipt_path = pathlib.Path(sys.argv[1])
diagnostics_path = pathlib.Path(sys.argv[2])
library_path = pathlib.Path(sys.argv[3]).resolve()
sdk_path = pathlib.Path(sys.argv[4]).resolve()
sdk_version = sys.argv[5]
target = sys.argv[6]
serialized_args = sys.argv[7]
diagnostics = []
required_headers = ('stdlib.h', 'stdint.h', 'stddef.h', 'sys/types.h')
record = {
    'schema_version': 1,
    'kind': 'slv-macos-bindgen-preflight',
    'status': 'failed',
    'libclang': {
        'path': str(library_path),
        'sha256': None,
    },
    'sdk': {
        'path': str(sdk_path),
        'version': sdk_version,
    },
    'target': target,
    'bindgen_extra_clang_args': serialized_args,
    'parsed_args': [],
    'headers': {},
    'diagnostics': diagnostics,
}

def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()

def write(status):
    record['status'] = status
    diagnostics_path.write_text(
        json.dumps(diagnostics, sort_keys=True, indent=2) + '\n',
        encoding='utf-8',
    )
    record['logs'] = {
        'diagnostics.log': {
            'sha256': digest(diagnostics_path),
            'size': diagnostics_path.stat().st_size,
        },
    }
    receipt_path.write_text(
        json.dumps(record, sort_keys=True, indent=2) + '\n',
        encoding='utf-8',
    )

index = None
translation_unit = None
try:
    record['libclang']['sha256'] = digest(library_path)
    record['parsed_args'] = shlex.split(serialized_args)
    if not sdk_path.is_dir():
        raise RuntimeError('selected macOS SDK is not a directory: ' + str(sdk_path))
    for header in required_headers:
        path = sdk_path / 'usr/include' / header
        record['headers'][header] = path.is_file()
    missing = [name for name, present in record['headers'].items() if not present]
    if missing:
        raise RuntimeError('selected macOS SDK lacks required headers: ' + ', '.join(missing))

    source_path = receipt_path.with_name('headers.c')
    source_path.write_text(
        '#include <stdlib.h>\n'
        '#include <stdint.h>\n'
        '#include <stddef.h>\n'
        '#include <sys/types.h>\n'
        'int main(void) { size_t bytes = sizeof(uintptr_t); void *memory = malloc(bytes); free(memory); return 0; }\n',
        encoding='utf-8',
    )
    record['source_sha256'] = digest(source_path)

    class CXString(ctypes.Structure):
        _fields_ = [('data', ctypes.c_void_p), ('private_flags', ctypes.c_uint)]

    libclang = ctypes.CDLL(str(library_path))

    def c_api(name, argtypes, restype):
        function = getattr(libclang, name)
        function.argtypes = argtypes
        function.restype = restype
        return function

    clang_createIndex = c_api(
        'clang_createIndex', [ctypes.c_int, ctypes.c_int], ctypes.c_void_p,
    )
    clang_parseTranslationUnit2 = c_api(
        'clang_parseTranslationUnit2',
        [
            ctypes.c_void_p,
            ctypes.c_char_p,
            ctypes.POINTER(ctypes.c_char_p),
            ctypes.c_int,
            ctypes.c_void_p,
            ctypes.c_uint,
            ctypes.c_uint,
            ctypes.POINTER(ctypes.c_void_p),
        ],
        ctypes.c_uint,
    )
    clang_getNumDiagnostics = c_api(
        'clang_getNumDiagnostics', [ctypes.c_void_p], ctypes.c_uint,
    )
    clang_getDiagnostic = c_api(
        'clang_getDiagnostic', [ctypes.c_void_p, ctypes.c_uint], ctypes.c_void_p,
    )
    clang_getDiagnosticSeverity = c_api(
        'clang_getDiagnosticSeverity', [ctypes.c_void_p], ctypes.c_uint,
    )
    clang_getDiagnosticSpelling = c_api(
        'clang_getDiagnosticSpelling', [ctypes.c_void_p], CXString,
    )
    clang_disposeString = c_api(
        'clang_disposeString', [CXString], None,
    )
    clang_disposeDiagnostic = c_api(
        'clang_disposeDiagnostic', [ctypes.c_void_p], None,
    )
    clang_disposeTranslationUnit = c_api(
        'clang_disposeTranslationUnit', [ctypes.c_void_p], None,
    )
    clang_disposeIndex = c_api(
        'clang_disposeIndex', [ctypes.c_void_p], None,
    )

    index = clang_createIndex(0, 0)
    if not index:
        raise RuntimeError('libclang did not create an index')
    encoded_args = [argument.encode('utf-8') for argument in record['parsed_args']]
    argv = (ctypes.c_char_p * len(encoded_args))(*encoded_args)
    parsed = ctypes.c_void_p()
    parse_code = clang_parseTranslationUnit2(
        index,
        str(source_path).encode('utf-8'),
        argv,
        len(encoded_args),
        None,
        0,
        0,
        ctypes.byref(parsed),
    )
    record['parse_error_code'] = parse_code
    translation_unit = parsed.value
    if parse_code != 0 or not translation_unit:
        raise RuntimeError('libclang could not parse macOS bindgen header probe')
    for position in range(clang_getNumDiagnostics(translation_unit)):
        diagnostic = clang_getDiagnostic(translation_unit, position)
        try:
            severity = clang_getDiagnosticSeverity(diagnostic)
            spelling = clang_getDiagnosticSpelling(diagnostic)
            try:
                text = ctypes.cast(spelling.data, ctypes.c_char_p).value
                diagnostics.append({
                    'severity': severity,
                    'spelling': '' if text is None else text.decode('utf-8', 'replace'),
                })
            finally:
                clang_disposeString(spelling)
        finally:
            clang_disposeDiagnostic(diagnostic)
    if any(item['severity'] >= 3 for item in diagnostics):
        raise RuntimeError('libclang reported an error or fatal diagnostic')
except Exception as error:
    diagnostics.append({'severity': 'probe-failure', 'spelling': str(error)})
    write('failed')
    raise SystemExit(65)
finally:
    if translation_unit:
        clang_disposeTranslationUnit(translation_unit)
    if index:
        clang_disposeIndex(index)

write('passed')
PYEOF
}
# MACOS_BINDGEN_PREFLIGHT_END

# Stage 2: build the unmodified denort package from a clean assembly.  The
# assembly remains read-only evidence: Cargo runs in a copied work directory,
# its target/cache live under OUTPUT, and the local v8 path patch produces a
# separately recorded derived lock.
#
# Usage:
#   build-baseline-denort.sh EXTRACTED_SOURCE_ROOT OUTPUT
#   build-baseline-denort.sh --resume EXTRACTED_SOURCE_ROOT OUTPUT
#
# A resumed diagnostic target is allowed only to repair a declared environment
# failure.  Copy this script to OUTPUT/recipe/ and execute that copied hash;
# never edit a script while its process is still draining build jobs.

resume=false
if [[ "${1:-}" == "--resume" ]]; then
  resume=true
  shift
fi
if [[ $# -ne 2 ]]; then
  echo "usage: $0 [--resume] EXTRACTED_SOURCE_ROOT OUTPUT" >&2
  exit 64
fi

root="$(cd "$1" && pwd -P)"
output="$2"
mkdir -p "$output"
output="$(cd "$output" && pwd -P)"
resource_start="$(resource_snapshot "$output")"
deno_source="${DENO_SOURCE_DIR:-$root/deno}"
rusty_v8_source="${RUSTY_V8_SOURCE_DIR:-$root/rusty_v8}"
cargo_vendor="${CARGO_VENDOR_DIR:-$root/cargo-vendor}"
for path in "$deno_source/Cargo.lock" "$rusty_v8_source/Cargo.toml" "$cargo_vendor"; do
  [[ -e "$path" ]] || { echo "missing clean source material: $path" >&2; exit 65; }
done

rust_bin="${RUST_BIN:?set RUST_BIN to the task-local Rust 1.95.0 bin directory}"
cargo="${CARGO:-$rust_bin/cargo}"
rustc="${RUSTC:-$rust_bin/rustc}"
[[ -x "$cargo" && -x "$rustc" ]] || { echo "missing task-local cargo or rustc" >&2; exit 65; }
[[ "$(canonical_path "$cargo")" == "$(canonical_path "$rust_bin/cargo")" && "$(canonical_path "$rustc")" == "$(canonical_path "$rust_bin/rustc")" ]] || {
  echo "CARGO and RUSTC must resolve to the declared task-local Rust toolchain" >&2
  exit 65
}
"$rustc" --version | grep -q '^rustc 1\.95\.0 ' || {
  echo "Rust 1.95.0 is required for the pinned Deno 2.9.3 rebuild" >&2
  exit 65
}

: "${GN:?set GN to a task-local GN binary}"
: "${NINJA:?set NINJA to a task-local Ninja binary}"
: "${CLANG_BASE_PATH:?set CLANG_BASE_PATH to the pinned Chromium Clang prefix}"
: "${SLV_LINKER:?set SLV_LINKER to the checksum-pinned LLVM linker}"
: "${LIBCLANG_PATH:?set LIBCLANG_PATH to the paired task-local libclang directory}"
: "${CHROMIUM_RUST_TOOLCHAIN:?set CHROMIUM_RUST_TOOLCHAIN to the recorded Chromium Rust prerequisite}"
pinned_ninja="$(canonical_path "$NINJA")"
clang="$CLANG_BASE_PATH/bin/clang"
[[ -x "$GN" && -x "$pinned_ninja" && -x "$clang" && -x "$SLV_LINKER" && -x "$CHROMIUM_RUST_TOOLCHAIN/bin/rustc" ]] || {
  echo "GN, Ninja, Clang, pinned LLVM linker, and Chromium Rust prerequisite must be executable" >&2
  exit 65
}
case "$(uname -s)" in
  Linux) libclang="$LIBCLANG_PATH/libclang.so" ;;
  Darwin) libclang="$LIBCLANG_PATH/libclang.dylib" ;;
  *) echo "unsupported native host OS: $(uname -s)" >&2; exit 65 ;;
esac
[[ -e "$libclang" ]] || {
  echo "LIBCLANG_PATH lacks the paired platform libclang: $libclang" >&2
  exit 65
}
[[ "$(canonical_path "$(dirname "$LIBCLANG_PATH")/bin/clang")" == "$(canonical_path "$clang")" ]] || {
  echo "LIBCLANG_PATH must have the same paired clang as CLANG_BASE_PATH" >&2
  exit 65
}
resource_dir="$($clang -print-resource-dir)"
[[ -f "$resource_dir/include/stdarg.h" && -f "$resource_dir/include/stddef.h" ]] || {
  echo "the selected Clang resource directory lacks required C headers: $resource_dir" >&2
  exit 65
}

apple_xcode=""
apple_sdk_path=""
apple_sdk_version=""
if [[ "$(uname -s)" == "Darwin" ]]; then
  : "${DEVELOPER_DIR:?macOS proof requires DEVELOPER_DIR=/Applications/Xcode_16.2.app/Contents/Developer}"
  : "${SLV_APPLE_SDK_PATH:?macOS proof requires SLV_APPLE_SDK_PATH from Xcode 16.2}"
  [[ "$DEVELOPER_DIR" == "/Applications/Xcode_16.2.app/Contents/Developer" ]] || {
    echo "macOS proof requires the recorded Xcode 16.2 developer directory" >&2
    exit 65
  }
  apple_xcode="$(xcodebuild -version | tr '\n' ';')"
  [[ "$apple_xcode" == Xcode\ 16.2* ]] || {
    echo "macOS proof requires Xcode 16.2: $apple_xcode" >&2
    exit 65
  }
  apple_sdk_path="$(xcrun --sdk macosx --show-sdk-path)"
  apple_sdk_version="$(xcrun --sdk macosx --show-sdk-version)"
  [[ "$apple_sdk_path" == "$SLV_APPLE_SDK_PATH" && "$apple_sdk_version" == "15.2" ]] || {
    echo "macOS proof requires selected SDK 15.2 at declared path" >&2
    exit 65
  }
fi

linux_target=false
linux_arch=""
denolib=""
denosyslib=""
shim_dir=""
memfd_shim=""
math_shim=""
if [[ "$(uname -s)" == "Linux" ]]; then
  linux_target=true
  : "${BUILD_TARGET:?Linux source rebuild requires an explicit BUILD_TARGET}"
  : "${DENO_SYSROOT:?Linux source rebuild requires the pinned Deno ABI sysroot}"
  : "${DENO_SYSROOT_SHA256:?Linux source rebuild requires the pinned Deno ABI sysroot digest}"
  : "${V8_SYSROOT_AMD64:?Linux source rebuild requires the pinned V8 AMD64 sysroot}"
  : "${V8_SYSROOT_ARM64:?Linux source rebuild requires the pinned V8 ARM64 sysroot}"
  : "${V8_SYSROOT_AMD64_SHA256:?Linux source rebuild requires the pinned V8 AMD64 sysroot digest}"
  : "${V8_SYSROOT_ARM64_SHA256:?Linux source rebuild requires the pinned V8 ARM64 sysroot digest}"
  [[ "$resume" == false ]] || { echo "Linux ABI compatibility builds must start from a fresh work directory" >&2; exit 65; }
  case "$BUILD_TARGET" in
    x86_64-unknown-linux-gnu)
      [[ "$(uname -m)" == "x86_64" ]] || { echo "x86_64 target must build on x86_64 Linux" >&2; exit 65; }
      linux_arch=x86_64-linux-gnu
      ;;
    aarch64-unknown-linux-gnu)
      [[ "$(uname -m)" == "x86_64" ]] || { echo "only x86_64 Linux to aarch64 Linux cross-build is supported" >&2; exit 65; }
      linux_arch=aarch64-linux-gnu
      : "${CROSS_LINKER:?Linux ARM cross build requires the checksum-pinned target linker}"
      [[ -x "$CROSS_LINKER" ]] || { echo "cross linker is unavailable" >&2; exit 65; }
      ;;
    *) echo "unsupported Linux BUILD_TARGET: $BUILD_TARGET" >&2; exit 65 ;;
  esac
  [[ -f "$DENO_SYSROOT/.env" && -f "$DENO_SYSROOT/usr/include/features.h" && -f "$DENO_SYSROOT/usr/lib/$linux_arch/crt1.o" && -f "$DENO_SYSROOT/lib/$linux_arch/libc-2.27.so" ]] || {
    echo "pinned Deno ABI sysroot lacks required target headers, CRT, or glibc 2.27" >&2
    exit 65
  }
  [[ -d "$V8_SYSROOT_AMD64" && -d "$V8_SYSROOT_ARM64" ]] || {
    echo "pinned V8 Chromium sysroot extraction is unavailable" >&2
    exit 65
  }
  denolib="$DENO_SYSROOT/lib/$linux_arch"
  denosyslib="$DENO_SYSROOT/usr/lib/$linux_arch"
fi

work="$output/work"
if [[ "$resume" == false ]]; then
  if [[ -e "$work" ]]; then
    echo "output work directory already exists: $work" >&2
    exit 65
  fi
  mkdir -p "$work"
  cp -R "$deno_source" "$work/deno"
  cp -R "$rusty_v8_source" "$work/rusty_v8"
  mkdir -p "$work/deno/.cargo" "$output/cargo-home" "$output/target"

  # This link names a separately recorded compiler prerequisite.  It is made
  # only in the disposable build worktree because rusty_v8's upstream helper
  # requires that location; it is never accepted by the pure-source gate.
  ln -s "$CHROMIUM_RUST_TOOLCHAIN" "$work/rusty_v8/third_party/rust-toolchain"
  if [[ "$linux_target" == true ]]; then
    # rusty_v8 149.4.0 checks historical sid aliases while GN's recursive
    # installer reads the Bullseye names. Both names are local aliases to the
    # separately pinned Chromium 2.31 sysroots; Deno itself uses DENO_SYSROOT.
    mkdir -p "$work/rusty_v8/build/linux"
    ln -s "$V8_SYSROOT_AMD64" "$work/rusty_v8/build/linux/debian_sid_amd64-sysroot"
    ln -s "$V8_SYSROOT_ARM64" "$work/rusty_v8/build/linux/debian_sid_arm64-sysroot"
    ln -s "$V8_SYSROOT_AMD64" "$work/rusty_v8/build/linux/debian_bullseye_amd64-sysroot"
    ln -s "$V8_SYSROOT_ARM64" "$work/rusty_v8/build/linux/debian_bullseye_arm64-sysroot"

    shim_dir="$output/linux-abi-shims"
    mkdir -p "$shim_dir"
    memfd_source="$work/deno/tools/memfd_create_shim.c"
    math_source="$work/deno/tools/glibc_math_shim.c"
    [[ "$(sha256_file "$memfd_source")" == "82d1a89315445969e7451311f1e3d6735df568e312b9debecd2f3ae1390dbbe7" ]] || {
      echo "memfd compatibility shim differs from the pinned Deno source" >&2; exit 65;
    }
    [[ "$(sha256_file "$math_source")" == "69eba0766d139305978e347fd7289f41252c492a677003a21173797f24e9413f" ]] || {
      echo "glibc math compatibility shim differs from the pinned Deno source" >&2; exit 65;
    }
    memfd_shim="$shim_dir/memfd_create_shim.o"
    math_shim="$shim_dir/glibc_math_shim.o"
    "$clang" --target="$BUILD_TARGET" --sysroot="$DENO_SYSROOT" -fPIC -c "$memfd_source" -o "$memfd_shim"
    "$clang" --target="$BUILD_TARGET" --sysroot="$DENO_SYSROOT" -fPIC -c "$math_source" -o "$math_shim"
  fi
  # Preserve the pinned Deno Cargo configuration verbatim, especially its
  # macOS 12 deployment target and target-specific weak-framework/linker
  # flags. Only append the reviewable offline vendor and local-v8 overrides.
  upstream_cargo_config="$work/deno/.cargo/config.toml"
  upstream_cargo_config_sha="$(sha256_file "$upstream_cargo_config")"
  [[ "$upstream_cargo_config_sha" == "5fdfe697f7511c9b4d4ae5a3446bb13398da11d12c43ae5d0e55246465a453d4" ]] || {
    echo "pinned Deno Cargo configuration differs from f39575e" >&2; exit 65;
  }
  cat >> "$upstream_cargo_config" <<EOF

# SLV source rebuild overrides: append-only to retain the pinned upstream
# target configuration, including macOS deployment and linker settings.
[source.crates-io]
replace-with = "vendored-sources"

[source.vendored-sources]
directory = "$cargo_vendor"

[net]
offline = true

[patch.crates-io]
v8 = { path = "$work/rusty_v8" }
EOF
else
  [[ -f "$work/deno/Cargo.lock" && -f "$work/deno/.cargo/config.toml" && -L "$work/rusty_v8/third_party/rust-toolchain" && -d "$output/target" ]] || {
    echo "resume requires the existing isolated worktree, derived config, toolchain link, and target" >&2
    exit 65
  }
fi

source_lock="$deno_source/Cargo.lock"
source_lock_sha="$(sha256_file "$source_lock")"
assert_only_local_v8_relink() {
  "$PYTHON" - "$source_lock" "$work/deno/Cargo.lock" <<'PY'
import json
import sys
import tomllib

original = tomllib.load(open(sys.argv[1], 'rb')).get('package', [])
derived = tomllib.load(open(sys.argv[2], 'rb')).get('package', [])
registry = 'registry+https://github.com/rust-lang/crates.io-index'

def canonical(package):
    return json.dumps(package, sort_keys=True, separators=(',', ':'))

original_v8 = [p for p in original if p.get('name') == 'v8' and p.get('version') == '149.4.0' and p.get('source') == registry]
derived_v8 = [p for p in derived if p.get('name') == 'v8' and p.get('version') == '149.4.0' and 'source' not in p and 'checksum' not in p]
if len(original_v8) != 1 or len(derived_v8) != 1:
    raise SystemExit('derived lock must replace exactly one registry v8 149.4.0 entry with one local path entry')
if original_v8[0].get('dependencies') != derived_v8[0].get('dependencies'):
    raise SystemExit('local v8 path override changed the v8 dependency list')

remaining_original = sorted(canonical(p) for p in original if p is not original_v8[0])
remaining_derived = sorted(canonical(p) for p in derived if p is not derived_v8[0])
if remaining_original != remaining_derived:
    raise SystemExit('derived lock changed packages other than the approved local v8 path override')
PY
}
if [[ "$resume" == true ]]; then
  log="$output/baseline-denort-resume.log"
  receipt="$output/baseline-denort-resume-receipt.env"
else
  log="$output/baseline-denort.log"
  receipt="$output/baseline-denort-receipt.env"
fi
for forbidden in RUSTFLAGS CARGO_ENCODED_RUSTFLAGS RUSTC_WRAPPER RUSTC_WORKSPACE_WRAPPER CC CXX AR LD RANLIB CFLAGS CXXFLAGS LDFLAGS SCCACHE_CACHE_SIZE SCCACHE_DIR CCACHE_DIR; do
  [[ -z "${!forbidden:-}" ]] || { echo "ambient compiler override is forbidden: $forbidden" >&2; exit 65; }
done
if [[ -n "${GN_ARGS+x}" && "$GN_ARGS" != "use_glib=false" ]]; then
  echo "GN_ARGS must be exactly use_glib=false" >&2
  exit 65
fi
if [[ -n "${EXTRA_GN_ARGS+x}" && "$EXTRA_GN_ARGS" != "use_lld=true" ]]; then
  echo "EXTRA_GN_ARGS must be exactly use_lld=true" >&2
  exit 65
fi
jobs="${JOBS:-2}"
# CI calls the driver with JOBS=2.  A reviewer may use up to eight isolated
# local jobs; accepting a bounded local override does not alter CI evidence.
[[ "$jobs" =~ ^([1-9]|1[0-6])$ ]] || { echo "JOBS must be an integer from 1 through 16" >&2; exit 65; }
started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
export PATH="$rust_bin:$CLANG_BASE_PATH/bin:/usr/bin:/bin"
export RUSTC="$rustc"
export CARGO_HOME="$output/cargo-home"
export CARGO_TARGET_DIR="$output/target"
export CARGO_NET_OFFLINE=true
export V8_FROM_SOURCE=true
unset RUSTY_V8_ARCHIVE
# NINJA_LAUNCHER_GENERATOR_BEGIN
write_ninja_launcher() {
  local launcher="$output/pinned-ninja-launcher.py"
  "$PYTHON" - "$launcher" "$pinned_ninja" <<'PYEOF'
import pathlib
import sys

launcher = pathlib.Path(sys.argv[1])
pinned_ninja = sys.argv[2]
launcher.write_text(
    f'''#!{sys.executable}
import os
import sys

pinned_ninja = {pinned_ninja!r}
environment = os.environ.copy()
for key in tuple(environment):
    if key == 'BINDGEN_EXTRA_CLANG_ARGS' or key.startswith('BINDGEN_EXTRA_CLANG_ARGS_'):
        del environment[key]
os.execve(pinned_ninja, [pinned_ninja, *sys.argv[1:]], environment)
''',
    encoding='utf-8',
)
PYEOF
  chmod 0755 "$launcher"
  printf '%s\n' "$launcher"
}
# NINJA_LAUNCHER_GENERATOR_END
ninja_launcher="$(write_ninja_launcher)"
[[ -x "$ninja_launcher" ]] || {
  echo "generated Ninja launcher is not executable: $ninja_launcher" >&2
  exit 65
}
NINJA="$ninja_launcher"
export GN NINJA CLANG_BASE_PATH LIBCLANG_PATH
export PYTHON
export PYTHONDONTWRITEBYTECODE=1
export GN_ARGS="use_glib=false"
if [[ "$linux_target" == true ]]; then
  # Use the pinned Chromium sysroot headers instead of host glibc headers.
  export GN_ARGS="$GN_ARGS use_sysroot=true"
fi
export EXTRA_GN_ARGS="use_lld=true"
# rusty_v8 supplies its own ordered custom-libc++ arguments. Other vendored
# build scripts such as libsqlite3-sys call bindgen directly, so every bindgen
# caller receives the same pinned Clang resource headers and Linux ABI sysroot.
export BINDGEN_EXTRA_CLANG_ARGS="-isystem$resource_dir/include"
target_args=()
linker_driver_probe_log="$output/linker-driver-probe.log"
macos_bindgen_preflight_receipt=""
macos_bindgen_preflight_log=""
macos_bindgen_preflight_status=0
if [[ "$linux_target" == true ]]; then
  target_key="${BUILD_TARGET^^}"
  target_key="${target_key//-/_}"
  target_cc_flags="--target=$BUILD_TARGET --sysroot=$DENO_SYSROOT --ld-path=$SLV_LINKER -L$denolib -L$denosyslib"
  target_rust_flags="-C linker=$clang -C link-arg=--target=$BUILD_TARGET -C link-arg=--ld-path=$SLV_LINKER -C link-arg=--sysroot=$DENO_SYSROOT -C link-arg=-L$denolib -C link-arg=-L$denosyslib -C link-arg=$memfd_shim -C link-arg=$math_shim -C link-arg=-Wl,--wrap=expf -C link-arg=-Wl,--wrap=powf -C link-arg=-Wl,--wrap=exp2f -C link-arg=-Wl,--wrap=log2f -C link-arg=-Wl,--wrap=logf"
  export CARGO_BUILD_TARGET="$BUILD_TARGET"
  export "CARGO_TARGET_${target_key}_LINKER=$clang"
  export "CARGO_TARGET_${target_key}_RUSTFLAGS=$target_rust_flags"
  export "CC_${BUILD_TARGET//-/_}=$clang"
  export "CXX_${BUILD_TARGET//-/_}=$CLANG_BASE_PATH/bin/clang++"
  export "CFLAGS_${BUILD_TARGET//-/_}=$target_cc_flags"
  export "CXXFLAGS_${BUILD_TARGET//-/_}=$target_cc_flags"
  export BINDGEN_EXTRA_CLANG_ARGS="--target=$BUILD_TARGET --sysroot=$DENO_SYSROOT -isystem$resource_dir/include"
  "$clang" --target="$BUILD_TARGET" --sysroot="$DENO_SYSROOT" --ld-path="$SLV_LINKER" \
    -### -x c /dev/null -o "$output/linker-driver-probe" \
    > /dev/null 2>"$linker_driver_probe_log"
  grep -F -- "$SLV_LINKER" "$linker_driver_probe_log" >/dev/null || {
    echo "target C linker probe did not select the pinned LLVM ld.lld" >&2
    exit 65
  }
  target_args=(--target "$BUILD_TARGET")
  preflight_script="$(dirname "$0")/linux-sysroot-preflight.sh"
  [[ -x "$preflight_script" ]] || { echo "missing frozen Linux ABI preflight recipe: $preflight_script" >&2; exit 65; }
  export MEMFD_SHIM="$memfd_shim"
  export MATH_SHIM="$math_shim"
  "$preflight_script" "$output/linux-abi-preflight" "$work/deno"
  preflight_receipt="$output/linux-abi-preflight/preflight.json"
  [[ -f "$preflight_receipt" ]] || { echo "Linux ABI preflight did not emit receipt" >&2; exit 65; }
else
  preflight_receipt=""
  case "$(uname -m)" in
    x86_64) apple_link_target=x86_64-apple-darwin; apple_link_flags=() ;;
    arm64) apple_link_target=aarch64-apple-darwin; apple_link_flags=(-fuse-ld=lld) ;;
    *) echo "unsupported macOS architecture for linker receipt: $(uname -m)" >&2; exit 65 ;;
  esac
  # Bindgen reads this variable through shlex. Serialize its token list with
  # Python instead of relying on compiler-style concatenation, so the selected
  # SDK and paired Clang resource directory survive paths containing spaces.
  # MACOS_BINDGEN_ARGS_BEGIN
  apple_bindgen_args=(
    "--target=$apple_link_target"
    -isysroot
    "$SLV_APPLE_SDK_PATH"
    -isystem
    "$resource_dir/include"
  )
  BINDGEN_EXTRA_CLANG_ARGS="$("$PYTHON" - "${apple_bindgen_args[@]}" <<'PYEOF'
import shlex
import sys
print(shlex.join(sys.argv[1:]))
PYEOF
  )"
  export BINDGEN_EXTRA_CLANG_ARGS
  # MACOS_BINDGEN_ARGS_END
  # Preserve upstream Cargo flags as the actual Rust configuration. This
  # lightweight Clang trace records the effective native C driver selection
  # without asserting that x86_64 macOS must use the task-local lld.
  "$clang" -target "$apple_link_target" -isysroot "$SLV_APPLE_SDK_PATH" \
    ${apple_link_flags[@]+"${apple_link_flags[@]}"} -### -x c /dev/null -o "$output/linker-driver-probe" \
    > /dev/null 2>"$linker_driver_probe_log"
  macos_bindgen_preflight_dir="$output/macos-bindgen-preflight"
  macos_bindgen_preflight_receipt="$macos_bindgen_preflight_dir/preflight.json"
  macos_bindgen_preflight_log="$macos_bindgen_preflight_dir/diagnostics.log"
  if write_macos_bindgen_preflight "$macos_bindgen_preflight_dir"; then
    macos_bindgen_preflight_status=0
  else
    macos_bindgen_preflight_status=$?
  fi
  [[ -f "$macos_bindgen_preflight_receipt" && -f "$macos_bindgen_preflight_log" ]] || {
    echo "macOS bindgen preflight did not emit its receipt and diagnostics" >&2
    exit 65
  }
fi

# `generate-lockfile` happens only in the disposable copy.  It turns the
# upstream registry v8 entry into the local exact path entry; every subsequent
# build is locked and offline.  The source archive's original lock is checked
# again below and its hash is included in the receipt.
# CARGO_BUILD_GUARD_BEGIN
if [[ "$macos_bindgen_preflight_status" -ne 0 ]]; then
  status="$macos_bindgen_preflight_status"
  : > "$log"
  printf 'macOS bindgen preflight failed before Cargo (exit %s)\n' "$status" >> "$log"
else
  set +e
  if [[ "$resume" == true ]]; then
    (
      cd "$work/deno"
      "$cargo" build --locked --offline --release ${target_args[@]+"${target_args[@]}"} -j "$jobs" -p denort
    ) > >(tee "$log") 2>&1
  else
    (
      cd "$work/deno"
      "$cargo" generate-lockfile --offline
      assert_only_local_v8_relink || exit $?
      cp Cargo.lock "$output/derived-relink-Cargo.lock"
      "$cargo" build --locked --offline --release ${target_args[@]+"${target_args[@]}"} -j "$jobs" -p denort
    ) > >(tee "$log") 2>&1
  fi
  status=$?
  set -e
fi
# CARGO_BUILD_GUARD_END
if [[ "$status" -eq 0 ]]; then
  assert_only_local_v8_relink
fi
finished="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
resource_end="$(resource_snapshot "$output")"

release_root="$output/target/release"
if [[ -n "${BUILD_TARGET:-}" ]]; then
  release_root="$output/target/$BUILD_TARGET/release"
fi
denort="$release_root/denort"
# rusty_v8's source build writes its GN output under Cargo's release target,
# rather than beneath Cargo's per-crate build directory.  Require these
# concrete outputs after a successful build so a receipt cannot claim a
# source-built runtime without the native archive and the GN link description.
v8_archive="$release_root/gn_out/obj/librusty_v8.a"
v8_ninja="$release_root/gn_out/obj/rusty_v8.ninja"
linux_denort_abi_receipt=""
macos_denort_abi_receipt=""
if [[ "$status" -eq 0 && "$linux_target" == true ]]; then
  abi_dir="$output/linux-denort-abi"
  mkdir -p "$abi_dir"
  /usr/bin/readelf --version-info "$denort" >"$abi_dir/version-info.log"
  /usr/bin/readelf -d "$denort" >"$abi_dir/dynamic.log"
  "$PYTHON" - "$abi_dir" "$denort" <<'PYEOF'
import hashlib
import json
import pathlib
import re
import sys

directory = pathlib.Path(sys.argv[1])
binary = pathlib.Path(sys.argv[2])
version = (directory / 'version-info.log').read_text(errors='replace')
dynamic = (directory / 'dynamic.log').read_text(errors='replace')
if 'GLIBC_PRIVATE' in version:
    raise SystemExit('source-built denort imports GLIBC_PRIVATE')
observed = sorted({(int(a), int(b)) for a, b in re.findall(r'GLIBC_(\d+)\.(\d+)', version)})
if any(item > (2, 27) for item in observed):
    raise SystemExit('source-built denort imports GLIBC above 2.27: ' + repr(observed))
if re.search(r'\((?:RPATH|RUNPATH)\)', dynamic):
    raise SystemExit('source-built denort has RPATH/RUNPATH')
needed = re.findall(r'Shared library: \[([^]]+)\]', dynamic)
digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
payload = {
    'schema_version': 1,
    'kind': 'slv-linux-denort-abi',
    'denort_sha256': digest(binary),
    'glibc_versions': [f'{a}.{b}' for a, b in observed],
    'glibc_private': 'absent',
    'rpath_or_runpath': 'absent',
    'needed': needed,
    'logs': {name: digest(directory / name) for name in ('version-info.log', 'dynamic.log')},
    'status': 'passed',
}
(directory / 'receipt.json').write_text(json.dumps(payload, sort_keys=True, indent=2) + '\n')
PYEOF
  linux_denort_abi_receipt="$abi_dir/receipt.json"
fi
if [[ "$status" -eq 0 && "$(uname -s)" == "Darwin" ]]; then
  abi_dir="$output/macos-denort-abi"
  mkdir -p "$abi_dir"
  otool -l "$denort" >"$abi_dir/load-commands.log"
  "$PYTHON" - "$abi_dir" "$denort" <<'PYEOF'
import hashlib
import json
import pathlib
import re
import sys

directory = pathlib.Path(sys.argv[1])
binary = pathlib.Path(sys.argv[2])
text = (directory / 'load-commands.log').read_text(errors='replace')
match = re.search(r'cmd LC_BUILD_VERSION.*?minos\s+([0-9.]+)', text, re.S)
if not match:
    raise SystemExit('Mach-O LC_BUILD_VERSION minos is missing')
if match.group(1) != '12.0':
    raise SystemExit('source-built denort does not retain macOS 12.0 floor: ' + match.group(1))
digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
payload = {
    'schema_version': 1,
    'kind': 'slv-macos-denort-abi',
    'denort_sha256': digest(binary),
    'minimum_os': match.group(1),
    'load_commands_sha256': digest(directory / 'load-commands.log'),
    'status': 'passed',
}
(directory / 'receipt.json').write_text(json.dumps(payload, sort_keys=True, indent=2) + '\n')
PYEOF
  macos_denort_abi_receipt="$abi_dir/receipt.json"
fi
{
  printf 'schema_version=1\n'
  printf 'stage=baseline-denort\n'
  printf 'source_root=%s\n' "$root"
  printf 'source_deno=%s\n' "$(canonical_path "$deno_source")"
  printf 'source_rusty_v8=%s\n' "$(canonical_path "$rusty_v8_source")"
  printf 'cargo_vendor=%s\n' "$(canonical_path "$cargo_vendor")"
  printf 'run_mode=%s\n' "$([[ "$resume" == true ]] && printf resume || printf fresh)"
  printf 'recipe_path=%s\n' "$(canonical_path "$0")"
  printf 'recipe_sha256=%s\n' "$(sha256_file "$0")"
  printf 'source_selected_Cargo.lock_sha256=%s\n' "$source_lock_sha"
  printf 'upstream_Cargo.config_sha256=%s\n' "${upstream_cargo_config_sha:-$(sha256_file "$deno_source/.cargo/config.toml")}"
  printf 'work_Cargo.config_sha256=%s\n' "$(sha256_file "$work/deno/.cargo/config.toml")"
  printf 'work_relink_Cargo.lock_sha256=%s\n' "$(sha256_file "$work/deno/Cargo.lock")"
  printf 'python=%s\n' "$(canonical_path "$PYTHON")"
  printf 'python_version=%s\n' "$python_version"
  printf 'rustc=%s\n' "$("$rustc" --version)"
  printf 'cargo=%s\n' "$("$cargo" --version)"
  printf 'clang=%s\n' "$("$clang" --version | head -1)"
  printf 'clang_sha256=%s\n' "$(sha256_file "$clang")"
  printf 'libclang=%s\n' "$(canonical_path "$libclang")"
  printf 'libclang_sha256=%s\n' "$(sha256_file "$libclang")"
  printf 'clang_resource_dir=%s\n' "$resource_dir"
  printf 'bindgen_extra_clang_args=%s\n' "$BINDGEN_EXTRA_CLANG_ARGS"
  printf 'chromium_rust_toolchain=%s\n' "$CHROMIUM_RUST_TOOLCHAIN"
  printf 'chromium_rust_sentinel_sha256=%s\n' "$(sha256_file "$CHROMIUM_RUST_TOOLCHAIN/.rusty_v8_version")"
  printf 'gn_sha256=%s\n' "$(sha256_file "$GN")"
  printf 'ninja_sha256=%s\n' "$(sha256_file "$pinned_ninja")"
  printf 'ninja_path=%s\n' "$(canonical_path "$pinned_ninja")"
  printf 'ninja_launcher_path=%s\n' "$(canonical_path "$ninja_launcher")"
  printf 'ninja_launcher_sha256=%s\n' "$(sha256_file "$ninja_launcher")"
  printf 'ninja_environment_policy=remove-BINDGEN_EXTRA_CLANG_ARGS-and-BINDGEN_EXTRA_CLANG_ARGS_-prefix\n'
  printf 'gn_args=%s\n' "$GN_ARGS"
  printf 'extra_gn_args=%s\n' "$EXTRA_GN_ARGS"
  printf 'pinned_linker=%s\n' "$(canonical_path "$SLV_LINKER")"
  printf 'pinned_linker_sha256=%s\n' "$(sha256_file "$SLV_LINKER")"
  printf 'effective_linker_driver_probe_log=%s\n' "$linker_driver_probe_log"
  printf 'effective_linker_driver_probe_log_sha256=%s\n' "$(sha256_file "$linker_driver_probe_log")"
  printf 'build_target=%s\n' "${BUILD_TARGET:-native}"
  printf 'release_root=%s\n' "$release_root"
  printf 'host_os=%s\n' "$(uname -s)"
  printf 'host_arch=%s\n' "$(uname -m)"
  [[ -n "$apple_xcode" ]] && printf 'apple_xcode=%s\n' "$apple_xcode"
  [[ -n "$apple_sdk_path" ]] && printf 'apple_sdk_path=%s\n' "$apple_sdk_path"
  [[ -n "$apple_sdk_version" ]] && printf 'apple_sdk_version=%s\n' "$apple_sdk_version"
  if [[ -n "$macos_bindgen_preflight_receipt" ]]; then
    printf 'macos_bindgen_preflight_receipt=%s\n' "$macos_bindgen_preflight_receipt"
    printf 'macos_bindgen_preflight_receipt_sha256=%s\n' "$(sha256_file "$macos_bindgen_preflight_receipt")"
    printf 'macos_bindgen_preflight_diagnostics_log=%s\n' "$macos_bindgen_preflight_log"
    printf 'macos_bindgen_preflight_diagnostics_log_sha256=%s\n' "$(sha256_file "$macos_bindgen_preflight_log")"
    printf 'macos_bindgen_preflight_status=%s\n' "$macos_bindgen_preflight_status"
  fi
  if [[ "$linux_target" == true ]]; then
    printf 'deno_sysroot=%s\n' "$(canonical_path "$DENO_SYSROOT")"
    printf 'deno_sysroot_sha256=%s\n' "$DENO_SYSROOT_SHA256"
    printf 'deno_sysroot_env_sha256=%s\n' "$(sha256_file "$DENO_SYSROOT/.env")"
    printf 'deno_sysroot_target_arch=%s\n' "$linux_arch"
    printf 'v8_sysroot_amd64=%s\n' "$(canonical_path "$V8_SYSROOT_AMD64")"
    printf 'v8_sysroot_amd64_sha256=%s\n' "$V8_SYSROOT_AMD64_SHA256"
    printf 'v8_sysroot_arm64=%s\n' "$(canonical_path "$V8_SYSROOT_ARM64")"
    printf 'v8_sysroot_arm64_sha256=%s\n' "$V8_SYSROOT_ARM64_SHA256"
    printf 'rusty_v8_sysroot_alias_amd64=%s\n' "$(canonical_path "$work/rusty_v8/build/linux/debian_sid_amd64-sysroot")"
    printf 'rusty_v8_sysroot_alias_arm64=%s\n' "$(canonical_path "$work/rusty_v8/build/linux/debian_sid_arm64-sysroot")"
    printf 'rusty_v8_bullseye_sysroot_alias_amd64=%s\n' "$(canonical_path "$work/rusty_v8/build/linux/debian_bullseye_amd64-sysroot")"
    printf 'rusty_v8_bullseye_sysroot_alias_arm64=%s\n' "$(canonical_path "$work/rusty_v8/build/linux/debian_bullseye_arm64-sysroot")"
    printf 'memfd_shim_source_sha256=%s\n' "$(sha256_file "$work/deno/tools/memfd_create_shim.c")"
    printf 'memfd_shim_object_sha256=%s\n' "$(sha256_file "$memfd_shim")"
    printf 'glibc_math_shim_source_sha256=%s\n' "$(sha256_file "$work/deno/tools/glibc_math_shim.c")"
    printf 'glibc_math_shim_object_sha256=%s\n' "$(sha256_file "$math_shim")"
    [[ "$BUILD_TARGET" == "aarch64-unknown-linux-gnu" ]] && printf 'cross_linker=%s\n' "$(canonical_path "$CROSS_LINKER")"
    printf 'linux_preflight_receipt=%s\n' "$preflight_receipt"
    printf 'linux_preflight_receipt_sha256=%s\n' "$(sha256_file "$preflight_receipt")"
    [[ -n "$linux_denort_abi_receipt" ]] && printf 'linux_denort_abi_receipt=%s\n' "$linux_denort_abi_receipt"
    [[ -n "$linux_denort_abi_receipt" ]] && printf 'linux_denort_abi_receipt_sha256=%s\n' "$(sha256_file "$linux_denort_abi_receipt")"
  fi
  [[ -n "$macos_denort_abi_receipt" ]] && printf 'macos_denort_abi_receipt=%s\n' "$macos_denort_abi_receipt"
  [[ -n "$macos_denort_abi_receipt" ]] && printf 'macos_denort_abi_receipt_sha256=%s\n' "$(sha256_file "$macos_denort_abi_receipt")"
  printf 'command_env_allowlist=BINDGEN_EXTRA_CLANG_ARGS,BUILD_TARGET,CARGO,CARGO_BUILD_TARGET,CARGO_HOME,CARGO_NET_OFFLINE,CARGO_TARGET_DIR,CARGO_VENDOR_DIR,CHROMIUM_RUST_TOOLCHAIN,CLANG_BASE_PATH,CROSS_LINKER,DENO_SOURCE_DIR,EXTRA_GN_ARGS,DENO_SYSROOT,DENO_SYSROOT_SHA256,DEVELOPER_DIR,GN,GN_ARGS,HOME,JOBS,LIBCLANG_PATH,NINJA,PATH,PYTHON,PYTHONDONTWRITEBYTECODE,RUSTC,RUSTY_V8_SOURCE_DIR,SLV_APPLE_SDK_PATH,SLV_LINKER,V8_FROM_SOURCE,V8_SYSROOT_AMD64,V8_SYSROOT_AMD64_SHA256,V8_SYSROOT_ARM64,V8_SYSROOT_ARM64_SHA256\n'
  printf 'cleared_ambient_compiler_variables=RUSTFLAGS,CARGO_ENCODED_RUSTFLAGS,RUSTC_WRAPPER,RUSTC_WORKSPACE_WRAPPER,CC,CXX,AR,LD,RANLIB,CFLAGS,CXXFLAGS,LDFLAGS,SCCACHE_CACHE_SIZE,SCCACHE_DIR,CCACHE_DIR\n'
  printf 'command=%s\n' "cargo generate-lockfile --offline && cargo build --locked --offline --release [--target BUILD_TARGET] -j $jobs -p denort"
  printf 'started_at=%s\n' "$started"
  printf 'finished_at=%s\n' "$finished"
  printf 'resource_start=%s\n' "$resource_start"
  printf 'resource_end=%s\n' "$resource_end"
  printf 'exit_code=%s\n' "$status"
  printf 'log_sha256=%s\n' "$(sha256_file "$log")"
  [[ -f "$output/derived-relink-Cargo.lock" ]] && printf 'derived_relink_Cargo.lock_sha256=%s\n' "$(sha256_file "$output/derived-relink-Cargo.lock")"
  [[ -f "$denort" ]] && printf 'denort_sha256=%s\n' "$(sha256_file "$denort")"
  [[ -f "$v8_archive" ]] && printf 'librusty_v8_archive=%s\n' "$v8_archive"
  [[ -f "$v8_archive" ]] && printf 'librusty_v8_sha256=%s\n' "$(sha256_file "$v8_archive")"
  [[ -f "$v8_ninja" ]] && printf 'rusty_v8_ninja=%s\n' "$v8_ninja"
  [[ -f "$v8_ninja" ]] && printf 'rusty_v8_ninja_sha256=%s\n' "$(sha256_file "$v8_ninja")"
} > "$receipt"

if [[ "$status" -ne 0 ]]; then
  exit "$status"
fi
[[ -x "$denort" ]] || exit 66
[[ -f "$v8_archive" && -f "$v8_ninja" ]] || {
  echo "source build did not produce required V8 archive/Ninja evidence" >&2
  exit 66
}
