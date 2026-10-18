# Rebuilding an SLV release from published source materials

An SLV source release has three separately hashed source archives. They are
inputs to a local rebuild, not an installer and not a replacement for the
official signed-release trust path.

Ordinary releases assemble the four SLV products on Linux using previously
qualified target runtimes. Building a Darwin executable with `deno compile
--target` embeds that target's runtime; it does not require rebuilding Deno/V8
on every SLV source change. Full native source rebuilding remains available for
runtime qualification and independent source/relink work described below.

## Application and runtime identities

The application release's schema 2 manifest pins
`runtime-deno-v2.9.3-<qualification-sha256>`, an immutable, nonlatest GitHub
prerelease. Its `runtime-qualification.json` and attestation bind the exact
baseline runtimes, original native proofs and producer, source archives,
selected and derived Cargo locks, build recipes, tool prerequisites, compiler
frontend, ABI, and embedding recipe. Keep the qualification's original source
and receipt separate from the current application's source and receipt.

The qualification release retains the original evidence ZIPs and source
materials as public assets, so independent rebuilders do not need access to
expiring Actions artifacts. Verify its manifest digest and hosted-main
attestation before following any asset references. Do not use an upstream
runtime with the same Deno version as a substitute: the selected Cargo
dependency closure is a separately pinned input.

An application build verifies the qualification, supplies its target runtime
through `DENORT_BIN`, and freshly compiles the CLI and release bridge with the
current notices. Its product receipt binds the resulting executable/archive
and current source, lock, module graph, SBOM, notices, producer, and qualification.
It never reuses a qualification's old application executable or bridge.
Linux products are executed natively; Darwin products receive architecture,
minimum-OS, load-command, and ad-hoc signature checks on Linux. A Darwin
`native_execution: not_performed` result is distinct from the original runtime's
native qualification. Execute the exact new bytes on the matching Mac
architecture when collecting native application acceptance.

Changes to pinned runtime source, selected dependencies, tools, ABI, or the
embedding contract require a newly reviewed qualification. The explicit
`runtime-qualification` workflow operation produces new source/native evidence;
it does not automatically approve or publish a new qualification. Ordinary PR
and validation candidates are not installable application releases.

## Current application source archives

- `slv-source.tar.gz` has the single root `slv-source/`: the reviewed SLV
  source, its frozen Deno dependency cache, canonical `THIRD_PARTY_NOTICES`, and
  `source-materials/{closure.json,inventory.json,pack-manifest.json}`.
- `deno-source.tar.gz` has the single root `deno-source/`: Deno 2.9.3,
  `rusty_v8`, its pinned V8 source, the same canonical notice bytes, and the
  embedded source manifests.
- `deno-cargo-vendor.tar.gz` has the single root `deno-cargo-vendor/`: the
  complete vendor tree and selected, security-reviewed `Cargo.lock`, its Cargo
  config, canonical notice bytes, and the embedded source manifests. The
  upstream Deno manifest and lock remain immutable runtime-security evidence;
  they are not substituted for the selected build closure.

Every archive is below 2 GiB. The external source-material receipt is the
authority for each archive's name, size, SHA-256, reviewed source commit/tree,
source timestamp, pin digest, closure, inventory, vendor policy, and canonical
notice digest. The embedded manifests help an extractor validate contents; they
do not self-reference the archive checksum.

## Recovering the immutable assembly receipt

The signed `sbom.spdx.json` carries the source-material receipt in exactly one
SPDX annotation. Its comment contains the raw receipt after
`---BEGIN SLV SOURCE MATERIALS RECEIPT---` and includes the receipt's final
newline. Preserve those bytes; parsing and reformatting JSON, or using `jq -r`
(which appends a newline), changes the assembly receipt SHA-256.

