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
2. Updates upload:template task in root deno.json
3. Updates version in sh/install
4. Creates a new version directory in sh/ and copies the install file
5. Creates a new version directory in template/ and copies the template files
6. Updates the template/latest symlink
7. Removes old versions in sh/ and template/ (keeps latest 3)

### create-release.ts

Creates a new release by updating the version, committing the changes, and
creating a tag.

```bash
deno task create:release --version 0.6.1
```

This script:

1. Updates the version in cmn/constants/version.ts
2. Runs the update-version.ts script
3. Cleans old release-assets/ and builds the macOS executable locally
   - Stages it in release-assets/
4. Commits the changes
5. Creates a tag
6. Pushes the changes and tag

After running this script, GitHub Actions will automatically build and publish
the release.

## Release Process

The recommended release process is:

1. Make sure all your changes are committed and pushed
2. Run the create-release script with the new version:
   ```bash
   deno task create:release --version 0.6.1
   ```
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
   gh workflow run slv-remote-build.yml -f version=0.6.1
   ```

See the `ansible/README.md` file for more details on remote builds.
