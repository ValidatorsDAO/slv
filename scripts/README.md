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

## Release evidence

Ordinary PRs compile on hosted Linux; trusted main releases use ephemeral Linux
builders, including native ARM64 for that Linux target. A successful
ordinary `runtime-qualification` job verifies the selected immutable runtime or a
nonpublishable candidate; it does not rerun Deno/V8 on every application change.
The four explicit product jobs and `package` bind the current application to
those runtime bytes. Darwin products receive static Mach-O checks on Linux.
Intel output from the pinned embedding library is recorded as unsigned; ARM64
requires an ad-hoc signature, and every present signature is verified. Artifact
hash/provenance checks remain required. The current receipt does not claim native
macOS execution.
See [rebuilding releases](../docs/rebuilding-releases.md) for runtime and source
identities and [secure delivery](../docs/secure-delivery.md) for artifact verification and evidence limits.

Inspect the records for the specific release and source revision. A successful
pull-request build is not published release evidence, and a same-version upgrade
no-op does not demonstrate an upgrade between versions. See
[release artifact evidence and limits](../docs/secure-delivery.md#release-artifact-evidence-and-limits).