```bash
python3 - ./sbom.spdx.json ./source-materials-receipt.json <<'PY'
import hashlib
import json
import re
import sys
from pathlib import Path

sbom = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
prefix = '---BEGIN SLV SOURCE MATERIALS RECEIPT---\n'
matches = [
    annotation['comment'] for annotation in sbom.get('annotations', [])
    if isinstance(annotation, dict)
    and isinstance(annotation.get('comment'), str)
    and prefix in annotation['comment']
]
if len(matches) != 1:
    raise SystemExit(f'expected one source-material receipt annotation, got {len(matches)}')
header, raw = matches[0].split(prefix, 1)
match = re.fullmatch(
    r'SLV source-materials receipt \(verbatim UTF-8; SHA-256 ([0-9a-f]{64})\)\. '
    r'Extract every byte after the delimiter and verify it against the three source archives\.\n',
    header,
)
if not match or not raw.endswith('\n'):
    raise SystemExit('source-material receipt annotation is malformed')
raw_bytes = raw.encode('utf-8')
if hashlib.sha256(raw_bytes).hexdigest() != match.group(1):
    raise SystemExit('source-material receipt annotation digest differs')
Path(sys.argv[2]).write_bytes(raw_bytes)
PY

deno run --frozen --allow-read \
  scripts/release/source-materials.ts verify-receipt \
  ./source-materials-receipt.json ./source-materials
```

The source-material directory in the verification command contains precisely the
three downloaded archives. It does not require a CI token, signature
authorization, or publisher-only receipt.

`source-materials/pins.json` binds the native source inputs to Deno
`f39575ecd50602a5b42b1ba8e93849460de9fcf4`, rusty_v8
`dd1b4e9c743b7a11dbeb99d4d0dc55979218b905`, and V8
`73d19698991616a34a00ca691a6e697dbb69e2ef`. The original Deno lock remains
immutable source evidence. The rebuild writes a separate derived lock for the
local `v8@149.4.0` path replacement and any explicitly enumerated,
security-reviewed selected-runtime closure change. It fails if any other
registry package, dependency, checksum, or source changes.

## Prerequisites

The rebuild has no CI identity, signing key, token, or publisher-only
authorization requirement. It requires the public, checksum-pinned native tool
prerequisites recorded in `source-rebuild/tool-prereqs.json`: Rust 1.95.0,
Chromium Clang and paired libclang/resource headers, Chromium Rust required by
V8's GN build, GN, Ninja, and a Deno 2.9.3 frontend. Compiler distributions are
prerequisites; they are not source-release assets.

Prepare each purpose into a new directory. The target descriptor is a canonical,
target-specific subset of the reviewed `tool-prereqs.json`. Both phases for one
target must bind the same descriptor bytes. `--offline` accepts only already
checksum-verified cache bytes.

```bash
TARGET=x86_64-unknown-linux-gnu
BUILD_HOST=x86_64-unknown-linux-gnu
INPUT=./dist/release-inputs
PROOF=./source-proofs/$TARGET

mkdir -p "$INPUT/tool-pins"
deno run --frozen --allow-read --allow-write --allow-run --allow-env --allow-net \
  source-rebuild/prepare-tools.ts \
  --target "$TARGET" --build-host "$BUILD_HOST" --purpose build \
  --pins source-rebuild/tool-prereqs.json --cache ./tool-cache \
  --out ./tools-build --receipt ./tools-build-receipt.json \
  --descriptor "$INPUT/tool-pins/$TARGET.json"

deno run --frozen --allow-read --allow-write --allow-run --allow-env --allow-net \
  source-rebuild/prepare-tools.ts \
  --target "$TARGET" --build-host "$TARGET" --purpose execution \
  --pins source-rebuild/tool-prereqs.json --cache ./tool-cache \
  --out ./tools-execution --receipt ./tools-execution-receipt.json \
  --descriptor "$INPUT/tool-pins/$TARGET.json"
```

The prepared receipts record public URLs, archive checksums, extracted
identities, the target descriptor hash, and the exact environment mapping
consumed by the native driver. A missing target, tool identity, or descriptor
mismatch fails. The bootstrap does not substitute a host-global compiler.

On macOS, use Xcode 16.2 with SDK 15.2 and set
`DEVELOPER_DIR=/Applications/Xcode_16.2.app/Contents/Developer` plus
`SLV_APPLE_SDK_PATH` to that SDK. On every host, set `SLV_HOST_PYTHON` to an
absolute Python 3.11-or-newer path; the driver resolves, validates, and records
that path instead of inheriting a user PATH or Python configuration.

