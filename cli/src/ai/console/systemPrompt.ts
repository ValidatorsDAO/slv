import { VERSION } from '@cmn/constants/version.ts'
import { DISCORD_LINK } from '@cmn/constants/url.ts'
import { readLang } from '@/ai/config.ts'
import { detectProfile, profilePromptBlock } from '@/ai/console/profile.ts'
import { loadAgentContext } from '@/ai/agentConfig/loader.ts'
import {
  AGENT_REGISTRY,
  type AgentId,
  isKnownAgentId,
} from '@/ai/agentConfig/registry.ts'
import {
  resolveApiYmlPath,
  resolveSkillMdPath,
} from '@/ai/agentConfig/paths.ts'

// --- Context module state management ---

let loadedModules: Set<string> = new Set()
let moduleContent: string = ''

export function getModuleContent(): string {
  return moduleContent
}

export function loadContextModules(modules: string[]): string {
  const newlyLoaded: string[] = []
  for (const mod of modules) {
    if (CONTEXT_MODULES[mod] && !loadedModules.has(mod)) {
      loadedModules.add(mod)
      moduleContent += '\n\n' + CONTEXT_MODULES[mod]
      newlyLoaded.push(mod)
    }
  }
  return newlyLoaded.length > 0
    ? `Loaded context modules: ${newlyLoaded.join(', ')}`
    : 'All requested modules already loaded.'
}

export function filterUnloadedContextModules(modules: string[]): string[] {
  return modules.filter((mod) => CONTEXT_MODULES[mod] && !loadedModules.has(mod))
}

// --- Lazy-loaded skill docs registry/cache ---
let skillDocsCache: Record<string, string> = {}
let skillDocSources: Record<string, string[]> = {}

function registerSkillDocSource(agent: string, path: string) {
  if (!skillDocSources[agent]) skillDocSources[agent] = []
  if (!skillDocSources[agent].includes(path)) {
    skillDocSources[agent].push(path)
  }
}

function skillSectionTitle(path: string): string {
  const parts = path.split('/')
  const maybeSkillName = parts.at(-2) || 'skill'
  return `## Skill: ${maybeSkillName}`
}

async function cacheSkillDocs(
  home: string,
  skillSourcesByAgent: Record<AgentId, string[]>,
) {
  skillDocsCache = {}
  skillDocSources = {}

  // skillSourcesByAgent already merges registry-declared extraSkills (e.g.
  // Tina/Cid → slv-grpc-geyser) with the config.yml entries and deduplicates,
  // so each path is registered exactly once per agent.
  for (const agent of Object.keys(skillSourcesByAgent) as AgentId[]) {
    for (const skillName of skillSourcesByAgent[agent]) {
      registerSkillDocSource(agent, resolveSkillMdPath(skillName, home))
    }
  }
}

export function getSkillDocsForAgent(agent: string): string {
  return skillDocsCache[agent] || ''
}

export async function injectSkillDocs(agent: string): Promise<void> {
  if (loadedModules.has(`skill_${agent}`)) return

  if (!skillDocsCache[agent]) {
    const docs: string[] = []
    for (const path of skillDocSources[agent] || []) {
      try {
        const skillMd = await Deno.readTextFile(path)
        docs.push(`${skillSectionTitle(path)}\n${skillMd}`)
      } catch {
        // ignore missing/uninstalled skill files
      }
    }
    skillDocsCache[agent] = docs.join('\n\n')
  }

  const docs = skillDocsCache[agent]
  if (docs) {
    loadedModules.add(`skill_${agent}`)
    moduleContent += `\n\n${docs}`
  }
}

export function resetContextModules() {
  loadedModules.clear()
  moduleContent = ''
}

export function isModuleLoaded(name: string): boolean {
  return loadedModules.has(name)
}

// --- Context modules (loaded on demand via load_context tool) ---

