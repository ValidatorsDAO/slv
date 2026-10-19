# Secure release delivery

SLV release installation consumes only immutable GitHub Releases from
`ValidatorsDAO/slv`. This document describes the consumer implemented in
`sh/install`, `slv upgrade`, and `slv skills sync`, and how to interpret
the accompanying release evidence.

## Initial installation

Python 3.9 or later and Git are prerequisites; the download examples also use
curl. The installer never installs
system dependencies, downloads a helper as root, or asks a package manager to
make changes.

The [README quick start](../README.md#2-install-from-a-reviewed-bootstrap)
provides a runnable bootstrap pinned to reviewed commit
`c351b90306ec6e0cce01aa04725f7eaf5374f65b`, published with
`v2026.10.19.0750`. Its SHA-256 is
`acc17d48c986a7dfcdc0afa2603da139da9e30d1af1766fd279d53152cf55282`.
The script discovers the latest eligible immutable application release when it
runs, then verifies that release independently. Its bootstrap version label does
not pin the installed CLI version. Use the saved, checksum-checked script; do not
substitute a floating branch URL or pipe a download directly to a shell.

A fresh install uses the controlled path `~/.local/bin/slv` and prints the PATH
change needed to put that directory before other SLV locations. If another `slv`
is already found on PATH, installation stops rather than writing an unused
second binary. Re-run with the displayed `--install-path /existing/slv` only
after checking that it is the intended target. For a protected target such as
`/usr/local/bin/slv`, all downloads, attestation checks, hash checks, and
archive extraction complete as the calling user; privilege is requested only for
the final checked binary replacement.

## Recover an older or local installation

An old or locally compiled executable may be unable to run its own updater. For
example, `NotFound: .../engine.py` means the compiled command could not read its
update engine; local version suffixes can also fail strict release-version
validation. The procedure below does not depend on that updater.

Check `command -v slv` and `slv --version` first. Keep a private backup of a custom
executable and your existing management configuration before replacing them.
Choose the intended regular executable, not a shell alias or a symbolic link.
If the target differs from `/usr/local/bin/slv`, change **both** occurrences of
that path below to its absolute path. Do not run the whole block with `sudo` or
change `HOME`.

```sh
(
  set -eu
  umask 077
  slv_bootstrap_dir="$(mktemp -d)"
  cd "$slv_bootstrap_dir"
  curl --fail --location --output install \
    https://raw.githubusercontent.com/ValidatorsDAO/slv/c351b90306ec6e0cce01aa04725f7eaf5374f65b/sh/install
  python3 - <<'PY'
import hashlib
from pathlib import Path
expected = 'acc17d48c986a7dfcdc0afa2603da139da9e30d1af1766fd279d53152cf55282'
if hashlib.sha256(Path('install').read_bytes()).hexdigest() != expected:
    raise SystemExit('Installer checksum mismatch; stopping.')
PY
  sh ./install --install-path /usr/local/bin/slv
  /usr/local/bin/slv --version
)
```

The installer downloads and verifies as the calling user. It requests privilege
only if the final executable replacement needs it. Installation also delivers
versioned templates, skills, and notices, then runs settings migration. Existing
version pins and unknown settings fields are preserved while missing defaults
are added; generated settings templates are refreshed. Read
[recovery and settings](#recovery-and-settings) before upgrading a customized
installation. `--no-settings-migration` defers that final settings step; it does
not skip release verification or installation of the packaged templates/skills.

Check that the explicit executable and `slv --version` resolve to the intended
new release. Later updates use `slv upgrade`. This procedure does not reinstall
validator or RPC node software, remove old node-side keys, or imply that the old
R2 bootstrap has been migrated. If an interrupted transaction is reported,
preserve its state and retry with the same intended `--install-path`; do not
delete the journal or lock to force an update.

## What the consumer verifies

Before it downloads a mutable SLV payload, the engine requires a GitHub release
whose API record is `immutable: true`, `draft: false`, and `prerelease: false`,
with a real UTC `YYYY.M.D.HHmm` CalVer tag. It constructs the manifest and
bundle URLs from that tag and fixed names. It does not accept URLs from release
metadata or from the manifest.

The consumer bootstraps only GitHub CLI 2.102.0. Each platform archive has an
embedded SHA-256 pin, and the extracted `gh` executable has a second embedded
SHA-256 pin which is checked every time the local verifier cache is reused. The
verifier runs with an empty credential/config environment and validates the
exact repository, signer workflow path, main source ref, source commit digest,
signer-workflow digest, offline bundle, and the denial of self-hosted signers.
For the main-only publication flow, the source and signer-workflow digests must
both equal the reviewed publication commit. It then validates the schema 2
manifest, all 21 required payload identities, and four current-product receipts.
Candidate validation receipts are never installable release evidence.

The signed application manifest pins a separate runtime qualification by its
full SHA-256 identity. The consumer verifies that qualification's immutable
GitHub prerelease, exact asset inventory, manifest digest, hosted-main
attestation, and peeled tag. Its attested source commit must be an ancestor of the
application's signed source. Each product receipt must agree with the pinned
target runtime, selected dependency lock, original native qualification,
compiler frontend, current source, notices, SBOM, and executable archive. The
qualification tag starts with `runtime-deno-`; it is not an installable SLV
version and never replaces the latest application release.

`source-materials/runtime-revocations.json` is a reviewed deny-only list of
qualification identities. Candidate checks use the exact checked-out policy;
main promotion, final build/package acceptance, and publication also check the
current policy at its fixed public `main` URL. Online installation, upgrade,
and skill synchronization fetch that policy independently before accepting
the selected runtime. A listed identity or an unavailable or invalid policy
fails that acceptance attempt; an empty list never replaces signature, source,
or hash verification. The recorded policy digest and fetch time identify an
observed mutable policy, not an immutable or atomic view of future updates.

The three source archives (`slv-source.tar.gz`,
`deno-source.tar.gz`, and `deno-cargo-vendor.tar.gz`) are verified release
identities for source and relink work. They are not installation or upgrade
inputs, so normal consumer operations never download or extract them. Finally, a
clean public `git ls-remote` lookup confirms that the peeled release tag commit
equals the signed source commit.

Before packaging, the release builder accepts those three source assets only
from the reviewed source-material receipt. It verifies their streamed hashes and
sizes, the exact source commit, the checked-in pin file, full locked-vendor
receipt, embedded closure and inventory identities, and the same canonical
notice bytes used by the executable, template, and skill payloads. The receipt
is evidence for those three assets, not a twenty-second release asset. A
separate rebuild-proof field is required in the receipt; `separate` records that
source packaging does not itself prove a native relink result.

The source package preserves Deno's upstream Cargo.toml and Cargo.lock as
immutable evidence. Its build and vendor inputs are a separately recorded,
approved security selection: the exact manifest transform, selected lock,
resolution receipt, allowed package delta, and OSV receipt are copied into the
source archive and bound in the assembly receipt. The selected lock is the only
vendor input. Each native proof also binds that selected lock and its own
offline local-v8 relink lock; the relink lock is a per-target derived build
output, not a replacement source input.

The immutable source-material receipt is also carried verbatim in the signed
`sbom.spdx.json` as an SPDX annotation. This keeps the original UTF-8 receipt
available after a short-lived CI artifact expires, without adding another
release payload or requiring CI credentials. A source replayer extracts the
bytes after `---BEGIN SLV SOURCE MATERIALS RECEIPT---` without parsing or
reformatting them, then checks the result against the three downloaded source
archives with `scripts/release/source-materials.ts verify-receipt`. The receipt
digest in the annotation and the current-product receipts bind the same bytes.
Historical runtime proofs retain their own original source-material receipt;
they are never rewritten to claim the current application commit.

Every requested archive is downloaded to private staging and checked against the
manifest size and SHA-256 before any destination changes. Tar archives are fully
scanned before extraction: links, devices, FIFOs, absolute or traversal paths,
duplicates, file/directory collisions, unexpected roots, member-count overflow,
and oversized expansion are rejected. The executable archive must contain
exactly one regular root member; templates must live below
`template/<version>/`; skills must live below their skill-name root.

Install and upgrade fetch the host executable, the versioned template, and all
ten skill archives. A skills-only sync fetches only the selected archives, but
it verifies the same immutable release and the exact release version of the
running CLI first. A mixed valid/unknown selection fails before any archive is
changed. Group changes use one journalled transaction, so an ordinary failure
restores the selected group.

## Recovery and settings

The consumer takes an exclusive `~/.slv/.release.lock`. Before every replacement
boundary it durably records the destination and backup in
`~/.slv/.release-journal.json`; a subsequent release command first recovers an
incomplete transaction. It preserves keys, configs, inventories, backups, and
auxiliary tools because it replaces only the selected binary, one versioned
template tree, and selected skill trees.

After the core transaction commits, the installed binary runs
`slv upgrade:settings`. A settings migration failure is reported as a nonzero
install/upgrade result. The verified core release remains installed; settings
changes are not rolled back. The template archive is also checked for all Jinja
directories needed by that migration before any replacement begins.

Core release installation does not automatically download `grpc_test`,
`geyserbench`, or `deshred`. Existing auxiliary tools are left alone. Commands
that use such tools must report a missing prerequisite and document their own
source and verification procedure.

## Release artifact evidence and limits

An installable release must have an immutable published record and matching
source identity, payload digests, and provenance. Workflow source alone does not
prove publication or consumer acceptance. Use the evidence for the specific
release being installed.

Pull requests produce an unsigned, CI-only package from the checked-out merge
commit. That artifact is retained only for inspection and cannot enter an
attestation, protected environment, publisher, or consumer path. After its
frozen install and measured module graph, the test job is the only job allowed
to prepare the canonical notice bytes and their source/run/attempt binding. It
retains exactly those two files. Each source-package, target-proof, and package
job downloads that artifact by its produced ID and verifies the binding's source
SHA, producer run, persisted producer attempt, and notice digest. A retried
consumer job cannot substitute its own attempt.

Runtime qualification and application compilation are separate operations.
`source-materials/runtime-qualification.json` pins the source-built baseline
runtime for all four targets, its selected and derived dependency locks,
compiler and embedding recipe, tools, ABI, original source archives, and native
proofs. The sentinel-modified runtime remains diagnostic evidence only.

A runtime qualification is distributed as an immutable prerelease with an
attested manifest. Application releases refer to its exact identity. Candidate
qualification receipts from pull-request builds remain nonpublishable.
Reusing a runtime qualification does not reuse an earlier application's binary:
each release still needs its own current-product receipts.

Ordinary releases compile four fresh products on ephemeral Linux builders.
Linux ARM64 uses a native ARM64 host; the Linux x64 and two Darwin products use
x64 Linux. Each job supplies the exact qualified target runtime through
`DENORT_BIN` and compiles both the current SLV entry point and a fresh release
bridge. It records the current source, frozen dependency graph, notices, SBOM,
runtime identity, frontend, flags, producer attempt, and actual output hashes.
The old qualification's application binary and bridge are not reused.

Linux products are executed on their native architecture. Darwin products are
checked on Linux for Mach-O architecture, minimum OS, load commands, and file
extents. The pinned embedding library produces unsigned Intel output on Linux;
its verification report records `signature: unsigned`. ARM64 requires an embedded
ad-hoc signature. Any present signature, including an Intel signature, must pass
the full signature and page-hash checks. Executable/archive hashes and release
provenance remain required for both architectures. Their current-product receipts
explicitly record native
execution as `not_performed`; historical native runtime qualification does not
claim that a new application was run on macOS. Same-byte Intel and ARM Mac smoke
tests remain acceptance evidence for introducing this build path, outside the
ordinary release graph.

Linux product artifacts also carry a separate internal compatibility receipt.
Before packaging, the producer binds the actual executable and compiled bridge
hashes to the native proof, build receipt, baseline runtime, and the checksum-
pinned glibc 2.27 sysroot. It checks the recorded, hash-verified ELF, older-
loader startup, canonical-notice, bridge, and crypto/subprocess/loopback-TLS
logs. Missing or extra Linux evidence, a changed bridge, a GLIBC requirement
above 2.27, `GLIBC_PRIVATE`, RPATH/RUNPATH, or a loader resolution outside the
pinned sysroot rejects the package. The bridge and its logs are internal CI
evidence, not additional release assets. The receipt addresses each log by a
single filename relative to its `linux-compatibility` directory, with `cwd` set
to `.`; absolute or traversal paths are rejected after artifact download.

Only after all four current-product receipts pass does the package job copy the verified
source archives and exact receipt annotation into the existing SBOM, then copy
the canonical notice bytes into the template and all skill sources without
regenerating them. It measures its own local module graph for the SBOM and does
not carry a runner cache path across jobs. Required Deno runtime notice coverage
is materialized. Source-vendor coverage is a separate source-distribution
closure: the source-material receipt records the complete locked vendor
population and blocks an absent required text or receipt. Historical grant-scope
uncertainty is retained for review rather than represented as zero uncertainty
or silently omitted from the population. These implemented controls do not by
themselves establish public consumer acceptance. Read the release-specific records for the tested platforms and
installation, upgrade, and recovery behavior.

The SBOM records Deno runtime and lock identities. An SPDX `NOASSERTION` value does
not itself supply license text or prove a coverage gap; canonical notice
material and source-distribution closure are the corresponding release evidence.
See [SECURITY.md](../SECURITY.md) for security updates and the responsible legal
entity. Release verification does not retroactively secure an older installation
or establish CRA conformity.