Linux build preparation also installs the checksum-pinned Deno 2.27 ABI sysroot.
ARM64 extracts only `.env`, `lib`, `usr/include`, and `usr/lib`; x86_64 also
needs the archive's `lib64`. This excludes unneeded device entries and tools.
The Deno `memfd_create` and libm shims are compiled from pinned Deno source
using that declared target sysroot. Chromium's separate 2.31 sysroots remain V8
build prerequisites.

After the source archives and build-purpose tools are staged, the build phase
requires at least `12582912` KiB (12 GiB) free on every filesystem receiving the
extraction, build work, or proof output. This bound comes from the measured 10.3
GiB native peak plus transport/log slack. The driver records each POSIX `df -Pk`
reading in the build receipt and fails before extraction if the bound is not
met.

## Native replay

Put the three archives, immutable source-material receipt, exact source pin
file, canonical notice file, and both prepared tool receipts in local paths.
Each `--source-root` and `--work-dir` below is a new empty directory. The proof
output starts empty for `build` and is reused only by its corresponding
`execute` and `merge` phases.

```bash
COMMON=(
  --target "$TARGET"
  --out "$PROOF"
  --pins "$INPUT/source-materials/pins.json"
  --source-receipt "$INPUT/source-materials-receipt.json"
  --slv-source "$INPUT/source-materials/slv-source.tar.gz"
  --deno-source "$INPUT/source-materials/deno-source.tar.gz"
  --cargo-vendor "$INPUT/source-materials/deno-cargo-vendor.tar.gz"
  --notice-file "$INPUT/THIRD_PARTY_NOTICES"
)

deno run --frozen --allow-read --allow-write --allow-run --allow-env \
  source-rebuild/verify-native.ts --phase build "${COMMON[@]}" \
  --build-host "$BUILD_HOST" --tools-receipt ./tools-build-receipt.json \
  --jobs 2 \
  --source-root ./fresh-build-source --work-dir ./fresh-build-work

deno run --frozen --allow-read --allow-write --allow-run --allow-env \
  source-rebuild/verify-native.ts --phase execute "${COMMON[@]}" \
  --build-receipt "$PROOF/build-receipt.json" \
  --build-materials "$PROOF/transport" \
  --execution-tools-receipt ./tools-execution-receipt.json \
  --source-root ./fresh-execute-source --work-dir ./fresh-execute-work

deno run --frozen --allow-read --allow-write --allow-run --allow-env \
  source-rebuild/verify-native.ts --phase merge "${COMMON[@]}" \
  --build-receipt "$PROOF/build-receipt.json" \
  --execution-receipt "$PROOF/execution-receipt.json" \
  --source-root ./fresh-merge-source --work-dir ./fresh-merge-work
```

### Split cold producers for ARM Linux and macOS Intel

The hosted release path for `aarch64-unknown-linux-gnu` and
`x86_64-apple-darwin` runs two independent cold producers, then a short join.
This isolates the baseline product build from the modified sentinel build; it
does not replace the target-host `execute` and `merge` phases. The existing
`build` invocation above remains the local full-rebuild interface.

Each producer receives its explicit GitHub producer context as JSON with this
exact shape:

```json
{
  "schema_version": 1,
  "kind": "slv-native-producer-context",
  "repository": "ValidatorsDAO/slv",
  "workflow": "ValidatorsDAO/slv/.github/workflows/slv-remote-build.yml@<ref>",
  "run_id": "<positive-run-id>",
  "run_attempt": "<positive-attempt>",
  "job_id": "source-arm-baseline"
}
```

The ARM producer job IDs are `source-arm-baseline` and `source-arm-modified`;
the macOS Intel IDs are `source-macos-x64-baseline` and
`source-macos-x64-modified`. Each producer uses a fresh source root and work
directory, its own prepared build tools, `--jobs 4`, and writes exactly
`variant-receipt.json`, `build-tools-receipt.json`, `tool-pin.json`, and its
allowlisted `transport/` payload into its output directory.