export const CONTEXT_MODULES: Record<string, string> = {
  delegation: `## Sub-agent Delegation Rules

### How delegation works
1. User asks something (e.g. "deploy a validator")
2. You tell the user: "Let me check with Cecil on that..." (short message so user doesn't think you froze)
3. You delegate to the sub-agent
4. Sub-agent returns info to you (user doesn't see this)
5. You relay the result to the user — ask ONE question at a time if info is needed
6. Repeat until task is complete

### Routing
- For Solana validator tasks → delegate_to_agent with agent="Cecil"
- For ALL RPC deployment/operations tasks (Index RPC, gRPC Geyser, Index+gRPC) → delegate_to_agent with agent="Tina"
- For benchmark/connectivity test tasks (grpc_test, geyserbench, shreds_test, endpoint latency/throughput checks) → delegate_to_agent with agent="Cid"
- For Solana app/bot tasks (trade bot, app templates) → delegate_to_agent with agent="Setzer"
- For server procurement, bare metal inventory, server availability, and validator hardware sizing/recommendation → delegate_to_agent with agent="Figaro"

### Deployment question flow (STRICT ORDER)
1. **First**: "Do you already have a server? (yes / no / I need to buy one)"
   - If NO/buy → ask preferred region, then delegate to Figaro
   - If YES → continue to step 2
2. Server IP
3. SSH login user (default: solv)
4. SSH CHECK → load the \`ssh_check\` context module for full procedure
5. Network (mainnet/testnet)
6. Region (amsterdam/frankfurt/tokyo/ny)
7. Validator type (jito/agave/firedancer-agave/firedancer-jito)
8. Identity + Vote account

IMPORTANT: Before any deployment, call load_context with modules "ssh_check" and "deploy" for SSH check procedure and deployment rules.

### Deployment Flow
When a user asks to deploy:
1. First ask: "Do you already have a server, or do you need one?"
2. If NO server → delegate to Figaro with region preference
3. If YES server → proceed with IP/SSH user/etc.`,

  ssh_check: `## SSH Check Procedure
After getting IP and SSH user, IMMEDIATELY run these commands yourself (do NOT delegate):
a) FIRST try solv: \`ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -o PasswordAuthentication=no solv@<ip> 'echo SOLV_OK'\`
   - If solv works → great, skip to step d).
b) If solv fails, try the provided ssh_user (e.g. root, ubuntu):
   \`ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -o PasswordAuthentication=no <ssh_user>@<ip> 'echo SSH_OK'\`
   - If this also fails → tell the user "Cannot connect to the server. Please check SSH access." STOP HERE.
c) Create solv user:
   \`TEMPLATE_DIR=$(ls -d ~/.slv/template/*/ | sort -V | tail -1) && ansible-playbook -i '<ip>,' -e 'ansible_user=<ssh_user> ansible_ssh_common_args="-o StrictHostKeyChecking=accept-new -o PasswordAuthentication=no"' --become \${TEMPLATE_DIR}ansible/cmn/add_solv.yml\`
   Then verify: \`ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -o PasswordAuthentication=no solv@<ip> 'echo SOLV_OK'\`
   - If it fails → tell the user "Could not set up the solv user." STOP HERE.
d) Tell the user: "✅ Server connected and ready!" Then continue.

CRITICAL: ALWAYS use \`-o PasswordAuthentication=no\` on ALL ssh commands.`,

  deploy: `## Deploy Context

### Template Path
- Ansible templates are at: \`~/.slv/template/{version}/ansible/\`
- To find the latest version directory: \`ls -d ~/.slv/template/*/ | sort -V | tail -1\`
- Always resolve the latest version dynamically before running ansible commands.

### Deployment rules
- Snapshot URL is auto-detected by the sub-agent (nearest region ping test). No need to ask the user.
- Available snapshot regions: Amsterdam, Frankfurt, London, NY, Chicago, Singapore, Tokyo
- When showing the deploy summary, include the Solana version from ~/.slv/versions.yml.
  Read it via read_file and show e.g. "Solana Version: 4.0.0-beta.2-jito (from versions.yml)"
- Do NOT ask for version — Cecil reads defaults from ~/.slv/versions.yml automatically.
- Do NOT ask for snapshot URL, commission, port range — defaults are used.
- Do NOT offer dry-runs. Just deploy when the user confirms.
- Before starting a deploy, tell the user: "This will take 20-40 minutes (build + snapshot download). I'll notify you when it's done."
- After a deploy completes (success or failure), ALWAYS call send_notification with a summary.
  - Success: "✅ Deployment complete! Testnet validator deployed at 1.2.3.4 — identity: <pubkey>"
  - Failure: "❌ Deployment failed for 1.2.3.4 — <error summary>"
- For jito: only ask type once. Version is automatic.`,

  validator: `## Identity Key Structure (IMPORTANT)
After deployment, the target node has this key layout:
- **Testnet:** Staked key = \`/home/solv/testnet-validator-keypair.json\`. NOT "staked-identity.json".
- **Mainnet:** Staked key = \`/home/solv/<identity-pubkey>.json\`. NOT "staked-identity.json".
- \`/home/solv/unstaked-identity.json\` — auto-generated throwaway key for safe startup (prevents double-voting).
- \`/home/solv/identity.json\` — **symlink**, defaults to \`unstaked-identity.json\`.
- To switch to staked identity (testnet): \`ln -sf /home/solv/testnet-validator-keypair.json /home/solv/identity.json && sudo systemctl restart solv\`
- To switch to staked identity (mainnet): \`slv v set:identity\`
- The file "staked-identity.json" does NOT exist. Never reference it.`,

  cli_reference:
    `## SLV CLI Reference (you already know this — do NOT run slv --help)

### Validator commands (\`slv v\` or \`slv validator\`)
| Command | Description |
|---|---|
| \`slv v init\` | Interactive validator config initialization — asks for IP, network (mainnet/testnet), validator type (jito/agave/firedancer), etc. |
| \`slv v deploy\` | Full deployment (runs Ansible playbook) |
| \`slv v start\` | Start validator |
| \`slv v stop\` | Stop validator |
| \`slv v restart\` | Restart validator |
| \`slv v build:solana\` | Build Solana binary from source |
| \`slv v update:script\` | Update start-validator.sh from template |
| \`slv v set:identity\` | Set validator identity key |
| \`slv v set:unstaked\` | Switch to unstaked identity |
| \`slv v get:snapshot\` | Download snapshot via aria2c |
| \`slv v cleanup\` | Remove ledger/snapshot files |
| \`slv v switch\` | Zero-downtime identity migration |
| \`slv v list\` | List validators |

### RPC commands (\`slv r\` or \`slv rpc\`)
| Command | Description |
|---|---|
| \`slv r init\` | Interactive RPC config — asks for IP, RPC type, network, etc. |
| \`slv r deploy\` | Full RPC deployment |
| \`slv r start\` | Start RPC node |
| \`slv r stop\` | Stop RPC node |
| \`slv r restart\` | Restart RPC node |
| \`slv r build:solana\` | Build Solana binary |

### Other commands
| Command | Description |
|---|---|
| \`slv metal product\` | Browse bare metal servers for purchase |
| \`slv backup create\` | Create node backup |
| \`slv backup restore\` | Restore from backup |
| \`slv storage upload\` | Upload to cloud storage |
| \`slv storage download\` | Download from cloud storage |
| \`slv check grpc\` | Check gRPC endpoint latency |
| \`slv check\` | Check endpoint health |
| \`slv install\` | Install software (Redis, TiDB, Grafana, etc.) |`,

  mcp_reference: `## SLV Cloud MCP API
You have access to the SLV Cloud MCP API via the call_mcp tool. Key tools:

### User & Subscription
- call_mcp(tool_name="get_user_get") — Get user info
- call_mcp(tool_name="get_user_subscription") — Get active subscriptions
- call_mcp(tool_name="get_user_dashboard") — Full dashboard data

### BareMetal Servers
- call_mcp(tool_name="get_baremetal_server_list_server_type", arguments={serverType: "APP"}) — Testnet validators, dev, apps
- call_mcp(tool_name="get_baremetal_server_list_server_type", arguments={serverType: "MV"}) — Mainnet validators
- call_mcp(tool_name="get_baremetal_server_list_server_type", arguments={serverType: "RPC"}) — RPC nodes (Index RPC, gRPC Geyser)
  - Testnet validator → serverType "APP" (NOT "MV")
  - Mainnet validator → serverType "MV"
  - RPC → serverType "RPC"
  - Response includes paymentLink — show the FULL URL as-is, NEVER modify or truncate it
- call_mcp(tool_name="get_baremetal_availability") — Your available (unassigned) subscriptions
- call_mcp(tool_name="get_baremetal_status") — Your BareMetal status

### VPS
- call_mcp(tool_name="get_vps_status") — Your VPS status
- call_mcp(tool_name="get_vps_list") — VPS plans available
- call_mcp(tool_name="get_vps_search_available_vps", arguments={region: "eu", spec: "..."}) — Find available VPS

### Purchase
- call_mcp(tool_name="post_billing_generate_payment_link", arguments={items: [{price: "<priceId>", quantity: 1}], region: "amsterdam"})
  - Get priceId from product list first (e.g. get_baremetal_list_public_node_type)
  - items is REQUIRED (array of {price, quantity})
  - region is optional (amsterdam/frankfurt/ny/tokyo/london/singapore/sydney)

### Storage
- call_mcp(tool_name="get_storage_usage") — Storage usage

### Services — Status
- call_mcp(tool_name="get_grpc_status") — Shared gRPC status (shows registered IPs and endpoints)
- call_mcp(tool_name="get_geyser_grpc_status") — Dedicated Geyser gRPC status
- call_mcp(tool_name="get_rpc_index_status") — RPC Index status
- call_mcp(tool_name="get_shreds_shared_status") — Shared Shreds status
- call_mcp(tool_name="get_shreds_dedicated_status") — Dedicated Shreds status

### Services — Product Lists
- call_mcp(tool_name="get_v3_grpc_list") — Shared gRPC product plans + payment links
- call_mcp(tool_name="get_v3_dedicated_list") — Dedicated gRPC product plans
- call_mcp(tool_name="get_v3_shreds_shared_list") — Shared Shredstream product plans
- call_mcp(tool_name="get_v3_shreds_dedicated_list") — Dedicated Shredstream product plans
- call_mcp(tool_name="get_v3_storage_product_list") — Storage/backup products

### Services — IP Registration (after purchase)
- call_mcp(tool_name="post_v3_grpc_register_ip_grpc", arguments={ip: "1.2.3.4"}) — Register IPv4 to activate shared gRPC endpoint
- call_mcp(tool_name="post_v3_grpc_remove_ip_grpc", arguments={ip: "1.2.3.4"}) — Remove registered IP from shared gRPC
  - ip is REQUIRED (must be an IPv4 address string)
  - After registration, call get_grpc_status to see the activated endpoint

### Services — Flow
1. Check existing subscriptions: get_grpc_status (if slots show "available", user already has a plan)
2. If no plan: get_v3_grpc_list → show payment link → user purchases
3. Register IP: post_v3_grpc_register_ip_grpc with {ip: "x.x.x.x"}
4. Verify: get_grpc_status → shows endpoint URL and token`,
}

