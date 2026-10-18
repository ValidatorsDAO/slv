# SLV Scripts

This directory contains utility scripts for managing the SLV project.

## Scripts

### update-version.ts

Updates all version references in the project based on the version defined in
`cmn/constants/version.ts`.

```bash
deno task update:version
```

This script:

1. Updates cli/deno.json version
2. Updates create:template task in root deno.json
3. Updates version in sh/install
4. Creates a new version directory in sh/ and copies the install file
5. Creates a new version directory in template/ and copies the template files
6. Updates the template/latest symlink
7. Removes old versions in sh/ and template/ (keeps latest 3)

### check-version-sync.ts

Fails if any release version reference is out of sync with
`cmn/constants/version.ts`.

```bash
deno task check:version-sync
```

This verifies:

1. `cli/deno.json` version
2. `deno.json` `create:template` task
3. `sh/install`
4. `sh/<version>/install`
5. `template/<version>`
6. Representative required template files inside `template/<version>`
7. `template/latest`

### create-release.ts

Creates a new release PR by updating the version, synchronizing all generated
version references, verifying the sync, and opening the release branch/PR.

```bash
deno task create:release --version "<newer-YYYY.M.D.HHmm>"
```

This script:

1. Updates the version in `cmn/constants/version.ts`
2. Runs `update-version.ts`
3. Runs `check-version-sync.ts` and fails if anything is still out of sync
4. Commits the changes
5. Creates and pushes a release branch
6. Opens the release Pull Request

Replace the placeholder with a valid UTC CalVer strictly newer than the current
`VERSION`. The command creates a release PR from the reviewed `main` commit.
Verify CI publication requirements before merging that PR; this script does not
publish a release or rely on a tag trigger by itself.

## Release Process

The recommended release process is:

1. Make sure all your changes are committed and pushed
2. Run the create-release script with the new version:
   ```bash
   deno task create:release --version "<newer-YYYY.M.D.HHmm>"
   ```
   Do not update only `cmn/constants/version.ts` by hand — the release flow must
   also run `update-version.ts` so the CLI version, installer, template archive,
   versioned shell installer, and `template/latest` all stay in sync.
3. After review, merge the release PR when the delivery workflow is ready to
   compile all four products on Linux from the pinned qualified runtimes.
   Runtime promotion, attestation, and publication use separate hosted jobs.

If generation, commit, push, or Pull Request creation fails, the command reports
the last completed stage and preserves the local branch. It never resets or
deletes the branch. The command always starts from a clean, reviewed `main`; do
not rerun it on a partial release branch.

For a branch, generation, or commit failure, inspect `git status --short`,
`git diff`, and `git diff --cached`, then correct the issue manually without a
reset, branch deletion, or force-push. For a push failure, inspect the release
commit and `git ls-remote --heads origin <release-branch>` before an authorized
maintainer pushes the reviewed branch manually.

After a Pull Request HTTP or transport failure, run this before any PR-only
create:

```bash
gh pr list --repo ValidatorsDAO/slv --head <release-branch> --state all
```

Inspect that result and the remote branch first. Do not retry a Pull Request
POST manually until you confirm that no Pull Request exists.

After a reviewed PR with a strict `VERSION` CalVer advance is merged, the
main-push delivery workflow starts the initial release flow, subject to its
build, evidence, activation, and protected-environment approval gates. A push
that leaves `VERSION` unchanged is CI-only; it does not start publication.

`workflow_dispatch` selects an operation as well as a version:

- `release` (the default) requires the exact existing `refs/tags/v<version>` ref,
  a matching source version, and a peeled tag commit contained in `main` history.
  It verifies an existing immutable release. It cannot publish an absent
  release or rebuild an existing draft; initial publication starts from the
  reviewed version advance on `main`.
- `legacy-bootstrap-preflight` and `legacy-bootstrap-apply` are separate,
  protected operations dispatched from `main` after immutable publication and
  public consumer acceptance. They use the reviewed release version and source
  SHA; apply also requires the reviewed preimage and STOP-payload hashes. They
  do not build or publish a release.
- `source-native-diagnostic` is a separate bounded diagnostic with its own
  reviewed-SHA and ref requirements; it does not publish a release or authorize
  the legacy transition.
- `source-build-validation` requires the fixed
  `codex/slv-linux-ephemeral-release` branch and a full `reviewed_sha` matching
  both the workflow and checked-out source. It builds baseline and modified
  sources for both Linux targets, verifies their proofs, and builds and checks
  both Linux products. It skips macOS, full release packaging, attestation, and
  publication. Its success is Linux validation evidence, not a replacement for
  the normal four-target PR checks or release workflow. This source-rebuild
  operation is separate from ordinary application compilation.
- `release-build-validation` requires the fixed `codex/slv-linux-all-targets`
  branch and a full `reviewed_sha` matching the workflow and checked-out source.
  It validates the pinned runtime candidate, compiles all four products on
  Linux, and packages their current-source evidence without publishing.
- `runtime-qualification` is an explicit reviewed `main` dispatch for changed
  runtime inputs. It runs the full source rebuild and native proof chain,
  including macOS, without building or publishing an application release.
  Its evidence must become a reviewed qualification descriptor before a later
  main release can promote it.

Ordinary PRs compile on hosted Linux; trusted main releases use ephemeral Linux
builders, including native ARM64 for that Linux target. A successful
ordinary `runtime-qualification` job verifies the selected immutable runtime or a
nonpublishable candidate; it does not rerun Deno/V8 on every application change.
The four explicit product jobs and `package` bind the current application to
those runtime bytes. Darwin products receive static Mach-O and ad-hoc signature
checks on Linux; the current receipt does not claim native macOS execution.
See [rebuilding releases](../docs/rebuilding-releases.md) for runtime and source
identities and [secure delivery](../docs/secure-delivery.md) for publication
and acceptance boundaries.

If publishing fails, rerun the failed publish job with its original artifacts,
retained for seven days. A whole-workflow rebuild can produce different bytes
and intentionally refuses a differing existing draft. Repository configuration
does not replace the required review, environment approval, or live evidence.

Complete fixture/CI rehearsals before the first immutable publication, then
record public install, predecessor-to-new-release upgrade, skills, migration,
and recovery acceptance before separately authorizing the legacy-bootstrap
transition. A same-version upgrade no-op does not prove a real upgrade. See
[secure delivery](../docs/secure-delivery.md#current-activation-state-and-evidence-limits)
for the sequence and evidence requirements.
