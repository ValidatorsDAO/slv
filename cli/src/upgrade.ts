import { colors } from '@cliffy/colors'
import { syncSkills } from '@/skills/syncSkills.ts'

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

  // After the shell installer runs, re-sync skills via the Deno native path.
  // The installer already downloads skills, but it uses `curl ... || true`
  // which silently ignores failures. Running syncSkills() here surfaces any
  // missed files and guarantees existing users pick up agent-instruction
  // fixes (e.g. wallet.json protection in AGENT.md) on every upgrade.
  if (code === 0) {
    console.log()
    try {
      await syncSkills({ force: false })
    } catch (err) {
      console.log(
        colors.yellow(
          `⚠ Skills sync after upgrade failed: ${(err as Error).message}`,
        ),
      )
      console.log(
        colors.gray(`  Retry manually with: slv skills sync`),
      )
    }
  }

  Deno.exit(code)
}

export { upgrade }