```bash
SPLIT_COMMON=(
  --target "$TARGET"
  --pins "$INPUT/source-materials/pins.json"
  --source-receipt "$INPUT/source-materials-receipt.json"
  --slv-source "$INPUT/source-materials/slv-source.tar.gz"
  --deno-source "$INPUT/source-materials/deno-source.tar.gz"
  --cargo-vendor "$INPUT/source-materials/deno-cargo-vendor.tar.gz"
  --notice-file "$INPUT/THIRD_PARTY_NOTICES"
)

deno run --frozen --allow-read --allow-write --allow-run --allow-env \
  source-rebuild/verify-native.ts --phase build-variant "${SPLIT_COMMON[@]}" \
  --variant baseline --build-host "$BUILD_HOST" --jobs 4 \
  --tools-receipt ./baseline-tools-receipt.json \
  --producer-context ./baseline-producer-context.json \
  --source-root ./fresh-baseline-source --work-dir ./fresh-baseline-work \
  --out ./baseline-variant

deno run --frozen --allow-read --allow-write --allow-run --allow-env \
  source-rebuild/verify-native.ts --phase build-variant "${SPLIT_COMMON[@]}" \
  --variant modified --build-host "$BUILD_HOST" --jobs 4 \
  --tools-receipt ./modified-tools-receipt.json \
  --producer-context ./modified-producer-context.json \
  --source-root ./fresh-modified-source --work-dir ./fresh-modified-work \
  --out ./modified-variant
```

The join takes a separate facade context and an exact dependency descriptor. The
descriptor has `schema_version: 1`, `kind: "slv-native-variant-dependencies"`,
and `baseline` and `modified` objects. Each role names the downloaded `receipt`
and `materials` paths, raw `receipt_sha256`, provider `artifact_id` and
`artifact_digest`, and the full producer context. `artifact_digest` remains
provider metadata. The join fail-closes on the actual raw receipt, build-tool
sidecar, canonical target descriptor, manifest, and every payload file's hash
and size; it does not claim to recompute a ZIP digest.

```bash
deno run --frozen --allow-read --allow-write --allow-run --allow-env \
  source-rebuild/verify-native.ts --phase join-build "${SPLIT_COMMON[@]}" \
  --producer-context ./join-producer-context.json \
  --variant-dependencies ./variant-dependencies.json \
  --source-root ./fresh-join-source --work-dir ./fresh-join-work \
  --out "$PROOF"
```

`join-build` has no compiler or tool preparation input. It independently
re-extracts and verifies immutable source materials, preserves the exact
original producer receipt bytes in `build-receipt.json` under `split_build`, and
emits the unchanged combined build receipt and transport contract consumed by
`execute`, `merge`, and the public proof parser. Producers from an earlier
attempt are accepted only when the explicit exact dependency ID, provider
metadata, raw receipt hash, and producer context still bind the same workflow
run. The split changes deadline isolation only; actual per-producer duration is
measured by the hosted run rather than inferred from local fixtures.

`build` verifies and safely scans every archive before extraction, constructs an
unmodified source-built `denort` with `V8_FROM_SOURCE=true`, and transports only
hash-allowlisted baseline artifacts, probes, and the compiled SLV/bridge
acceptances. Its Cargo home, target directory, HOME, compiler flags, wrappers,
and cache are isolated. The recipe records its fixed environment allowlist,
Python/tool identities, source-lock-to-derived-lock transformation, logs,
resource snapshots, and actual V8 archive/Ninja paths. It copies and discards
only completed baseline scratch after the baseline artifacts are hashed, so two
full native targets are not retained on hosted runners.

`execute` runs only the transported bytes on the target host, with a private
HOME and Deno cache. It proves baseline `Math.sin(0.125)` is not the sentinel,
checks the nearby `0.126` control, then executes the compiled SLV version, help,
licenses, and release-bridge paths. The licenses bytes must equal the canonical
notice file. `merge` rehashes the exact source assets and binds the independent
build and execution receipts into `native-proof.json`; it does not modify the
source-material receipt.

The contextual `glibc_sin` sentinel patch is a separate diagnostic: it builds in
a different cache and proves that `Math.sin(0.125)` reaches `glibc_sin` by
returning `0.5` while the nearby control stays normal. It is not the runtime
used to produce the release executable.

For `aarch64-unknown-linux-gnu`, the approved split is an x86_64 Linux source
cross-build followed by actual ARM64 Linux execution. Build with
`--target aarch64-unknown-linux-gnu --build-host x86_64-unknown-linux-gnu` and
the ARM descriptor. Transfer the complete transport directory, build receipt,
three unchanged archives, source receipt, pins, notice, and descriptor to an
ARM64 Linux host. There, prepare `--purpose execution` with
`--build-host aarch64-unknown-linux-gnu`, then run `execute` and `merge`. An
x86_64 cross-build alone is never a passing ARM proof.

