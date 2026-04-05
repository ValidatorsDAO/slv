#!/usr/bin/env deno run -A
import { spawnSync } from '@elsoul/child-process'
import { parse } from 'https://deno.land/std@0.224.0/flags/mod.ts'

const CALVER_REGEX = /^\d{4}\.\d{1,2}\.\d{1,2}\.\d{4}$/

/**
 * Creates a new release PR by:
 * 1. Updating the version in cmn/constants/version.ts
 * 2. Running the update-version.ts script
 * 3. Verifying every version reference is synchronized
 * 4. Committing the changes
 * 5. Creating and pushing a release branch
 * 6. Opening the release Pull Request
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
      'Usage: deno run -A scripts/create-release.ts --version 2026.4.5.0314',
    )
    Deno.exit(1)
  }

  const newVersion = args.version

  // Validate version format
  if (!CALVER_REGEX.test(newVersion)) {
    console.error('Error: Version must be in the format YYYY.M.D.HHmm')
    Deno.exit(1)
  }

  console.log(`Creating release v${newVersion}...`)

  // Ensure workspace member config exists so the release branch is usable in CI
  const apiConfigPath = './api/slv-api/deno.json'
  try {
    await Deno.stat(apiConfigPath)
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      console.error(
        `Error: Missing ${apiConfigPath}. Add it before opening the release PR.`,
      )
      Deno.exit(1)
    }
    throw error
  }

  // 1. Create the release branch before making release changes
  const branchName = `release/v${newVersion}`
  console.log(`Creating branch ${branchName}...`)
  const branchResult = await spawnSync(`git checkout -b ${branchName}`)
  console.log(branchResult.message)
  if (!branchResult.success) {
    console.error(`❌ Failed to create branch ${branchName}`)
    Deno.exit(1)
  }
  console.log(`✅ Branch ${branchName} created`)

  // 2. Update the version in cmn/constants/version.ts
  const versionPath = './cmn/constants/version.ts'
  let versionContent = await Deno.readTextFile(versionPath)
  versionContent = versionContent.replace(
    /export const VERSION = '[^']*'/,
    `export const VERSION = '${newVersion}'`,
  )
  await Deno.writeTextFile(versionPath, versionContent)
  console.log(`✅ Updated version in ${versionPath}`)

  // 3. Run the update-version.ts script
  console.log('Running update-version.ts script...')
  const updateResult = await spawnSync('deno run -A scripts/update-version.ts')
  console.log(updateResult.message)
  if (!updateResult.success) {
    console.error('❌ update-version.ts failed')
    Deno.exit(1)
  }

  // 3.5 Verify every version reference is synchronized before continuing
  console.log('Verifying synced version references...')
  const checkResult = await spawnSync(
    'deno run -A scripts/check-version-sync.ts',
  )
  console.log(checkResult.message)
  if (!checkResult.success) {
    console.error(
      '❌ Version references are still out of sync after update-version.ts',
    )
    Deno.exit(1)
  }

  // 4. Commit the changes
  console.log('Committing changes...')
  await spawnSync(`git add .`)
  await spawnSync(`git commit -m "Release v${newVersion}"`)
  console.log('✅ Changes committed')

  // 5. Push the release branch
  console.log(`Pushing branch ${branchName}...`)
  await spawnSync(`git push origin ${branchName}`)
  console.log(`✅ Branch ${branchName} pushed`)

  // 6. Create Pull Request via GitHub API
  console.log('Creating Pull Request...')
  const ghToken = Deno.env.get('GITHUB_TOKEN') || ''
  if (!ghToken) {
    console.error(
      'Error: GITHUB_TOKEN environment variable is required for PR creation',
    )
    Deno.exit(1)
  }

  const prBody =
    `## Release v${newVersion}\n\nThis PR updates the version to v${newVersion}.\n\nWhen merged, GitHub Actions will automatically create the \`v${newVersion}\` tag and trigger the build & release process.`

  const prResponse = await fetch(
    'https://api.github.com/repos/ValidatorsDAO/slv/pulls',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ghToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: `Release v${newVersion}`,
        body: prBody,
        head: branchName,
        base: 'main',
      }),
    },
  )

  const prData = await prResponse.json()
  if (prResponse.ok) {
    console.log(`✅ Pull Request created: ${prData.html_url}`)
  } else {
    console.error(`Error creating PR: ${JSON.stringify(prData)}`)
    Deno.exit(1)
  }

  console.log(`\n✅ Release v${newVersion} PR created successfully!`)
  console.log(
    'Once the PR is merged, GitHub Actions will automatically tag and release.',
  )
}

// Run the release function
await createRelease()
