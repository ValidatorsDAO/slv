# Secure release delivery

SLV release installation consumes only immutable GitHub Releases from
`ValidatorsDAO/slv`. This document describes the consumer implemented in
`sh/install`, `slv upgrade`, and `slv skills sync`; it does not authorize or
describe a release publication.

## Initial installation

Python 3.9 or later and Git are prerequisites. The installer never installs
system dependencies, downloads a helper as root, or asks a package manager to
make changes.

Until a reviewed release publishes a bootstrap, use a reviewed commit-pinned
source URL, replace `<reviewed-commit>` with the exact audited commit, save it,
and inspect it before execution:

```sh
curl --fail --location --remote-name \
  https://raw.githubusercontent.com/ValidatorsDAO/slv/<reviewed-commit>/sh/install
sh ./install
```

The placeholder is deliberately not a runnable release URL. Do not use a branch
URL, a floating `main` URL, or a pipe-to-shell command.

A fresh install uses the controlled path `~/.local/bin/slv` and prints the PATH
change needed to put that directory before other SLV locations. If another `slv`
is already found on PATH, installation stops rather than writing an unused
second binary. Re-run with the displayed `--install-path /existing/slv` only
after checking that it is the intended target. For a protected target such as
`/usr/local/bin/slv`, all downloads, attestation checks, hash checks, and
archive extraction complete as the calling user; privilege is requested only for
the final checked binary replacement.

Existing installations require an explicit migration check before activation.
The legacy `slv upgrade` path invokes its remote bootstrap without an
`--install-path`; it cannot safely choose a PATH-resolved target such as
`/usr/local/bin/slv`. For that case, the first release acceptance must show a
nonzero, actionable result that names the reviewed commit-pinned bootstrap
command and `--install-path /usr/local/bin/slv`, without replacing the binary or
downloading an unverified bridge. The exact release commit URL is filled in only
after the release commit is reviewed; this document intentionally does not
substitute a floating branch URL.

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
exact repository, signer workflow path, source ref, source commit digest,
offline bundle, and the denial of self-hosted runners. The consumer does not
pass `--signer-digest`: the GitHub CLI option is a signer-workflow digest, and
the publication contract has not defined a value that can safely be equated to
the signed source commit. It then validates the full manifest schema and all 21
required payload identities. The three source archives (`slv-source.tar.gz`,
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
digest in the annotation and the later four target proofs bind the same bytes.
The source-material receipt remains immutable: a native proof is recorded
separately and never rewrites the assembly record.

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

## Current activation state and evidence limits

As observed on 2026-10-12, the repository's immutable-release setting is false.
The intended publisher runs only in the protected `release` environment when
`SLV_RELEASE_ACTIVATED` is exactly `true`; otherwise it produces an
activation-pending failure. That gate, the release environment, and main/tag
review protections still require administrator configuration. The flag alone
does not prove that GitHub has made a release immutable.

When configured, publication is intended to bind a strict CalVer advance to a
main push SHA or a version-matched tag's peeled commit, create an annotated tag,
attest every payload and release metadata subject, and check the resulting
release API record for `immutable: true`. Draft recovery is limited to rerunning
the failed publisher with its retained original package artifact; those
artifacts are retained for seven days. A dispatch from a tag may verify an
immutable release or publish a previously absent tag, but it cannot rebuild or
overwrite an existing draft. A whole-workflow rebuild can change a payload or
manifest and is therefore refused for an existing draft; expiry requires
maintainer review and is never overwritten automatically.

Pull requests produce an unsigned, CI-only package from the checked-out merge
commit. That artifact is retained only for inspection and cannot enter an
attestation, protected environment, publisher, or consumer path. After its
frozen install and measured module graph, the test job is the only job allowed
to prepare the canonical notice bytes and their source/run/attempt binding. It
retains exactly those two files. Each source-package, target-proof, and package
job downloads that artifact by its produced ID and verifies the binding's source
SHA, producer run, persisted producer attempt, and notice digest. A retried
consumer job cannot substitute its own attempt.

The source-package job assembles the three archives and its immutable receipt
before relink evidence exists. It derives one canonical descriptor per target
from the reviewed `source-rebuild/tool-prereqs.json`; a proof must bind the
descriptor's exact digest as well as the source receipt and all three archive
hashes. Three target proofs build and execute natively (Linux x64, macOS x64,
and macOS arm64). The fourth proof cross-builds Linux arm64 on Linux x64 and
executes the transported result on Linux arm64. Every proof embeds the verified
notice bytes, runs `slv licenses` with a private empty home and no inherited
credentials, and compares stdout byte-for-byte with the canonical file. It also
records baseline and modified runtime probes: the unchanged baseline must not
produce the sentinel result, the modified probe must produce it, and both
unchanged controls must agree.

The runtime used to compile the release executable is the source-built security
baseline. A target proof carries the baseline runtime, its selected and derived
lock identities, and the baseline-compiled SLV executable and release bridge.
The sentinel-modified runtime remains a diagnostic probe only. For every target,
the package job requires a separate product-runtime receipt that binds the
actual one-file executable archive and extracted executable hashes to that
target's baseline runtime, source receipt, native proof, build receipt, selected
lock, and derived relink lock. A product archive with a valid sentinel probe but
without this baseline-product binding is rejected.

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

Only after all four phase receipts pass does the package job copy the verified
source archives and exact receipt annotation into the existing SBOM, then copy
the canonical notice bytes into the template and all skill sources without
regenerating them. It measures its own local module graph for the SBOM and does
not carry a runner cache path across jobs. Required Deno runtime notice coverage
is materialized. Source-vendor coverage is a separate source-distribution
closure: the source-material receipt records the complete locked vendor
population and blocks an absent required text or receipt. Historical grant-scope
uncertainty is retained for review rather than represented as zero uncertainty
or silently omitted from the population. These are planned controls, not live
evidence: the intended workflow is resolve, test, source package, three native
target builds plus Linux arm cross-build/execution, package, attest, activation
guard, then publish; no live release has been published or tested with this
consumer. Its attestation job is intended to have only
attestation/artifact-metadata/ID-token permissions, separate from the
publisher's release-content authority.

Before activating a first release, the live acceptance record must include the
existing-installation migration case above for a standard `/usr/local/bin/slv`
target, alongside the clean-install, upgrade, skill-sync, proof, and rollback
results. A failed migration prompt is an expected safe outcome until the user
runs the explicit reviewed command; it is not authorization to replace an
arbitrary PATH binary.

Activation also requires a review of unresolved legal and license coverage. The
SBOM records Deno runtime and lock identities. An SPDX `NOASSERTION` value does
not itself supply license text or prove a coverage gap; canonical notice
material and source-distribution closure are the corresponding release evidence.
ELSOUL LABO B.V. is the confirmed responsible legal entity for SLV distribution
and security, and SLV code, binaries, updates, and security fixes are free
without Enterprise; optional Enterprise services operate around the same public
OSS. This work does not retroactively secure legacy installations or settle the
applicable statutory role, support duration, or activation of release-service
controls.