The release pack requires one verified passing proof for each native target:
x86_64 Linux, ARM64 Linux, x86_64 macOS, and ARM64 macOS. It rejects absent,
duplicate, stale, source-mismatched, tool-descriptor-mismatched, or
build/execute artifact-mismatched proof records. A local diagnostic or a failed
command remains evidence of its own result and is not a release proof.

The local full-build default parallelism is two. A local reviewer with capacity
for the same isolated full build may choose `--jobs 1` through `--jobs 15`; the
choice is recorded in the build receipt. Sixteen jobs require both
`--jobs 16 --build-profile linux-16`, an x86_64 Linux build host, and a Linux
target. This profile is bound into the build receipts and target proofs.

Without a build profile, the bounded split producer interface requires exactly
`--jobs 2` for Linux x86_64 or `--jobs 4` for Linux ARM64 and macOS x86_64.
Linux split producers may instead use `--jobs 16 --build-profile linux-16`
under the same host and target restrictions. Both variants must use the same
profile; the join rejects mixed declarations. ARM64 execution still runs on
an actual ARM64 Linux host.

## Linux product compatibility gate

After the product executable and compiled bridge have been built from the
transported baseline runtime, Linux release jobs run this additional gate on the
matching target architecture:

```bash
deno run --frozen --allow-read --allow-write --allow-run --allow-env \
  source-rebuild/verify-linux-product.ts \
  --target "$TARGET" \
  --build-receipt "$PROOF/build-receipt.json" \
  --native-proof "$PROOF/native-proof.json" \
  --runtime-dir "$PROOF/transport" \
  --tools-receipt ./tools-execution-receipt.json \
  --executable ./dist/slv \
  --bridge ./dist/slv-bridge \
  --out "$PROOF/linux-compatibility"
```

The runtime transport manifest binds the baseline `denort`, derived local-V8
lock, and the Deno TLS fixture bytes `tls-localhost.crt`, `tls-localhost.key`,
and `tls-root-ca.pem`. The gate rejects ELF imports above GLIBC 2.27,
`GLIBC_PRIVATE`, and RPATH/RUNPATH. It runs the executable, licenses command,
bridge, and source-built runtime crypto/subprocess/TLS smoke under the pinned
target 2.27 loader with only its verified sysroot library paths. Loader `--list`
output is recorded but does not itself pass the gate; each program must execute.
The resulting sibling `linux-compatibility-receipt.json` uses portable
`cwd: "."` and basename-only log paths so it can be verified after artifact
transfer.

The native build recipe also emits a per-runtime ABI receipt. Linux baseline and
sentinel `denort` outputs must have no GLIBC requirement above 2.27,
`GLIBC_PRIVATE`, or RPATH/RUNPATH. macOS builds preserve Deno's upstream target
configuration and record a Mach-O `LC_BUILD_VERSION` minimum OS of 12.0; macOS
target execution remains an independent target-host proof.

## Making a local modified rebuild

Anyone may modify the extracted source and rebuild it locally. This route does
not need CI, a signing key, token, release authorization, or a publisher-only
license task. It produces an unofficial modified artifact and must not be
represented as a verified official release.

First verify and safely extract the three source archives as above. Copy the
Deno and `rusty_v8` source trees to a private work directory, keep the published
selected vendor tree read-only, and run the frozen recipe with the same public
prepared-tool environment used for the target:

