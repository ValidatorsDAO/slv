#!/usr/bin/env bash
set -euo pipefail

# Compile-only target ABI gate used before the expensive V8 build. It exercises
# libc subprocess/thread/math calls, the exact bundled SQLite C binding source,
# and Rust's target standard library. It intentionally runs neither a foreign
# target nor an unpinned system linker.
if [[ $# -ne 2 ]]; then
  echo "usage: $0 OUTPUT_DIR DENO_SOURCE_DIR" >&2
  exit 64
fi
out="$1"
deno_source="$2"
: "${BUILD_TARGET:?BUILD_TARGET is required}"
: "${DENO_SYSROOT:?DENO_SYSROOT is required}"
: "${CLANG_BASE_PATH:?CLANG_BASE_PATH is required}"
: "${SLV_LINKER:?SLV_LINKER is required}"
: "${RUSTC:?RUSTC is required}"
: "${CARGO_VENDOR_DIR:?CARGO_VENDOR_DIR is required}"
: "${MEMFD_SHIM:?MEMFD_SHIM is required}"
: "${MATH_SHIM:?MATH_SHIM is required}"
: "${PYTHON:?PYTHON is required}"
clang="$CLANG_BASE_PATH/bin/clang"
readelf="${READELF:-/usr/bin/readelf}"
[[ -x "$clang" && -x "$RUSTC" && -x "$readelf" && -x "$PYTHON" ]] || {
  echo "preflight requires declared clang, rustc, Python, and readelf" >&2; exit 65;
}
case "$BUILD_TARGET" in
  x86_64-unknown-linux-gnu) target_arch=x86_64-linux-gnu ;;
  aarch64-unknown-linux-gnu) target_arch=aarch64-linux-gnu ;;
  *) echo "unsupported Linux target: $BUILD_TARGET" >&2; exit 65 ;;
esac
[[ -f "$DENO_SYSROOT/usr/include/pthread.h" && -f "$DENO_SYSROOT/usr/include/math.h" && -f "$DENO_SYSROOT/usr/lib/$target_arch/crt1.o" ]] || {
  echo "pinned sysroot lacks required C headers or CRT" >&2; exit 65;
}
sqlite_dir="$CARGO_VENDOR_DIR/libsqlite3-sys-0.38.1/sqlite3"
[[ -f "$sqlite_dir/sqlite3.c" && -f "$sqlite_dir/sqlite3.h" ]] || {
  echo "selected vendor lacks libsqlite3-sys 0.38.1 bundled source" >&2; exit 65;
}
mkdir -p "$out"
for name in c-probe rust-probe sqlite3.o preflight.json; do
  [[ ! -e "$out/$name" ]] || { echo "preflight output already exists: $out/$name" >&2; exit 65; }
done
cat > "$out/c-probe.c" <<'C'
#include <math.h>
#include <pthread.h>
#include <sqlite3.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

static void *thread_probe(void *arg) { return arg; }
int main(void) {
  pthread_t thread;
  if (pthread_create(&thread, 0, thread_probe, 0) != 0) return 10;
  if (pthread_join(thread, 0) != 0) return 11;
  if (fork() == 0) _exit(0);
  if (waitpid(-1, 0, 0) < 0) return 12;
  return sqlite3_libversion_number() > 0 && sin(0.5) > 0.0 ? 0 : 13;
}
C
cat > "$out/rust-probe.rs" <<'RS'
use std::process::Command;
fn main() {
  let joined = std::thread::spawn(|| (0.5_f32).sin()).join().unwrap();
  assert!(joined > 0.0);
  let _ = Command::new("/bin/true").status();
}
RS
link_flags=(
  "--target=$BUILD_TARGET"
  "--sysroot=$DENO_SYSROOT"
  "--ld-path=$SLV_LINKER"
  "-L$DENO_SYSROOT/lib/$target_arch"
  "-L$DENO_SYSROOT/usr/lib/$target_arch"
  "$MEMFD_SHIM"
  "$MATH_SHIM"
  "-Wl,--wrap=expf"
  "-Wl,--wrap=powf"
  "-Wl,--wrap=exp2f"
  "-Wl,--wrap=log2f"
  "-Wl,--wrap=logf"
)
"$clang" --target="$BUILD_TARGET" --sysroot="$DENO_SYSROOT" -fPIC \
  -I"$sqlite_dir" -c "$sqlite_dir/sqlite3.c" -o "$out/sqlite3.o" \
  >"$out/sqlite-compile.log" 2>&1
