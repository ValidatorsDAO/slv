# Secure release delivery

SLV release installation consumes only immutable GitHub Releases from
`ValidatorsDAO/slv`. This document describes the consumer implemented in
`sh/install`, `slv upgrade`, and `slv skills sync`, and the release acceptance
requirements. It does not authorize publication or the legacy-bootstrap
transition.

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

Qualification drafts are read through authenticated asset IDs in the fixed
repository; GitHub's temporary preview URLs are not download authorities.
Same-source recovery uploads only missing pinned assets. A later protected main
execution can finish an already complete draft only after verifying its original
hosted-main signature, all asset bytes, and the original source's ancestry to
that exact executor. It preserves the original draft target, signature, and
asset IDs, uploads nothing, and rechecks the current revocation policy and tag
binding before publication. Executor and attested-source commits are recorded
separately. The local `promotion-plan.json` binds the accepted release ID,
original source, recovery mode, and every existing asset and signature-bundle
ID, size, and digest. The pre-publication helper reads that same plan and allows
only the planned missing uploads; it rejects replacement or retargeting. Planning
and final verification both refresh release metadata after transfers, rejecting
changes observed before publication. This does not exclude a privileged write
after the last check. Incomplete drafts from another source cannot use this
recovery path.
The recovery keeps workflow files unchanged from the original target and uses
the existing `GITHUB_TOKEN` without adding workflow-write credentials. See
GitHub's [release update permission rules](https://docs.github.com/en/rest/releases/releases#update-a-release).

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

## Current activation state and evidence limits

Publication requires immutable releases to be enabled, the protected `release`
environment and main/tag review protections to be in force, and
`SLV_RELEASE_ACTIVATED` and `SLV_LINUX_BUILDERS_ENABLED` to be exactly `true`.
Runtime qualification tags also require update/delete protection. Recheck these
requirements for the release being reviewed. Repository configuration and the activation flag do not
prove that a release was published, made immutable, or accepted by a consumer.

The normal first-release path is a reviewed version PR with a strict CalVer
advance, followed by its merge to `main`. A main push that leaves `VERSION`
unchanged is CI-only and does not publish. The publisher binds the release to
that main push SHA, creates an annotated
tag when absent, attests every payload and release metadata subject, and checks
the resulting release API record for `immutable: true`. A manual
`operation=release` dispatch can verify an existing immutable application tag
with a matching version and source commit. It cannot start an initial release
or rebuild a draft. Draft recovery is limited to rerunning the failed publisher
with its retained original package artifact; those artifacts are retained for
seven days. Application drafts are resolved through authenticated release lookup,
including bounded listing when the published-tag endpoint returns 404. The
publisher retains the numeric release ID and enumerates draft assets by that ID.
While adding missing uploads it preserves all selected existing asset IDs,
sizes and digests. Before downloading, it requires exactly the manifest subjects
and their matching attestation-bundle aliases, with no extra assets. After
downloading and verifying every payload and signature,
it refreshes the release metadata and rejects any observed identity or inventory
change before publication. This does not atomically exclude privileged writes
after that last check. A whole-workflow rebuild can change a payload or
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

Runtime qualification and application compilation are separate operations.
`source-materials/runtime-qualification.json` pins the source-built baseline
runtime for all four targets, its selected and derived dependency locks,
compiler and embedding recipe, tools, ABI, original source archives, and native
proofs. The sentinel-modified runtime remains diagnostic evidence only.

The first main release can promote an audited candidate through a dedicated
hosted job in the protected `release` environment. It publishes the exact
reviewed bytes as an immutable, nonlatest runtime prerelease and attests its
canonical manifest. Later releases verify and reuse the same qualification.
PRs and bounded validation may inspect the candidate, but their receipts remain
explicitly nonpublishable. Main requires independent verification of the
published qualification before product compilation. Conflicting existing bytes
are rejected; qualification assets are never overwritten.

The explicit `runtime-qualification` operation rebuilds Deno/V8 and performs
baseline/sentinel and native execution checks when runtime inputs change.
Its original source, producer, and execution records are preserved. Newly
produced evidence must become a reviewed descriptor before promotion.
An ordinary SLV source change does not rerun this heavy native-build graph.

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
or silently omitted from the population. These implemented controls are not live
acceptance evidence. The ordinary workflow is resolve, test, current source package,
qualification acquisition and protected promotion or reuse, independent
qualification verification, four Linux product jobs, package, hosted
attestation, activation guard, and protected publication. First publication and public consumer acceptance remain
pending until their evidence is recorded. The attestation job has source-read
and attestation/artifact-metadata/ID-token permissions, separate from the
publisher's release-content write authority.

The first release and legacy-bootstrap transition have separate acceptance
stages:

1. **Before publication**, review the exact source, build and provenance inputs,
   source/license evidence, repository protections, and fixture/CI rehearsals of
   installation, migration, verification failures, and recovery. Rehearse the
   legacy STOP response without changing the public bootstrap. Fixture and
   unsigned PR results do not establish public consumer acceptance.
2. **Publish the first immutable release** through the reviewed release workflow
   and its protected-environment approval. Verify its published source identity,
   payloads, provenance, and `immutable: true` record. The consumer requires this
   published immutable release before public installation can be tested.
3. **After publication, before the legacy transition**, record public
   clean-install, upgrade, skill-sync, proof, existing-installation migration,
   and rollback/recovery results in controlled test installations. Include the
   explicit reviewed bootstrap migration for a standard `/usr/local/bin/slv`
   target and preservation of existing keys, configuration, inventories, and
   backups. A real upgrade record identifies the predecessor and newer target
   versions and proves replacement; a same-version `slv upgrade` no-op is not
   that proof. If no suitable predecessor has been exercised, keep upgrade
   acceptance pending rather than treating a clean install or fixture as a pass.
4. **Only after that acceptance is complete**, separately review and authorize
   the legacy-bootstrap preflight/apply operation. Review the exact source and
   expected object/payload hashes before applying, then verify the public STOP
   response. Its nonzero migration prompt must name the reviewed commit-pinned
   installer and explicit target without replacing a binary or downloading an
   unverified bridge. It does not authorize replacing an arbitrary PATH binary.

Publication also requires a review of unresolved legal and license coverage. The
SBOM records Deno runtime and lock identities. An SPDX `NOASSERTION` value does
not itself supply license text or prove a coverage gap; canonical notice
material and source-distribution closure are the corresponding release evidence.
ELSOUL LABO B.V. is the confirmed responsible legal entity for SLV distribution
and security, and SLV code, binaries, updates, and security fixes are free
without Enterprise; optional Enterprise services operate around the same public
OSS. This work does not retroactively secure legacy installations or settle the
applicable statutory role or support duration, or prove operation of
release-service controls.