```bash
set -eu
: "${TARGET:?set TARGET to x86_64-unknown-linux-gnu or aarch64-unknown-linux-gnu}"
: "${EXTRACTED:?set EXTRACTED to the verified source-archive directory}"
: "${TOOLS:?set TOOLS to the matching prepared build-tool directory}"
: "${SLV_HOST_PYTHON:?set SLV_HOST_PYTHON to the recorded Python 3.11+ path}"
: "${DENO_FRONTEND:?set DENO_FRONTEND from the matching prepared build receipt}"
for required_absolute in EXTRACTED TOOLS SLV_HOST_PYTHON DENO_FRONTEND; do
  case "${!required_absolute}" in
    /*) ;;
    *)
      printf '%s must be an absolute path\n' "$required_absolute" >&2
      exit 64
      ;;
  esac
done

test ! -e ./my-change || {
  echo './my-change already exists; choose a fresh private work directory' >&2
  exit 64
}
mkdir ./my-change
cp -a "$EXTRACTED/deno-source/deno" ./my-change/deno
cp -a "$EXTRACTED/deno-source/rusty_v8" ./my-change/rusty_v8
# Edit ./my-change/deno or ./my-change/rusty_v8.

case "$TARGET" in
  x86_64-unknown-linux-gnu)
    DENO_SYSROOT_SHA256='64513b04d8a38da6f47c0a9c4cb47b2ce7bcb735250b10eb10751aec6afe46ee'
    ;;
  aarch64-unknown-linux-gnu)
    DENO_SYSROOT_SHA256='0a29c63c52cc1e59228686602cf3cf41080a809655afc29d1b8a27af4b20cedb'
    CROSS_LINKER="$TOOLS/clang/bin/clang"
    export CROSS_LINKER
    ;;
  *)
    echo "unsupported Linux target: $TARGET" >&2
    exit 64
    ;;
esac

DENO_SOURCE_DIR="$PWD/my-change/deno" \
RUSTY_V8_SOURCE_DIR="$PWD/my-change/rusty_v8" \
CARGO_VENDOR_DIR="$EXTRACTED/deno-cargo-vendor/vendor" \
RUST_BIN="$TOOLS/rustc/prefix/bin" PYTHON="$SLV_HOST_PYTHON" \
GN="$TOOLS/gn/gn" NINJA="$TOOLS/ninja/ninja" \
CLANG_BASE_PATH="$TOOLS/clang" LIBCLANG_PATH="$TOOLS/clang/lib" \
CHROMIUM_RUST_TOOLCHAIN="$TOOLS/chromium-rust" \
SLV_LINKER="$TOOLS/clang/bin/ld.lld" \
BUILD_TARGET="$TARGET" DENO_SYSROOT="$TOOLS/deno-sysroot/sysroot" \
DENO_SYSROOT_SHA256="$DENO_SYSROOT_SHA256" \
V8_SYSROOT_AMD64="$TOOLS/sysroot-amd64" \
V8_SYSROOT_ARM64="$TOOLS/sysroot-arm64" \
V8_SYSROOT_AMD64_SHA256='52d61d4446ffebfaa3dda2cd02da4ab4876ff237853f46d273e7f9b666652e1d' \
V8_SYSROOT_ARM64_SHA256='c7176a4c7aacbf46bda58a029f39f79a68008d3dee6518f154dcf5161a5486d8' \
"$EXTRACTED/slv-source/source-rebuild/build-baseline-denort.sh" \
  "$EXTRACTED/deno-source" ./my-change/build

RUNTIME="$PWD/my-change/build/target/$TARGET/release/denort"
test -x "$RUNTIME"
APP="$PWD/my-change/slv-app"
cp -a "$EXTRACTED/slv-source" "$APP"
mkdir -p "$APP/dist/release-inputs" "$APP/deno-cache" \
  "$PWD/my-change/private-home" "$PWD/my-change/dist"
cp "$EXTRACTED/slv-source/THIRD_PARTY_NOTICES" \
  "$APP/dist/release-inputs/THIRD_PARTY_NOTICES"
(
  cd "$APP"
  DENORT_BIN="$RUNTIME" DENO_DIR="$APP/deno-cache" \
  HOME="$PWD/../private-home" \
  "$DENO_FRONTEND" compile --frozen --cached-only --no-prompt -A \
    --include cli/lib/release/engine.py \
    --include dist/release-inputs/THIRD_PARTY_NOTICES \
    --target "$TARGET" --output "$PWD/../dist/slv" cli/src/index.ts
)
```

This is the local Linux rebuild path. `DENO_SYSROOT_SHA256` is mandatory and
target-specific; the ARM case also requires the matching prepared
`CROSS_LINKER`. The copied app uses its shipped frozen dependency cache as
`DENO_DIR`, and the command copies the shipped notice to its compiled asset path
before invoking the source-built runtime. The canonical notices describe the
published selected closure. If a local modification changes dependency closure
or notices, its distributor must produce accurate local licensing material
before redistributing those changed bytes.
