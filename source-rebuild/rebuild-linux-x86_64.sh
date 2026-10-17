#!/usr/bin/env bash
set -euo pipefail

# This recipe is intentionally split: bindgen is verified before asking the
# caller to perform a full denort rebuild.  A successful V8 archive without
# generated bindings is not a rebuild result.
#
# The source root must have these materialized children:
#   rusty_v8/     pinned rusty_v8 checkout, including V8 and submodules
#   cargo-vendor/ Cargo's locked registry source tree
#
# The compiler distributions are declared prerequisites, not source archives.
# RUST_BIN must point to the task-local Rust 1.95.0 bin directory.  GN, NINJA,
# CLANG_BASE_PATH, and LIBCLANG_PATH must name task-local tools.  In particular,
# LIBCLANG_PATH's parent must also provide bin/clang: rusty_v8's build.rs uses
# that compiler to locate its builtin headers.

stage="${1:-}"
root="${2:-}"
output="${3:-}"

if [[ "$stage" != "probe-bindings" || -z "$root" || -z "$output" ]]; then
  echo "usage: rebuild-linux-x86_64.sh probe-bindings EXTRACTED_SOURCE_ROOT OUTPUT_DIR" >&2
  exit 64
fi

root="$(cd "$root" && pwd -P)"
mkdir -p "$output"
output="$(cd "$output" && pwd -P)"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

rusty_v8="$root/rusty_v8"
vendor="$root/cargo-vendor"
for path in "$rusty_v8/Cargo.toml" "$rusty_v8/Cargo.lock" "$vendor"; do
  [[ -e "$path" ]] || { echo "missing source material: $path" >&2; exit 65; }
done

rust_bin="${RUST_BIN:?set RUST_BIN to the task-local Rust 1.95.0 bin directory}"
cargo="${CARGO:-$rust_bin/cargo}"
rustc="${RUSTC:-$rust_bin/rustc}"
[[ -x "$cargo" && -x "$rustc" ]] || { echo "missing task-local cargo or rustc" >&2; exit 65; }
"$rustc" --version | grep -q '^rustc 1\.95\.0 ' || {
  echo "Rust 1.95.0 is required for the pinned Deno 2.9.3 rebuild" >&2
  exit 65
}

: "${GN:?set GN to a task-local GN binary}"
: "${NINJA:?set NINJA to a task-local Ninja binary}"
: "${CLANG_BASE_PATH:?set CLANG_BASE_PATH to the pinned Chromium Clang prefix}"
: "${LIBCLANG_PATH:?set LIBCLANG_PATH to a task-local libclang directory}"
clang="$CLANG_BASE_PATH/bin/clang"
[[ -x "$GN" && -x "$NINJA" && -x "$clang" ]] || {
  echo "GN, Ninja, and CLANG_BASE_PATH/bin/clang must be executable" >&2
  exit 65
}
[[ -e "$LIBCLANG_PATH/libclang.so" ]] || {
  echo "LIBCLANG_PATH must contain libclang.so" >&2
  exit 65
}
libclang_clang="$(cd "$(dirname "$LIBCLANG_PATH")/bin" && pwd -P)/clang"
[[ -x "$libclang_clang" ]] || {
  echo "parent(LIBCLANG_PATH)/bin/clang must be executable" >&2
  exit 65
}
[[ "$(readlink -f "$libclang_clang")" == "$(readlink -f "$clang")" ]] || {
  echo "LIBCLANG_PATH and CLANG_BASE_PATH must identify the same clang" >&2
  exit 65
}
resource_dir="$($clang -print-resource-dir)"
[[ -f "$resource_dir/include/stddef.h" ]] || {
  echo "the selected Clang lacks builtin stddef.h: $resource_dir" >&2
  exit 65
}

work="$(mktemp -d "$output/binding-probe.XXXXXX")"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/src" "$work/.cargo"
cat > "$work/Cargo.toml" <<EOF
[package]
name = "slv-rusty-v8-binding-probe"
version = "0.0.0"
edition = "2024"
publish = false

[dependencies]
bindgen = "=0.72.1"

[workspace]
EOF
cp "$script_dir/binding-probe.rs" "$work/src/main.rs"
cat > "$work/.cargo/config.toml" <<EOF
[source.crates-io]
replace-with = "vendored-sources"

[source.vendored-sources]
directory = "$vendor"

[net]
offline = true
EOF

