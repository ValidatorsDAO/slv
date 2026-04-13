import { Command } from '@cliffy'
import { colors } from '@cliffy/colors'
import { SKILL_NAMES, syncSkills } from '@/skills/syncSkills.ts'

export const skillsCmd = new Command()
  .description(`🧠 Manage AI agent skills (~/.slv/skills)

Skills are the per-agent instruction files (AGENT.md, SKILL.md) that the
AI console loads when delegating to a specialist agent. They live in
~/.slv/skills/ and are downloaded from GitHub on first install.

Run \`slv skills sync\` after pulling new CLI versions to make sure your
local skills match the latest instructions. \`slv upgrade\` also runs a
sync automatically.
`)
  .action(() => {
    skillsCmd.showHelp()
  })

skillsCmd
  .command('sync')
  .description('Re-download AI agent skills from GitHub')
  .option('-f, --force', 'Re-write files even if already up to date', {
    default: false,
  })
  .option(
    '-s, --skill <name:string>',
    `Only sync a specific skill (repeatable). Known: ${SKILL_NAMES.join(', ')}`,
    { collect: true },
  )
  .action(async (options: { force?: boolean; skill?: string[] }) => {
    try {
      const result = await syncSkills({
        force: options.force ?? false,
        only: options.skill,
      })
      if (result.failed > 0) {
        console.log(
          colors.yellow(
            `\nSome files failed to download. Check your network and retry with --force.`,
          ),
        )
        Deno.exit(1)
      }
    } catch (err) {
      console.error(
        colors.red(`Failed to sync skills: ${(err as Error).message}`),
      )
      Deno.exit(1)
    }
  })

skillsCmd
  .command('list')
  .alias('ls')
  .description('List known AI agent skills')
  .action(() => {
    console.log(colors.bold('Known AI agent skills:'))
    for (const name of SKILL_NAMES) {
      console.log(`  - ${name}`)
    }
    console.log(
      colors.gray(`\nRun \`slv skills sync\` to fetch the latest versions.`),
    )
  })
