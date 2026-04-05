#!/usr/bin/env deno run -A

import { VERSION } from '../cmn/constants/version.ts'

const CALVER_REGEX = /^\d{4}\.\d{1,2}\.\d{1,2}\.\d{4}$/
const EXPECTED_CREATE_TEMPLATE =
  `tar -czf dist/template.tar.gz ./template/${VERSION}`
const EXPECTED_INSTALL_VERSION = `VERSION="${VERSION}"`
const REQUIRED_TEMPLATE_FILES = [
  `./template/${VERSION}/AGENTS.md`,
  `./template/${VERSION}/jinja/mainnet-validator/solv.service.j2`,
  `./template/${VERSION}/ansible/mainnet-validator/init.yml`,
  `./template/${VERSION}/jinja/mainnet-rpc/start-mainnet-rpc.sh.j2`,
  `./template/${VERSION}/ansible/cmn/install_solana.yml`,
]

const failures: string[] = []

const assertEqual = (label: string, actual: string, expected: string) => {
  if (actual !== expected) {
    failures.push(`${label}: expected "${expected}", got "${actual}"`)
  }
}

if (!CALVER_REGEX.test(VERSION)) {
  failures.push(
    `cmn/constants/version.ts must use CalVer YYYY.M.D.HHmm, got "${VERSION}"`,
  )
}

const cliDenoJson = JSON.parse(await Deno.readTextFile('./cli/deno.json'))
assertEqual('cli/deno.json version', cliDenoJson.version, VERSION)

const rootDenoJson = JSON.parse(await Deno.readTextFile('./deno.json'))
assertEqual(
  'deno.json tasks.create:template',
  rootDenoJson.tasks['create:template'],
  EXPECTED_CREATE_TEMPLATE,
)

const rootInstall = await Deno.readTextFile('./sh/install')
if (!rootInstall.includes(EXPECTED_INSTALL_VERSION)) {
  failures.push(`sh/install must contain ${EXPECTED_INSTALL_VERSION}`)
}

const versionedInstallPath = `./sh/${VERSION}/install`
try {
  const versionedInstall = await Deno.readTextFile(versionedInstallPath)
  if (!versionedInstall.includes(EXPECTED_INSTALL_VERSION)) {
    failures.push(
      `${versionedInstallPath} must contain ${EXPECTED_INSTALL_VERSION}`,
    )
  }
} catch (error) {
  if (error instanceof Deno.errors.NotFound) {
    failures.push(`Missing ${versionedInstallPath}`)
  } else {
    throw error
  }
}

try {
  const templateVersionInfo = await Deno.stat(`./template/${VERSION}`)
  if (!templateVersionInfo.isDirectory) {
    failures.push(`template/${VERSION} exists but is not a directory`)
  }
} catch (error) {
  if (error instanceof Deno.errors.NotFound) {
    failures.push(`Missing template/${VERSION}`)
  } else {
    throw error
  }
}

for (const requiredTemplateFile of REQUIRED_TEMPLATE_FILES) {
  try {
    const fileInfo = await Deno.stat(requiredTemplateFile)
    if (!fileInfo.isFile) {
      failures.push(`${requiredTemplateFile} exists but is not a file`)
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      failures.push(`Missing required template file: ${requiredTemplateFile}`)
    } else {
      throw error
    }
  }
}

try {
  const latestInfo = await Deno.lstat('./template/latest')
  if (!latestInfo.isSymlink) {
    failures.push('template/latest must be a symlink')
  } else {
    const latestTarget = await Deno.readLink('./template/latest')
    assertEqual('template/latest target', latestTarget, VERSION)
  }
} catch (error) {
  if (error instanceof Deno.errors.NotFound) {
    failures.push('Missing template/latest symlink')
  } else {
    throw error
  }
}

if (failures.length > 0) {
  console.error('❌ Version references are out of sync:')
  for (const failure of failures) {
    console.error(`- ${failure}`)
  }
  Deno.exit(1)
}

console.log(`✅ All version references are in sync for ${VERSION}`)
