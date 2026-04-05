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
deno task create:release --version 2026.4.5.0314
```

This script:

1. Updates the version in `cmn/constants/version.ts`
2. Runs `update-version.ts`
3. Runs `check-version-sync.ts` and fails if anything is still out of sync
4. Commits the changes
5. Creates and pushes a release branch
6. Opens the release Pull Request

After running this script, GitHub Actions will automatically build and publish
the release after the PR is merged.

## Release Process

The recommended release process is:

1. Make sure all your changes are committed and pushed
2. Run the create-release script with the new version:
   ```bash
   deno task create:release --version 2026.4.5.0314
   ```
   Do not update only `cmn/constants/version.ts` by hand — the release flow must
   also run `update-version.ts` so the CLI version, installer, template archive,
   versioned shell installer, and `template/latest` all stay in sync.
3. GitHub Actions will automatically:
   - Run tests
   - Build the Linux binary and upload the staged macOS binary
   - Upload artifacts to storage
   - Create a GitHub release

For heavy compilation tasks, you can use the remote build workflow:

1. Set up a Ubuntu 24.04 LTS server
2. Configure the server in `ansible/inventory.yml`
3. Use the remote build workflow:
   ```bash
   # Manually trigger the workflow
   gh workflow run slv-remote-build.yml -f version=2026.4.5.0314
   ```

See the `ansible/README.md` file for more details on remote builds.
