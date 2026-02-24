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

  // Ensure workspace member config exists so tagged release is usable in CI
  const apiConfigPath = './api/slv-api/deno.json'
  try {
    await Deno.stat(apiConfigPath)
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      console.error(`Error: Missing ${apiConfigPath}. Add it before tagging.`)
      Deno.exit(1)
    }
    throw error
  }

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

  // 3. Commit the changes
  console.log('Committing changes...')
  await spawnSync(`git add .`)
  await spawnSync(`git commit -m "Release v${newVersion}"`)
  console.log('✅ Changes committed')

  // 4. Create release branch and push
  const branchName = `release/v${newVersion}`
  console.log(`Creating branch ${branchName}...`)
  await spawnSync(`git checkout -b ${branchName}`)
  console.log(`✅ Branch ${branchName} created`)

  console.log(`Pushing branch ${branchName}...`)
  await spawnSync(`git push origin ${branchName}`)
  console.log(`✅ Branch ${branchName} pushed`)

  // 5. Create Pull Request via GitHub API
  console.log('Creating Pull Request...')
  const ghToken = Deno.env.get('GITHUB_TOKEN') || ''
  if (!ghToken) {
    console.error('Error: GITHUB_TOKEN environment variable is required for PR creation')
    Deno.exit(1)
  }

  const prBody = `## Release v${newVersion}\n\nThis PR updates the version to v${newVersion}.\n\nWhen merged, GitHub Actions will automatically create the \`v${newVersion}\` tag and trigger the build & release process.`

  const prResponse = await fetch('https://api.github.com/repos/ValidatorsDAO/slv/pulls', {
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
  })

  const prData = await prResponse.json()
  if (prResponse.ok) {
    console.log(`✅ Pull Request created: ${prData.html_url}`)
  } else {
    console.error(`Error creating PR: ${JSON.stringify(prData)}`)
    Deno.exit(1)
  }

  console.log(`\n✅ Release v${newVersion} PR created successfully!`)
  console.log('Once the PR is merged, GitHub Actions will automatically tag and release.')
}

// Run the release function
await createRelease()
