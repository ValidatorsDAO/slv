import { exec, spawnSync } from '@elsoul/child-process'
import { configRoot } from '@cmn/constants/path.ts'
import { colors } from '@cliffy/colors'
import { join } from '@std/path'
import { Input, prompt, Select } from '@cliffy/prompt'
import {
  BOT_TEMP_ARCHIVE_URL,
  BOT_TEMP_BRANCH,
  BOT_TEMP_REPO,
  BotTempDirMap,
  BotTempTypeArray,
} from '@cmn/zod/bot.ts'
import { readBotAgreement, writeBotAgreement } from '@/ai/config.ts'
import { initI18n, t } from '@/ai/i18n/index.ts'

// Files that MUST NEVER be destroyed by `slv bot init`. A real incident
// occurred where re-running `slv bot init -y` wiped a funded wallet.json and
// the user lost SOL. These files are treated as sacred — before the target
// directory is touched, they are rescued to a temp path and both a live copy
// and a timestamped .bak.<ts> are restored afterward. .bak files are also
// rescued so the user's recovery trail is never destroyed.
// `.discord-init-notified` is a marker the Setzer agent writes after it has
// sent the first-start Discord welcome message. Preserving it across re-inits
// stops the agent from spamming the user with a fresh welcome every time the
// app is rebuilt or the template is refreshed.
const PROTECTED_FILE_NAMES = ['wallet.json', '.env', '.discord-init-notified']
const PROTECTED_BAK_PATTERN = /^(wallet\.json|\.env)\.bak\.\d+$/

type RescuedFile = { relPath: string; content: Uint8Array }

const rescueProtectedFiles = async (
  appDir: string,
): Promise<RescuedFile[]> => {
  const rescued: RescuedFile[] = []
  // Top-level protected files
  for (const name of PROTECTED_FILE_NAMES) {
    try {
      const content = await Deno.readFile(join(appDir, name))
      rescued.push({ relPath: name, content })
    } catch { /* absent */ }
  }
  // Existing backup files (never destroy the user's recovery trail)
  try {
    for await (const entry of Deno.readDir(appDir)) {
      if (entry.isFile && PROTECTED_BAK_PATTERN.test(entry.name)) {
        try {
          const content = await Deno.readFile(join(appDir, entry.name))
          rescued.push({ relPath: entry.name, content })
        } catch { /* ignore unreadable */ }
      }
    }
  } catch { /* dir missing */ }
  return rescued
}

const restoreRescuedFiles = async (
  appDir: string,
  rescued: RescuedFile[],
): Promise<string[]> => {
  const restoredNames: string[] = []
  const ts = Date.now()
  for (const f of rescued) {
    const target = join(appDir, f.relPath)
    await Deno.writeFile(target, f.content)
    restoredNames.push(f.relPath)
    // For live protected files (not pre-existing .bak.* entries), also drop a
    // fresh timestamped backup so there is always at least one .bak copy after
    // a re-init, even if the user later edits the restored original.
    if (PROTECTED_FILE_NAMES.includes(f.relPath)) {
      const bakPath = join(appDir, `${f.relPath}.bak.${ts}`)
      try {
        await Deno.writeFile(bakPath, f.content)
        restoredNames.push(`${f.relPath}.bak.${ts}`)
      } catch { /* non-fatal */ }
    }
  }
  return restoredNames
}

// Returns true if a trade-app process appears to be running from the given
// appDir. We refuse to re-init while the bot is live so we don't race with an
// active server.
const isBotRunningFromDir = async (appDir: string): Promise<boolean> => {
  try {
    const p = new Deno.Command('pgrep', {
      args: ['-af', 'target/release'],
      stdout: 'piped',
      stderr: 'null',
    })
    const out = await p.output()
    if (!out.success) return false
    const text = new TextDecoder().decode(out.stdout)
    return text.split('\n').some((line) => line.includes(appDir))
  } catch {
    return false
  }
}

// Show the sample-usage disclaimer once per user (first `slv bot init`), then
// proceed automatically. This used to be an interactive Yes/No prompt, but it
// blocked AI agents (e.g. Setzer) that invoke `slv bot init` as a subprocess.
// Now it's a one-time informational notice — no blocking, no prompts.
const showBotInitNoticeOnce = async (): Promise<void> => {
  if (await readBotAgreement()) return
  await initI18n()

  console.log()
  console.log(
    colors.bold.yellow(`⚠ ${t('slv bot init — trade-app is an example only')}`),
  )
  console.log()
  console.log(
    colors.white(
      t(
        'The trade-app template is only an example of Solana on-chain transaction detection and submission. When the app starts, a wallet.json is created; trading begins once you deposit SOL into it, and your assets may decrease. Use this sample as a base for your own AI-assisted improvements — it can greatly reduce the effort of building Solana apps, but it is powerful and may cause financial loss in some cases.',
      ),
    ),
  )
  console.log()

  await writeBotAgreement(true)
}