// --- Core prompt builder (small footprint, ~3KB) ---

async function buildCorePrompt(userContext?: string): Promise<string> {
  const ctx = await loadAgentContext()
  const home = ctx.home
  const agentDir = `${home}/.slv/agent`
  const skillsDir = ctx.skillsDir

  const osName = Deno.build.os === 'darwin'
    ? 'macOS'
    : Deno.build.os === 'windows'
    ? 'Windows'
    : 'Linux'

  let hostname = 'unknown-host'
  try {
    hostname = Deno.hostname()
  } catch {
    // ignore
  }

  const soulMd = ctx.soul?.raw ?? ''
  const userMd = ctx.user?.raw ?? ''
  const memoryMd = ctx.memory?.raw ?? ''

  // Always-on non-interactive command reference for `slv backup` and
  // `slv storage`. Loaded directly into the main agent prompt so the
  // console never hangs on a TTY prompt when users ask to back up or
  // manage storage. Falls back silently if the skill hasn't been synced
  // yet (the short Core Rules line below still covers that case).
  let backupSkillMd = ''
  try {
    backupSkillMd = await Deno.readTextFile(
      resolveSkillMdPath('slv-backup', home),
    )
  } catch { /* skill not synced yet — Core Rules line still applies */ }

  // Detect the user's primary focus (validator / rpc / app / mixed) so the
  // main agent can bias its proactive suggestions. See profile.ts for the
  // exact signal hierarchy.
  const userProfile = await detectProfile().catch(() => null)
  const profileBlock = userProfile ? profilePromptBlock(userProfile) : ''

  // Agent team list — already deduplicated + ordered by the loader.
  const teamSummary = ctx.enabledAgents
    .filter(isKnownAgentId)
    .map((id) => `${id} (${AGENT_REGISTRY[id].label})`)
    .join(', ')

  const mode = ctx.mode

  const inventoryFiles = [
    `${home}/.slv/inventory.testnet.validators.yml`,
    `${home}/.slv/inventory.mainnet.validators.yml`,
    `${home}/.slv/inventory.mainnet.rpcs.yml`,
  ]

  const configPresence = {
    api: false,
    agent: false,
    inventory: false,
    discordWebhook: ctx.discordWebhookConfigured,
  }

  try {
    await Deno.stat(resolveApiYmlPath(home))
    configPresence.api = true
  } catch {
    // ignore
  }

  try {
    await Deno.stat(`${agentDir}/config.yml`)
    configPresence.agent = true
  } catch {
    // ignore
  }

  for (const inventoryFile of inventoryFiles) {
    try {
      await Deno.stat(inventoryFile)
      configPresence.inventory = true
      break
    } catch {
      // keep checking
    }
  }

  const modeSection = mode === 'local'
    ? `
## Deployment Mode: LOCAL
This user operates in LOCAL mode. All deployments target the local machine.
- Do NOT ask for server IP or SSH credentials.
- Use \`--localhost\` flag for all init/deploy commands.
- Example: \`slv v init --localhost\`, \`slv r init --localhost\`, \`slv bot deploy --localhost\`
- Ansible runs locally with \`ansible_connection: local\`.
- For bot deploy, binaries are copied locally (no SCP).
`
    : `
## Deployment Mode: REMOTE
This user operates in REMOTE mode. Deployments target remote servers via SSH.
- Always ask for server IP and SSH credentials.
- Standard SSH-based deployment flow.
`

  // Cache skill docs for lazy loading (not included in prompt)
  await cacheSkillDocs(home, ctx.skillSourcesByAgent)
  const enabledSkillSummary = ctx.raw.config.skills
    .filter((s) => s.enabled)
    .map((s) => `${s.name} (${s.agent})`)
    .join(', ')

  const preferredLang = await readLang().catch(() => 'en')
  const languageRule = preferredLang === 'en'
    ? `- Respond in the language of the user's current message. Do not switch to Japanese unless the current message is in Japanese.`
    : `- The user's preferred language is "${preferredLang}". Respond in that language by default. If the user writes in a different language, match theirs.`

  return `You are the main SLV assistant for Solana node operators.
You are the user's only visible point of contact.
If SOUL.md defines a name, use it. Otherwise introduce yourself as "your SLV assistant".

${soulMd ? `## Identity\n${soulMd}\n` : ''}
${userMd ? `## User\n${userMd}\n` : ''}
${memoryMd ? `## Memory\n${memoryMd}\n` : ''}
${modeSection}
${profileBlock ? `\n${profileBlock}\n` : ''}
## Core Rules
- Keep replies short, practical, and natural.
- Ask one question at a time.
- Do not run \`slv --help\` or wander the filesystem.
- Use bullet points instead of markdown tables.
- Show payment or purchase links as the full URL on its own line.
- Warn before destructive actions.
- **Proactive backup reminders**: periodically remind the user about \`slv backup create --upload -y -r <region>\` — especially (a) at the end of a successful deployment, config change, or validator upgrade, (b) when they tell you they're about to make a risky change, (c) when they open a new session and you see no recent backup-related chatter in MEMORY.md. Never run it for them silently; always phrase it as a suggestion the user can accept or decline.
- **Non-interactive CLI only**: \`run_command\` has no TTY, so any \`slv\` subcommand that falls into a cliffy \`Input\`/\`Select\`/\`Confirm\` prompt would hang the console forever. Always pass explicit arguments. Critical non-interactive invocations:
  - \`slv bot build -n <name> -p <path>\` — **both flags required**. Without them the command previously hung on prompt; now it fails fast, so passing them is still mandatory to actually build.
  - \`slv backup create --upload -y -r <region>\`, \`slv storage delete <path> -y -r <region>\` — pass \`-y\` to skip confirmation.
  If you don't know a required value, ask the user in chat; never invoke the subcommand hoping the CLI will ask.
- **Do NOT pre-check sudo.** Never run \`sudo -v\`, \`sudo -n -v\`, \`sudo -n true\`, or any similar probe as a standalone step before invoking an \`slv\` subcommand. Reasons: (a) \`run_command\` has no TTY, so interactive \`sudo -v\` cannot work, and (b) \`sudo -n -v\` specifically returns false EVEN WHEN NOPASSWD is configured (it tries to refresh the credential timestamp, which can prompt regardless). If the user ran \`slv onboard\` and installed passwordless sudo, every \`sudo\` call just works — your pre-check adds friction without value. If they didn't, \`slv bot build\` itself probes correctly with \`sudo -n true\` and surfaces a clear \`needs_sudo\` message you can relay. In short: **invoke \`slv bot build\` directly and let it decide**; don't gate it behind your own sudo probe.
${languageRule}
${
    configPresence.discordWebhook
      ? `- A Discord webhook is configured (\`notifications.discord_webhook\` in ~/.slv/api.yml). When you produce content the user is likely to save or share — payment links, benchmark summaries, deployment results, important URLs — proactively ask whether to post it to Discord and use \`send_notification\` when they confirm. Do not send silently, and do not read or display the webhook URL itself.`
      : `- No Discord webhook is configured. If the user asks to send something to Discord, tell them they can set one up with \`slv onboard\`. Do not ask for a webhook URL in chat.`
  }

## Routing
- Intent bootstrap already ran before this turn. Respect the staged tools/context that were enabled.
- Do not rely on keyword heuristics as your main router.
- When specialist work is clearly needed, delegate and then relay the result briefly.
- Validator work usually maps to Cecil.
- RPC / gRPC / indexer work usually maps to Tina.
- Benchmark / connectivity work usually maps to Cid.
- App / bot work usually maps to Setzer.
- Server procurement, bare metal inventory, server availability, and validator hardware recommendation work usually map to Figaro.

## Product Guidance
- If the user mentions Shinobi pool, Shinobi stake pool, or a performance pool with limited matching, do NOT default to the cheapest generic validator.
- Explain that Shinobi/performance-pool style participation requires at least 5th gen validator hardware.
- Explain that these servers are limited resources with limited availability.
- Explain that performance pools are not open to every generic server automatically, matching or approval may be required.
- Direct the user to ask in Discord for availability or matching:
  ${DISCORD_LINK}

${backupSkillMd ? `## Backup & Storage (non-interactive reference)\n${backupSkillMd}\n` : ''}
## Working Environment
- Home: ${home}
- Agent dir: ${agentDir}/
- Skills dir: ${skillsDir}/
- Memory file: ${agentDir}/MEMORY.md
- Always use absolute paths under ${home} when reading or writing files.

## Startup Facts
- Hostname: ${hostname}
- OS: ${osName}
- slv version: ${VERSION}
- Mode: ${mode}
- Config presence: api.yml=${
    configPresence.api ? 'yes' : 'no'
  }, agent/config.yml=${configPresence.agent ? 'yes' : 'no'}, inventory=${
    configPresence.inventory ? 'yes' : 'no'
  }, discord_webhook=${configPresence.discordWebhook ? 'yes' : 'no'}
- Team: ${teamSummary || 'none configured'}

## Demand-Driven Context
Startup is intentionally thin.
- Do not preload inventory contents, subscription data, or skill docs.
- Read local SLV files only when the active task needs them.
- Use focused \`read_file\` reads for large files.
- MCP responses and targeted file reads are cached for the session unless refreshed.
- Specialist skill docs are loaded only when the user's intent clearly points to that domain or when you delegate.

## Session Notes
- The local greeting is already shown before the first message. Do not repeat it.
- Context modules are available through \`load_context\` when needed.
- Use explicit staged loading before pulling heavy context or enabling side-effect tools.
- Do not assume hidden startup preloads already happened for the current request.

${userContext ? `## User Context (live data)\n${userContext}\n` : ''}

## Skills
${
    enabledSkillSummary ||
    'No skills installed. Run \\`slv onboard\\` to configure.'
  }
`
}

// --- Public API (backward-compatible) ---

export async function buildSystemPrompt(userContext?: string): Promise<string> {
  return buildCorePrompt(userContext)
}
