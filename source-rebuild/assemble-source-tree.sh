#!/usr/bin/env bash
set -euo pipefail

# Materialize a build input from immutable upstream bytes and checked-in source
# descriptors only.  Git trees are exported directly from verified commit/blob
# objects; this intentionally has no rusty_v8 working-tree argument.
#
# Usage:
#   assemble-source-tree.sh DENO_SRC_TAR_GZ GIT_OBJECT_CACHE CARGO_VENDOR OUT

if [[ $# -ne 4 ]]; then
  echo "usage: $0 DENO_SRC_TAR_GZ GIT_OBJECT_CACHE CARGO_VENDOR OUT" >&2
  exit 64
fi

deno_archive="$(readlink -f "$1")"
git_cache="$2"
vendor="$(readlink -f "$3")"
out="$4"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
release_root="$(cd "$script_dir/.." && pwd -P)"
pins="$release_root/source-materials/pins.json"
materials="$release_root/scripts/release/source-materials.ts"

[[ -f "$deno_archive" && -d "$vendor" && -f "$pins" && -f "$materials" ]] || {
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
mkdir -p "$git_cache"
git_cache="$(cd "$git_cache" && pwd -P)"

expected_deno_sha=58da10e48968a80a6c205b31584d1f1f4583226e59ebb08cb3783b12e7f22d4d
actual_deno_sha="$(sha256sum "$deno_archive" | awk '{print $1}')"
[[ "$actual_deno_sha" == "$expected_deno_sha" ]] || {
  echo "Deno archive hash does not match the 2.9.3 source pin" >&2
  exit 65
}

# Keep all helper-only state outside OUT. The materializer requires OUT to be
# empty and the object-store receipt to be absent when it begins.
temporary_directory="$(mktemp -d)"
trap 'rm -rf "$temporary_directory"' EXIT
members="$temporary_directory/deno-members"
object_receipt="$temporary_directory/rusty-v8-git-object-stores.json"

# Reject unsafe member names before extraction. The official archive is
# expected to have exactly the deno/ root; keeping its original files avoids
# copying a mutated build worktree.
tar -tzf "$deno_archive" > "$members"
if ! awk 'BEGIN { ok = 1 } $0 !~ /^deno\// || $0 ~ /(^|\/)\.\.?(\/|$)/ { ok = 0 } END { exit ok ? 0 : 1 }' "$members"; then
  echo "Deno archive contains an unexpected or unsafe member path" >&2
  exit 65
fi

# The TypeScript materializer checks the descriptor hash, derives the exact
# direct gitlink set from the pinned root commit, disables Git replacements,
# verifies each commit/tree/blob, and writes source-only legal supplements.
# Its local store receipt is deliberately outside OUT: source archives never
# contain host cache paths.
deno run --quiet --allow-read --allow-write --allow-run --allow-net "$materials" \
  materialize-rusty-v8-source "$release_root" "$pins" "$git_cache" "$out" "$object_receipt"

mkdir "$out/deno" "$out/cargo-vendor"
tar --no-same-owner --no-same-permissions --strip-components=1 -xzf "$deno_archive" -C "$out/deno"
tar -C "$vendor" --create . | tar -C "$out/cargo-vendor" --extract

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
  printf 'assembly=exact-git-object-source\n'
  printf 'deno_archive_sha256=%s\n' "$actual_deno_sha"
  printf 'deno_archive_bytes=%s\n' "$(wc -c < "$deno_archive" | tr -d ' ')"
  printf 'gitlink_descriptor_sha256=%s\n' "$(sha256sum "$release_root/source-materials/rusty-v8-gitlinks.json" | awk '{print $1}')"
  printf 'cargo_vendor_lock_sha256=%s\n' "$(sha256sum "$out/cargo-vendor/Cargo.lock" | awk '{print $1}')"
  printf 'assembly_command=%s\n' 'extract pinned Deno archive; export exact RustyV8 Git objects; copy vendor'
} > "$out/assembly-receipt.env"

printf 'assembled pure source tree: %s\n' "$out"
