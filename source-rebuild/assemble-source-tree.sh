#!/usr/bin/env bash
set -euo pipefail

# Materialize a build input from immutable upstream bytes and tracked source
# files only.  Do not point this at a previous build tree: generated target/
# files, GN output, downloaded compilers, and Git object stores must never be
# accepted as source release material.
#
# Usage:
#   assemble-source-tree.sh DENO_SRC_TAR_GZ RUSTY_V8_GIT_ROOT CARGO_VENDOR OUT

if [[ $# -ne 4 ]]; then
  echo "usage: $0 DENO_SRC_TAR_GZ RUSTY_V8_GIT_ROOT CARGO_VENDOR OUT" >&2
  exit 64
fi

deno_archive="$(readlink -f "$1")"
rusty_repo="$(readlink -f "$2")"
vendor="$(readlink -f "$3")"
out="$4"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
release_root="$(cd "$script_dir/.." && pwd -P)"
pins="$release_root/source-materials/pins.json"
materials="$release_root/scripts/release/source-materials.ts"

[[ -f "$deno_archive" && -d "$rusty_repo" && -d "$vendor" && -f "$pins" && -f "$materials" ]] || {
  echo "assembly inputs are missing" >&2
  exit 65
}
if [[ -e "$out" ]]; then
  if [[ ! -d "$out" ]] || [[ -n "$(find "$out" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
    echo "output must be a new or empty directory: $out" >&2
    exit 65
  fi
else
  mkdir -p "$out"
fi
out="$(cd "$out" && pwd -P)"

expected_deno_sha=58da10e48968a80a6c205b31584d1f1f4583226e59ebb08cb3783b12e7f22d4d
actual_deno_sha="$(sha256sum "$deno_archive" | awk '{print $1}')"
[[ "$actual_deno_sha" == "$expected_deno_sha" ]] || {
  echo "Deno archive hash does not match the 2.9.3 source pin" >&2
  exit 65
}
[[ "$(git -C "$rusty_repo" rev-parse HEAD)" == "dd1b4e9c743b7a11dbeb99d4d0dc55979218b905" ]] || {
  echo "rusty_v8 checkout does not match the pinned commit" >&2
  exit 65
}
[[ "$(git -C "$rusty_repo" -c submodule.recurse=true status --porcelain --ignore-submodules=none)" == "" ]] || {
  echo "rusty_v8 checkout is dirty; refusing to copy working-tree bytes" >&2
  exit 65
}
[[ "$(git -C "$rusty_repo" ls-tree HEAD v8 | awk '{print $3}')" == "73d19698991616a34a00ca691a6e697dbb69e2ef" ]] || {
  echo "rusty_v8's V8 gitlink does not match the pinned commit" >&2
  exit 65
}
if git -C "$rusty_repo" submodule status --recursive | awk '$1 ~ /^[+-]/ { exit 1 }'; then :; else
  echo "rusty_v8 has an uninitialized or divergent submodule" >&2
  exit 65
fi

# Reject unsafe member names before extraction.  The official archive is
# expected to have exactly the deno/ root; keeping its original files avoids
# copying the mutated build worktree.
members="$out/.deno-members"
tar -tzf "$deno_archive" > "$members"
if ! awk 'BEGIN { ok = 1 } $0 !~ /^deno\// || $0 ~ /(^|\/)\.\.?(\/|$)/ { ok = 0 } END { exit ok ? 0 : 1 }' "$members"; then
  echo "Deno archive contains an unexpected or unsafe member path" >&2
  exit 65
fi
mkdir "$out/deno" "$out/rusty_v8" "$out/cargo-vendor"
tar --no-same-owner --no-same-permissions --strip-components=1 -xzf "$deno_archive" -C "$out/deno"

# git ls-files --recurse-submodules is an allow-list of tracked source.  It
# excludes native/deno/target, rusty_v8/third_party/rust-toolchain, .git, and
# every other local build/cache file without a broad target-name exclusion.
tracked="$out/.rusty-v8-tracked"
git -C "$rusty_repo" ls-files --cached --recurse-submodules -z > "$tracked"
tar -C "$rusty_repo" --null --files-from="$tracked" --create | tar -C "$out/rusty_v8" --extract
tar -C "$vendor" --create . | tar -C "$out/cargo-vendor" --extract
rm -- "$members" "$tracked"

for required in \
  "$out/deno/Cargo.lock" \
  "$out/deno/rust-toolchain.toml" \
  "$out/rusty_v8/Cargo.lock" \
  "$out/rusty_v8/src/binding.hpp" \
  "$out/rusty_v8/v8/BUILD.gn" \
  "$out/rusty_v8/v8/third_party/glibc/src/sysdeps/ieee754/dbl-64/s_sin.c"; do
  [[ -f "$required" ]] || { echo "assembly omitted required source: $required" >&2; exit 66; }
done

deno run --quiet --allow-read "$materials" assert-pure-source "$out"
SOURCE_ARCHIVE="$deno_archive" deno run --quiet --allow-read --allow-env "$materials" verify-pin "$pins" deno

{
  printf 'schema_version=1\n'
  printf 'assembly=tracked-source-only\n'
  printf 'deno_archive=%s\n' "$deno_archive"
  printf 'deno_archive_sha256=%s\n' "$actual_deno_sha"
  printf 'deno_archive_bytes=%s\n' "$(wc -c < "$deno_archive" | tr -d ' ')"
  printf 'rusty_v8_git_root=%s\n' "$rusty_repo"
  printf 'rusty_v8_commit=%s\n' "$(git -C "$rusty_repo" rev-parse HEAD)"
  printf 'v8_gitlink_commit=%s\n' "$(git -C "$rusty_repo" ls-tree HEAD v8 | awk '{print $3}')"
  printf 'rusty_v8_tracked_paths=%s\n' "$(git -C "$rusty_repo" ls-files --cached --recurse-submodules | wc -l | tr -d ' ')"
  printf 'cargo_vendor=%s\n' "$vendor"
  printf 'assembly_command=%s\n' 'extract pinned deno archive; git ls-files --cached --recurse-submodules; copy vendor'
} > "$out/assembly-receipt.env"

printf 'assembled pure source tree: %s\n' "$out"