# This is deliberately a derived lock.  Do not overwrite rusty_v8/Cargo.lock
# or Deno's original Cargo.lock when substituting a local source tree.
export CARGO_HOME="${CARGO_HOME:-$output/cargo-home}"
export CARGO_NET_OFFLINE=true
export PYTHON="${PYTHON:-python3}"
# These are the exact Rusty V8 149.4.0 Linux/x86_64 source-build settings for
# Deno's denort dependency.  `gn gen --ide=json` only writes the input graph;
# it deliberately does not compile V8.  `use_glib=false` avoids discovering a
# host glib through pkg-config.
export GN_ARGS="${GN_ARGS:-is_debug=false use_custom_libcxx=true v8_enable_sandbox=false v8_enable_pointer_compression=false v8_enable_v8_checks=false rusty_v8_enable_simdutf=true clang_base_path=\"$CLANG_BASE_PATH\" use_glib=false v8_monolithic_for_shared_library=true}"
[[ "$GN_ARGS" == *'use_glib=false'* ]] || {
  echo "GN_ARGS must retain use_glib=false for the pinned standalone V8 build" >&2
  exit 65
}
export PATH="$rust_bin:$PATH"
export LD_LIBRARY_PATH="$LIBCLANG_PATH${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export RUSTC="$rustc"
export GN NINJA CLANG_BASE_PATH LIBCLANG_PATH

command_log="$output/binding-probe.log"
set +e
(
  cd "$work"
  "$cargo" generate-lockfile --offline
  cp Cargo.lock "$output/derived-binding-probe-Cargo.lock"
  gn_out="$output/gn-out"
  "$GN" --root="$rusty_v8" --script-executable="$PYTHON" gen "$gn_out" --ide=json --args="$GN_ARGS"
  PROBE_RUSTY_V8="$rusty_v8" PROBE_GN_OUT="$gn_out" PROBE_BINDING_OUTPUT="$output/src_binding.rs" \
    "$cargo" run --locked --offline --release
) > >(tee "$command_log") 2>&1
status=$?
set -e

binding="$output/src_binding.rs"
if [[ $status -eq 0 && ! -s "$binding" ]]; then
  echo "bindgen reported success but did not produce a non-empty src_binding.rs" | tee -a "$command_log" >&2
  status=66
fi

{
  printf 'schema_version=1\n'
  printf 'stage=binding-probe\n'
  printf 'source_root=%s\n' "$root"
  printf 'rusty_v8=%s\n' "$rusty_v8"
  printf 'cargo_vendor=%s\n' "$vendor"
  printf 'rustc=%s\n' "$("$rustc" --version)"
  printf 'cargo=%s\n' "$("$cargo" --version)"
  printf 'clang=%s\n' "$("$clang" --version | head -1)"
  printf 'clang_resource_dir=%s\n' "$resource_dir"
  printf 'libclang=%s\n' "$(readlink -f "$LIBCLANG_PATH/libclang.so")"
  printf 'gn_args=%s\n' "$GN_ARGS"
  printf 'gn_sha256=%s\n' "$(sha256sum "$GN" | awk '{print $1}')"
  printf 'ninja_sha256=%s\n' "$(sha256sum "$NINJA" | awk '{print $1}')"
  printf 'clang_sha256=%s\n' "$(sha256sum "$clang" | awk '{print $1}')"
  printf 'libclang_sha256=%s\n' "$(sha256sum "$LIBCLANG_PATH/libclang.so" | awk '{print $1}')"
  printf 'gn_project_sha256=%s\n' "$(sha256sum "$output/gn-out/project.json" | awk '{print $1}')"
  printf 'binding_probe_source_sha256=%s\n' "$(sha256sum "$script_dir/binding-probe.rs" | awk '{print $1}')"
  printf 'command_env_allowlist=CARGO_HOME,CARGO_NET_OFFLINE,CARGO_TARGET_DIR,CLANG_BASE_PATH,GN,GN_ARGS,LIBCLANG_PATH,NINJA,PATH,PYTHON,RUSTC\n'
  printf 'command=%s\n' 'cargo generate-lockfile --offline && gn gen --ide=json && cargo run --locked --offline --release'
  printf 'exit_code=%s\n' "$status"
  printf 'log_sha256=%s\n' "$(sha256sum "$command_log" | awk '{print $1}')"
  [[ -s "$binding" ]] && printf 'binding_sha256=%s\n' "$(sha256sum "$binding" | awk '{print $1}')"
  [[ -s "$binding" ]] && printf 'binding_bytes=%s\n' "$(wc -c < "$binding" | tr -d ' ')"
} > "$output/binding-probe-receipt.env"

[[ $status -eq 0 ]] || exit "$status"
