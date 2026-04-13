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
  // NOTE: skills are re-synced inside the shell installer via
  // `install_skills()` in sh/install. Do not run syncSkills() here — it
  // appends noisy "N unchanged" output after the welcome banner/ASCII
  // art and buries the quick-start message. Users who want to force a
  // skill refresh can run `slv skills sync` directly.
  Deno.exit(code)
}

export { upgrade }