"$clang" --target="$BUILD_TARGET" --sysroot="$DENO_SYSROOT" \
  --ld-path="$SLV_LINKER" -### "$out/c-probe.c" "$out/sqlite3.o" \
  -I"$sqlite_dir" -o "$out/c-probe" \
  > /dev/null 2>"$out/linker-driver.log"
grep -F -- "$SLV_LINKER" "$out/linker-driver.log" >/dev/null || {
  echo "C preflight did not select the declared pinned ld.lld" >&2; exit 65;
}
"$clang" "$out/c-probe.c" "$out/sqlite3.o" -I"$sqlite_dir" -o "$out/c-probe" \
  "${link_flags[@]}" -lpthread -ldl -lm >"$out/c-link.log" 2>&1
rust_args=(
  "--target" "$BUILD_TARGET"
  "-C" "linker=$clang"
)
for flag in "${link_flags[@]}"; do
  rust_args+=("-C" "link-arg=$flag")
done
"$RUSTC" "$out/rust-probe.rs" "${rust_args[@]}" -o "$out/rust-probe" \
  >"$out/rust-link.log" 2>&1
"$readelf" --version-info "$out/c-probe" >"$out/c-version-info.log"
"$readelf" --version-info "$out/rust-probe" >"$out/rust-version-info.log"
"$PYTHON" - "$out" "$BUILD_TARGET" "$DENO_SYSROOT" "$clang" "$SLV_LINKER" "$RUSTC" "$MEMFD_SHIM" "$MATH_SHIM" <<'PY'
import hashlib
import json
import pathlib
import re
import sys

out = pathlib.Path(sys.argv[1])
target = sys.argv[2]
sysroot = sys.argv[3]
clang = pathlib.Path(sys.argv[4])
linker = pathlib.Path(sys.argv[5])
rustc = pathlib.Path(sys.argv[6])
memfd_shim = pathlib.Path(sys.argv[7])
math_shim = pathlib.Path(sys.argv[8])

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def requirements(path):
    data = path.read_text(errors='replace')
    if 'GLIBC_PRIVATE' in data:
        raise SystemExit('GLIBC_PRIVATE is forbidden in ' + path.name)
    versions = []
    for major, minor in re.findall(r'GLIBC_(\d+)\.(\d+)', data):
        versions.append((int(major), int(minor)))
    if any(version > (2, 27) for version in versions):
        raise SystemExit('GLIBC requirement above 2.27 in ' + path.name + ': ' + repr(sorted(set(versions))))
    return ['%d.%d' % item for item in sorted(set(versions))]

artifacts = {}
for name in ('sqlite3.o', 'c-probe', 'rust-probe'):
    path = out / name
    if not path.is_file():
        raise SystemExit('missing preflight artifact: ' + name)
    artifacts[name] = {'sha256': digest(path), 'size': path.stat().st_size}
logs = {}
for name in ('sqlite-compile.log', 'linker-driver.log', 'c-link.log', 'rust-link.log', 'c-version-info.log', 'rust-version-info.log'):
    path = out / name
    logs[name] = {'sha256': digest(path), 'size': path.stat().st_size}
receipt = {
    'schema_version': 1,
    'kind': 'slv-linux-sysroot-preflight',
    'target': target,
    'sysroot': sysroot,
    'acceptance': {
        'c_subprocess_thread_math_sqlite_binding_link': 'passed',
        'rust_subprocess_thread_math_link': 'passed',
        'glibc_requirement_ceiling': '2.27',
        'c_glibc_versions': requirements(out / 'c-version-info.log'),
        'rust_glibc_versions': requirements(out / 'rust-version-info.log'),
        'glibc_private': 'absent',
    },
    'artifacts': artifacts,
    'toolchain': {
        'clang_sha256': digest(clang),
        'linker_sha256': digest(linker),
        'rustc_sha256': digest(rustc),
        'memfd_shim_sha256': digest(memfd_shim),
        'glibc_math_shim_sha256': digest(math_shim),
    },
    'logs': logs,
}
(out / 'preflight.json').write_text(json.dumps(receipt, sort_keys=True, indent=2) + '\n')
PY
