#!/usr/bin/env deno run -A

import { VERSION } from '../cmn/constants/version.ts'
import { join } from '@std/path'
import { copy, ensureDir, ensureSymlink } from '@std/fs'

const VERSION_DIR_REGEX = /^\d+\.\d+\.\d+$/
const KEEP_VERSIONS = 3

const listVersionDirs = async (root: string) => {
  const versions: string[] = []
  for await (const entry of Deno.readDir(root)) {
    if (entry.isDirectory && VERSION_DIR_REGEX.test(entry.name)) {
      versions.push(entry.name)
    }
  }
  versions.sort((a, b) => {
    const aParts = a.split('.').map(Number)
    const bParts = b.split('.').map(Number)
    for (let i = 0; i < 3; i += 1) {
      if (aParts[i] !== bParts[i]) {
        return bParts[i] - aParts[i]
      }
    }
    return 0
  })
  return versions
}

const pruneOldVersions = async (root: string) => {
  const versions = await listVersionDirs(root)
  const keep = versions.slice(0, KEEP_VERSIONS)
  const remove = versions.slice(KEEP_VERSIONS)
  for (const dir of remove) {
    await Deno.remove(join(root, dir), { recursive: true })
  }
  if (remove.length > 0) {
    console.log(
      `✅ Removed old versions from ${root}: ${remove.join(', ')}`,
    )
  }
  return keep
}

/**
 * Updates all version references in the project
 * This script:
 * 1. Updates cli/deno.json version
 * 2. Updates upload:template task in root deno.json
 * 3. Updates version in sh/install
 * 4. Creates a new version directory in sh/ and copies the install file
 * 5. Creates a new version directory in template/ and copies the template files
 * 6. Updates the template/latest symlink
 * 7. Removes old versions in sh/ and template/ (keeps latest 3)
 */
async function updateVersion() {
  console.log(`Updating version references to ${VERSION}...`)

  // 1. Update cli/deno.json
  const cliDenoJsonPath = './cli/deno.json'
  const cliDenoJson = JSON.parse(await Deno.readTextFile(cliDenoJsonPath))
  cliDenoJson.version = VERSION
  await Deno.writeTextFile(
    cliDenoJsonPath,
    JSON.stringify(cliDenoJson, null, 2),
  )
  console.log(`✅ Updated ${cliDenoJsonPath}`)

  // 2. Update upload:template task in root deno.json
  const rootDenoJsonPath = './deno.json'
  const rootDenoJson = JSON.parse(await Deno.readTextFile(rootDenoJsonPath))

  // Update upload:template task
  rootDenoJson.tasks['upload:template'] =
    `tar -czf dist/template.tar.gz ./template/${VERSION} && deno run -A cli/uploadTemplate.ts`
  await Deno.writeTextFile(
    rootDenoJsonPath,
    JSON.stringify(rootDenoJson, null, 2),
  )
  console.log(`✅ Updated ${rootDenoJsonPath}`)

  // 3. Update version in sh/install
  const installPath = './sh/install'
  let installContent = await Deno.readTextFile(installPath)
  installContent = installContent.replace(
    /VERSION="[^"]*"/,
    `VERSION="${VERSION}"`,
  )
  await Deno.writeTextFile(installPath, installContent)
  console.log(`✅ Updated ${installPath}`)

  // 4. Create a new version directory in sh/ and copy the install file
  const shVersionDir = `./sh/${VERSION}`
  await ensureDir(shVersionDir)
  await Deno.copyFile(installPath, join(shVersionDir, 'install'))
  console.log(`✅ Created ${shVersionDir}/install`)

  // 5. Create a new version directory in template/ and copy the template files
  // First, find the latest version directory in template/
  const templateDirs = await listVersionDirs('./template')
  const latestTemplateDir = templateDirs[0]
  const newTemplateDir = `./template/${VERSION}`

  // Copy the latest template directory to the new version
  await ensureDir(newTemplateDir)
  
  // Skip copy if source and destination are the same
  if (latestTemplateDir !== VERSION) {
    await copy(`./template/${latestTemplateDir}`, newTemplateDir, {
      overwrite: true,
    })
    console.log(`✅ Created ${newTemplateDir} from template/${latestTemplateDir}`)
  } else {
    console.log(`✅ Template directory ${newTemplateDir} already exists, skipping copy`)
  }

  // 6. Update the template/latest symlink
  try {
    // Check if it's a symlink first
    const latestInfo = await Deno.lstat('./template/latest')
    if (latestInfo.isSymlink) {
      await Deno.remove('./template/latest')
    } else {
      // If it's a directory, remove it recursively
      await Deno.remove('./template/latest', { recursive: true })
    }
  } catch (error) {
    // Ignore if the path doesn't exist
    if (!(error instanceof Deno.errors.NotFound)) {
      console.error('Error removing template/latest:', error)
      throw error
    }
  }

  // Create the symlink
  // Use absolute paths to avoid path resolution issues
  const absNewTemplateDir = await Deno.realPath(newTemplateDir)
  const absLatestPath = join(Deno.cwd(), 'template', 'latest')
  
  await ensureSymlink(absNewTemplateDir, absLatestPath)
  console.log(
    `✅ Updated template/latest symlink to point to ${newTemplateDir}`,
  )

  // 7. Remove old versions (keep latest 3)
  await pruneOldVersions('./template')
  await pruneOldVersions('./sh')

  console.log(`\n✅ All version references updated to ${VERSION}`)
}

// Run the update function
await updateVersion()
