import {
  applyVersionUpdates,
  checkSolanaReleases,
  type VersionUpdate,
} from '@/ai/console/checkRelease.ts'

const refreshVersionsYml = async () => {
  try {
    console.log('\n📦 Checking for component version updates...')
    const updates = await checkSolanaReleases()
    if (updates.length === 0) {
      console.log('  ✓ ~/.slv/versions.yml is up-to-date')
      return
    }

    const seen = new Set<string>()
    const display: VersionUpdate[] = []
    for (const u of updates) {
      const key = `${u.component}-${u.network}`
      if (seen.has(key)) continue
      seen.add(key)
      display.push(u)
    }

    for (const u of display) {
      console.log(
        `  • ${u.component} (${u.network}): ${u.current} → ${u.latest}`,
      )
    }

    await applyVersionUpdates(updates)
    const noun = display.length === 1 ? 'component' : 'components'
    console.log(
      `  ✅ ~/.slv/versions.yml updated (${display.length} ${noun})`,
    )
  } catch (error) {
    console.error(
      '  ⚠️  Failed to refresh versions.yml:',
      error instanceof Error ? error.message : String(error),
    )
  }
}

const upgrade = async () => {
  const script = await (await fetch('https://storage.slv.dev/slv/install'))
    .text()
  const process = new Deno.Command('sh', {
    stdin: 'piped',
    stdout: 'inherit',
    stderr: 'inherit',
  }).spawn()
  const writer = process.stdin.getWriter()
  await writer.write(new TextEncoder().encode(script))
  await writer.close()
  const { code } = await process.status

  // Best-effort refresh of ~/.slv/versions.yml from GitHub release tags.
  // Skipped on install failure; network errors are logged but don't fail the upgrade.
  if (code === 0) {
    await refreshVersionsYml()
  }

  // NOTE: skills are re-synced inside the shell installer via
  // `install_skills()` in sh/install. Do not run syncSkills() here — it
  // appends noisy "N unchanged" output after the welcome banner/ASCII
  // art and buries the quick-start message. Users who want to force a
  // skill refresh can run `slv skills sync` directly.
  Deno.exit(code)
}

export { upgrade }