/**
 * Initialize a new Solana trade bot application by downloading the template
 * directly from the GitHub repository (temp-release/).
 * @param options Options for initializing the bot
 * @returns Promise<boolean> indicating success or failure
 */

export const initBotTemplate = async (options: { queue: boolean; template?: string; name?: string; yes?: boolean }) => {
  try {
    await showBotInitNoticeOnce()
    // Create a directory for the bot if it doesn't exist
    const botConfigDir = join(configRoot, 'bot')
    try {
      await Deno.stat(botConfigDir)
    } catch (_error) {
      await Deno.mkdir(botConfigDir, { recursive: true })
    }

    // Select template type (skip prompt if provided via -t)
    let templateType = options.template
    if (!templateType) {
      const result = await prompt([
        {
          name: 'templateType',
          message: 'Select Bot Template Type',
          type: Select,
          options: BotTempTypeArray,
        },
      ])
      templateType = result.templateType
    }

    if (!templateType) {
      console.log(colors.yellow('⚠️ No template type selected'))
      return false
    }

    // Validate template type
    if (!BotTempTypeArray.includes(templateType as typeof BotTempTypeArray[number])) {
      console.log(colors.red(`❌ Invalid template type: ${templateType}`))
      console.log(colors.white(`Available types: ${BotTempTypeArray.join(', ')}`))
      return false
    }

    // App name (skip prompt if provided via -n)
    let appName = options.name
    if (!appName) {
      const result = await prompt([
        {
          type: Input,
          name: 'appName',
          message: 'Enter your bot application name',
          default: 'solana-trade-bot',
          validate: (value: string) => {
            if (!value.trim()) {
              return 'App name cannot be empty'
            }
            if (!/^[a-zA-Z0-9-_]+$/.test(value)) {
              return 'App name can only contain letters, numbers, hyphens, and underscores'
            }
            return true
          },
        },
      ])
      appName = result.appName
    }

    if (!appName) {
      console.log(colors.yellow('⚠️ No app name provided'))
      return false
    }

    const home = Deno.env.get('HOME') || '/home/solv'
    const slvDir = join(home, 'slv')
    const appDir = join(slvDir, appName)

    // Ensure ~/slv directory exists
    try {
      await Deno.stat(slvDir)
    } catch (_error) {
      console.log(colors.blue(`📁 Creating slv directory at ${slvDir}`))
      await Deno.mkdir(slvDir, { recursive: true })
    }

    // Check if app directory already exists
    let shouldOverwrite = false
    let dirExists = false
    try {
      await Deno.stat(appDir)
      dirExists = true
      console.log(colors.yellow(`⚠️ Directory ${appDir} already exists`))

      if (options.yes) {
        shouldOverwrite = true
      } else {
        const { overwrite } = await prompt([
          {
            name: 'overwrite',
            message: 'Directory already exists. Overwrite?',
            type: Select,
            options: [
              { name: 'Yes', value: 'yes' },
              { name: 'No', value: 'no' },
            ],
            default: 'no',
          },
        ])

        if (overwrite !== 'yes') {
          console.log(colors.yellow('⚠️ Operation cancelled'))
          return false
        }
        shouldOverwrite = true
      }
    } catch (_error) {
      // Directory doesn't exist, which is fine
    }

    // --- Overwrite safety layer ---
    // When overwriting an existing directory, we MUST preserve any funded
    // wallet.json / .env and existing .bak.* files. We also refuse to
    // re-init while the bot binary is running from that directory.
    let rescuedFiles: RescuedFile[] = []
    if (shouldOverwrite && dirExists) {
      if (await isBotRunningFromDir(appDir)) {
        console.log(
          colors.red(
            `❌ Refusing to overwrite ${appDir}: a trade-app process is ` +
              `currently running from this directory.`,
          ),
        )
        console.log(
          colors.white(
            `   Stop it first with: pkill -f "${appDir}/target/release"`,
          ),
        )
        return false
      }

      rescuedFiles = await rescueProtectedFiles(appDir)
      if (rescuedFiles.length > 0) {
        const walletFound = rescuedFiles.some((f) => f.relPath === 'wallet.json')
        if (walletFound) {
          console.log(
            colors.bold.yellow(
              `🛡  wallet.json detected — it will be preserved, not overwritten.`,
            ),
          )
        }
        console.log(
          colors.yellow(
            `   Rescuing ${rescuedFiles.length} protected file(s): ${
              rescuedFiles.map((f) => f.relPath).join(', ')
            }`,
          ),
        )
      }

      console.log(colors.blue(`🗑️ Removing existing directory...`))
      await exec(`rm -rf "${appDir}"`)
    }

    // Create the app directory
    console.log(colors.blue(`📁 Creating directory ${appDir}`))
    await Deno.mkdir(appDir, { recursive: true })

    // Download and extract template
    console.log(colors.blue(`📦 Downloading ${templateType} template...`))

    if (options.queue) {
      console.log(colors.blue('Using queue mode for template download'))
    }

    // Resolve template directory name inside temp-release/
    const tempDirName =
      BotTempDirMap[templateType as keyof typeof BotTempDirMap]

    if (!tempDirName) {
      console.error(
        colors.red(
          `❌ No template directory found for template type: ${templateType}`,
        ),
      )
      return false
    }

    // Derive the repo name from the archive (e.g. "solana-stream")
    const repoName = BOT_TEMP_REPO.split('/')[1]
    // tar filter path: <repo>-<branch>/temp-release/<dir>/
    const tarFilter =
      `${repoName}-${BOT_TEMP_BRANCH}/temp-release/${tempDirName}/`

    console.log(
      colors.gray(
        `Source: github.com/${BOT_TEMP_REPO} (branch: ${BOT_TEMP_BRANCH})`,
      ),
    )
    console.log(colors.gray(`Template: temp-release/${tempDirName}`))

    try {
      // Download the GitHub archive and extract only the target template directory
      console.log(
        colors.blue('📥 Downloading latest template from GitHub...'),
      )
      const dlCmd = `curl -fsSL "${BOT_TEMP_ARCHIVE_URL}" | tar -xz -C "${appDir}" --strip-components=3 "${tarFilter}"`
      const dlResult = await exec(
        `sh -c ${JSON.stringify(dlCmd)}`,
      )

      if (!dlResult.success) {
        throw new Error(
          `Download/extract failed: ${dlResult.message || 'Unknown error'}`,
        )
      }

      // Verify extraction produced files
      const entries: string[] = []
      for await (const entry of Deno.readDir(appDir)) {
        entries.push(entry.name)
      }
      if (entries.length === 0) {
        throw new Error(
          'Template extraction produced no files. The template directory may not exist in the repository.',
        )
      }

      console.log(
        colors.green(`✅ Template downloaded (${entries.length} items)`),
      )

      // Restore rescued protected files (wallet.json, .env, .bak.*) so a
      // re-init never destroys a funded wallet. For live files we also write
      // a fresh .bak.<ts> snapshot as an extra safety copy.
      if (rescuedFiles.length > 0) {
        const restored = await restoreRescuedFiles(appDir, rescuedFiles)
        console.log(
          colors.green(
            `🛡  Restored ${restored.length} protected file(s): ${
              restored.join(', ')
            }`,
          ),
        )
      }

      const isRust = templateType.includes('rust') ||
        templateType === 'trade-app'
      console.log(colors.blue('🔧 Initializing git repository...'))
      await exec(`cd ${appDir} && git init`)
      try {
        await exec(`code ${appDir}`)
      } catch (_error) {
        // Ignore error if code command fails
      }

      console.log(
        colors.green(
          `✅ Successfully created Solana trade bot application at ${appDir}`,
        ),
      )

      const msg = isRust
        ? `$ cargo build -r\n$ ./target/release/${appName}`
        : `$ pnpm install\n$ pnpm dev`
      console.log(
        colors.white(`
To get started with your new application, run the following commands:

$ cd ${appName}
$ cp .env.sample .env
${msg}
  `),
      )
    } catch (error) {
      console.error(
        colors.red('❌ Failed to download or extract template:'),
        error,
      )
      // The directory was wiped but extraction failed — restore rescued
      // protected files so the user never loses wallet.json even on a
      // crashed re-init. Recreate the directory first if needed.
      if (rescuedFiles.length > 0) {
        try {
          await Deno.mkdir(appDir, { recursive: true })
          const restored = await restoreRescuedFiles(appDir, rescuedFiles)
          console.log(
            colors.yellow(
              `🛡  Restored ${restored.length} protected file(s) after ` +
                `failed init: ${restored.join(', ')}`,
            ),
          )
        } catch (restoreErr) {
          console.error(
            colors.red(
              `❌ CRITICAL: failed to restore rescued files. ` +
                `Contents were held in memory only and may be lost.`,
            ),
            restoreErr,
          )
        }
      }
      return false
    }
    return true
  } catch (error) {
    console.error(colors.red('❌ Failed to initialize bot template:'), error)
    return false
  }
}
