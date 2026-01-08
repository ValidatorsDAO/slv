#!/usr/bin/env deno run -A
import { spawnSync } from '@elsoul/child-process'
import { parse } from 'https://deno.land/std@0.224.0/flags/mod.ts'

/**
 * Creates a new release by:
 * 1. Updating the version in cmn/constants/version.ts
 * 2. Running the update-version.ts script
 * 3. Committing the changes
 * 4. Creating a tag
 * 5. Pushing the changes and tag
 */
async function createRelease() {
  // Parse command line arguments
  const args = parse(Deno.args, {
    string: ['version'],
    alias: { v: 'version' },
  })

  if (!args.version) {
    console.error('Error: Version is required')
    console.error(
      'Usage: deno run -A scripts/create-release.ts --version 0.6.1',
    )
    Deno.exit(1)
  }

  const newVersion = args.version

  // Validate version format
  if (!/^\d+\.\d+\.\d+$/.test(newVersion)) {
    console.error('Error: Version must be in the format x.y.z')
    Deno.exit(1)
  }

  console.log(`Creating release v${newVersion}...`)

  // 1. Update the version in cmn/constants/version.ts
  const versionPath = './cmn/constants/version.ts'
  let versionContent = await Deno.readTextFile(versionPath)
  versionContent = versionContent.replace(
    /export const VERSION = '[^']*'/,
    `export const VERSION = '${newVersion}'`,
  )
  await Deno.writeTextFile(versionPath, versionContent)
  console.log(`✅ Updated version in ${versionPath}`)

  // 2. Run the update-version.ts script
  console.log('Running update-version.ts script...')
  const updateResult = await spawnSync('deno run -A scripts/update-version.ts')
  console.log(updateResult.message)

  // 2.5 Build macOS executable locally and stage it for remote upload
  if (Deno.build.os !== 'darwin') {
    console.error('Error: create-release must be run on macOS for mac builds.')
    Deno.exit(1)
  }
  console.log('Building macOS executable locally...')
  await Deno.mkdir('./dist', { recursive: true })
  const buildMacResult = await spawnSync('deno task build:mac')
  if (!buildMacResult.success) {
    console.error('❌ Failed to build macOS executable.')
    Deno.exit(1)
  }
  console.log(buildMacResult.message)
  const macTarPath = './dist/slv-x86_64-apple-darwin-exe.tar.gz'
  const releaseAssetsDir = `./release-assets/${newVersion}`
  await Deno.mkdir(releaseAssetsDir, { recursive: true })
  const macReleasePath =
    `${releaseAssetsDir}/slv-x86_64-apple-darwin-exe.tar.gz`
  await Deno.copyFile(macTarPath, macReleasePath)
  console.log(`✅ Staged macOS artifact at ${macReleasePath}`)

  // 3. Commit the changes
  console.log('Committing changes...')
  await spawnSync(`git add .`)
  await spawnSync(`git commit -m "Release v${newVersion}"`)
  console.log('✅ Changes committed')

  // 4. Create a tag
  console.log(`Creating tag v${newVersion}...`)
  await spawnSync(`git tag v${newVersion}`)
  console.log(`✅ Tag v${newVersion} created`)

  // 5. Push the changes and tag
  console.log('Pushing changes and tag...')
  await spawnSync('git push origin main')
  await spawnSync(`git push origin v${newVersion}`)
  console.log('✅ Changes and tag pushed')

  console.log(`\n✅ Release v${newVersion} created successfully!`)
  console.log('GitHub Actions will now build and publish the release.')
}

// Run the release function
await createRelease()
