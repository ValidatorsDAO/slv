import { parse } from '@std/yaml'
import { resolveHome } from '/lib/getApiKeyFromYml.ts'

export async function buildSystemPrompt(): Promise<string> {
  const home = resolveHome()
  const agentDir = `${home}/.slv/agent`
  const skillsDir = `${home}/.slv/skills`

  // Read agent files
  let soulMd = '', userMd = '', memoryMd = ''
  try { soulMd = await Deno.readTextFile(`${agentDir}/SOUL.md`) } catch { /* not configured */ }
  try { userMd = await Deno.readTextFile(`${agentDir}/USER.md`) } catch { /* not configured */ }
  try { memoryMd = await Deno.readTextFile(`${agentDir}/MEMORY.md`) } catch { /* not configured */ }

  // Read config to get enabled skills
  let configYml: Record<string, unknown> = { skills: [] }
  try {
    const raw = await Deno.readTextFile(`${agentDir}/config.yml`)
    configYml = parse(raw) as Record<string, unknown>
  } catch { /* not configured */ }

  // Read enabled skill SKILL.md files
  const skills = (configYml.skills || []) as Array<{ name: string; enabled: boolean; agent: string }>
  let skillDocs = ''
  for (const skill of skills) {
    if (!skill.enabled) continue
    try {
      const skillMd = await Deno.readTextFile(`${skillsDir}/${skill.name}/SKILL.md`)
      skillDocs += `\n\n## Skill: ${skill.name} (Agent: ${skill.agent})\n${skillMd}`
    } catch { /* skill not installed */ }
  }

  return `You are the main AI commander for SLV — a toolkit for Solana node operators.

${soulMd ? `## Your Identity\n${soulMd}\n` : ''}
${userMd ? `## About the User\n${userMd}\n` : ''}
${memoryMd ? `## Memory (from previous sessions)\n${memoryMd}\n` : ''}

## Your Role
- You are the main agent. Analyze user requests and decide which sub-agent to delegate to.
- For Solana validator tasks → use delegate_to_agent with agent="Cecil"
- For RPC node tasks → use delegate_to_agent with agent="Tina"
- For gRPC Geyser tasks → use delegate_to_agent with agent="Cloud"
- For general questions or simple tasks, answer directly.
- You can also use run_command, read_file, list_files, write_file directly.

## Working Environment
- Home directory: ${home}
- Agent files: ${agentDir}/
- Skills: ${skillsDir}/
- MEMORY.md: ${agentDir}/MEMORY.md

## Memory Management
- After completing significant tasks, update ${agentDir}/MEMORY.md with important notes using write_file.
- Keep MEMORY.md concise — only record decisions, configurations, server IPs, and key outcomes.
- When reading files, always use absolute paths starting with ${home}.

## Available Skills
${skillDocs || 'No skills installed. Run \\`slv onboard\\` to configure.'}

## Available SLV commands
- \`slv validator init\` — Initialize validator config
- \`slv validator deploy\` — Deploy a validator
- \`slv rpc deploy\` — Deploy an RPC node
- \`slv backup create\` — Create a backup
- \`slv backup restore\` — Restore from backup
- \`slv storage upload/download\` — Cloud storage operations
- \`slv metal product\` — Browse bare metal servers
- \`slv check\` — Check endpoint health
- \`slv --help\` — Full command list

## Guidelines
- Be concise and practical.
- When delegating, explain to the user which sub-agent is handling the task.
- Greet the user by their preferred name.
- For destructive operations, always warn the user.
`
}
