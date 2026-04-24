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
// the user lost SOL. These files are treated as sacred — they are copied to
// a persistent ~/.slv/wallet-rescue/ tree BEFORE any destructive operation,
// merged into the fresh template in a staging directory, and the live app
// directory is only replaced via an atomic rename (never rm'd in place).
// `.discord-init-notified` is a marker the Setzer agent writes after it has
// sent the first-start Discord welcome message. Preserving it across re-inits
// stops the agent from spamming the user with a fresh welcome every time the
// app is rebuilt or the template is refreshed.
const PROTECTED_FILE_NAMES = ['wallet.json', '.env', '.discord-init-notified']
const PROTECTED_BAK_PATTERN = /^(wallet\.json|\.env)\.bak\.\d+$/

// Persistent rescue root. Every slv bot init that finds protected files drops
// a timestamped copy here and NEVER cleans it up — this is the user's
// permanent recovery trail, outside the bot directory, outside any rm target.
const walletRescueRoot = (): string => {
  const home = Deno.env.get('HOME') || '/home/solv'
  return join(home, '.slv', 'wallet-rescue')
}

// List the top-level protected files (and existing .bak.* snapshots) that
// currently exist in `dir`. Missing dir or missing files are not errors.
const listProtectedFiles = async (dir: string): Promise<string[]> => {
  const found: string[] = []
  for (const name of PROTECTED_FILE_NAMES) {
    try {
      const st = await Deno.stat(join(dir, name))
      if (st.isFile) found.push(name)
    } catch { /* absent */ }
  }
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile && PROTECTED_BAK_PATTERN.test(entry.name)) {
        found.push(entry.name)
      }
    }
  } catch { /* dir missing */ }
  return found
}

// Copy protected files from `src` into ~/.slv/wallet-rescue/<ts>-<appName>/.
// This is the disk-persisted recovery trail: it is done BEFORE the atomic
// swap, so even a SIGKILL / crash / power loss between rescue and swap
// leaves wallet.json recoverable outside the bot directory. Returns the
// rescue directory path, or null if there was nothing protected to rescue.
// Throws if persisting any file fails — we would rather abort init than
// proceed with an incomplete rescue.
const persistProtectedFiles = async (
  src: string,
  appName: string,
  ts: number,
): Promise<{ rescueDir: string; files: string[] } | null> => {
  const files = await listProtectedFiles(src)
  if (files.length === 0) return null
  // wallet.json holds a private key — harden the rescue tree regardless of
  // the caller's umask. chmod is a no-op on Windows and harmless if the
  // paths already have the right bits.
  const root = walletRescueRoot()
  await Deno.mkdir(root, { recursive: true })
  try {
    await Deno.chmod(root, 0o700)
  } catch { /* non-fatal on platforms without POSIX perms */ }
  const rescueDir = join(root, `${ts}-${appName}`)
  await Deno.mkdir(rescueDir, { recursive: true })
  try {
    await Deno.chmod(rescueDir, 0o700)
  } catch { /* non-fatal */ }
  for (const name of files) {
    const dst = join(rescueDir, name)
    await Deno.copyFile(join(src, name), dst)
    try {
      await Deno.chmod(dst, 0o600)
    } catch { /* non-fatal */ }
  }
  return { rescueDir, files }
}

// Merge protected files from the live `src` app dir into the freshly extracted
// `dst` staging dir. For each live protected file we also drop a fresh
// .bak.<ts> snapshot in the staging dir, so the new app directory always has
// an in-tree recovery copy the moment the swap completes.
const mergeProtectedFilesInto = async (
  src: string,
  dst: string,
  ts: number,
): Promise<string[]> => {
  const copied: string[] = []
  const files = await listProtectedFiles(src)
  for (const name of files) {
    await Deno.copyFile(join(src, name), join(dst, name))
    copied.push(name)
    if (PROTECTED_FILE_NAMES.includes(name)) {
      try {
        await Deno.copyFile(join(src, name), join(dst, `${name}.bak.${ts}`))
        copied.push(`${name}.bak.${ts}`)
      } catch { /* non-fatal */ }
    }
  }
  return copied
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
    // When overwriting an existing directory, we refuse to proceed while the
    // bot binary is running from that directory. The actual wallet rescue
    // happens AFTER the template has been successfully extracted into a
    // staging dir — only then do we touch the live appDir, and only via
    // atomic rename. The live appDir is never rm'd in place.
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
    }

    // Prepare staging directory. The template is always extracted here
    // first; the live appDir (if any) is only touched at the very end via
    // atomic rename, after protected files have been persisted to disk
    // rescue and merged into the staging dir. This removes every window
    // where wallet.json lives only in memory.
    const swapTs = Date.now()
    const stagingDir = `${appDir}.new.${swapTs}`
    console.log(colors.blue(`📁 Preparing staging directory ${stagingDir}`))
    await Deno.mkdir(stagingDir, { recursive: true })

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

    let rescueInfo: { rescueDir: string; files: string[] } | null = null
    try {
      // Download the GitHub archive and extract only the target template
      // directory INTO the staging dir. A failure here leaves the live appDir
      // completely untouched.
      console.log(
        colors.blue('📥 Downloading latest template from GitHub...'),
      )
      const dlCmd =
        `curl -fsSL "${BOT_TEMP_ARCHIVE_URL}" | tar -xz -C "${stagingDir}" --strip-components=3 "${tarFilter}"`
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
      for await (const entry of Deno.readDir(stagingDir)) {
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

      // Rescue & merge protected files (wallet.json, .env, .bak.*) from the
      // live appDir into the staging dir. We persist to ~/.slv/wallet-rescue
      // FIRST so that even if the process dies between here and the swap,
      // wallet.json exists on disk outside the bot tree.
      if (dirExists) {
        rescueInfo = await persistProtectedFiles(appDir, appName, swapTs)
        if (rescueInfo) {
          if (rescueInfo.files.includes('wallet.json')) {
            console.log(
              colors.bold.yellow(
                `🛡  wallet.json persisted to ${rescueInfo.rescueDir} — kept permanently as recovery trail.`,
              ),
            )
          }
          console.log(
            colors.yellow(
              `   Persisted ${rescueInfo.files.length} protected file(s): ${
                rescueInfo.files.join(', ')
              }`,
            ),
          )
        }
        const merged = await mergeProtectedFilesInto(appDir, stagingDir, swapTs)
        if (merged.length > 0) {
          console.log(
            colors.green(
              `🛡  Merged ${merged.length} protected file(s) into new template: ${
                merged.join(', ')
              }`,
            ),
          )
        }
      }

      // Atomic swap: appDir → trash, staging → appDir. The live appDir is
      // never rm'd in place; only the trash dir (which contains an obsolete
      // template copy — wallet is already preserved both in the new appDir
      // and in ~/.slv/wallet-rescue) is removed, best-effort.
      if (dirExists) {
        const trashDir = `${appDir}.trash.${swapTs}`
        await Deno.rename(appDir, trashDir)
        try {
          await Deno.rename(stagingDir, appDir)
        } catch (swapErr) {
          // Extremely unlikely (same parent dir, just renamed away), but if
          // the forward rename fails, roll the trash back into place so the
          // user is left with their original directory.
          try {
            await Deno.rename(trashDir, appDir)
          } catch { /* wallet still safe in rescue dir */ }
          throw swapErr
        }
        try {
          await exec(`rm -rf "${trashDir}"`)
        } catch { /* non-fatal */ }
      } else {
        await Deno.rename(stagingDir, appDir)
      }

      const isRust = templateType.includes('rust') ||
        templateType === 'trade-app'
      console.log(colors.blue('🔧 Initializing git repository...'))
      // `cd X && git init` never worked — exec() can't spawn `cd`
      // (shell builtin), so the whole thing ENOENT'd and the repo was
      // never initialized. Pass cwd directly instead.
      //
      // Wrap in try/catch so a host without git installed (minimal
      // Ubuntu images, distroless, …) still gets a usable app dir —
      // the user can `git init` themselves later.
      try {
        await exec('git init', appDir)
      } catch {
        console.log(
          colors.yellow(
            '  ⚠ git not installed — skipped `git init`. Install it with `sudo apt install -y git` if you want version control.',
          ),
        )
      }
      // Optional VS Code launch — dev-workstation convenience. Silent
      // no-op if `code` isn't on PATH (headless VPS, non-VSCode users).
      // Spawn directly so we can swallow the NotFound exception instead
      // of letting it leak through exec()'s error path.
      try {
        await new Deno.Command('code', {
          args: [appDir],
          stdout: 'null',
          stderr: 'null',
        }).output()
      } catch { /* silent — non-critical */ }

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
      if (isRust) {
        console.log(
          colors.yellow(
            '⚠ Rust first-build note: `cargo build -r` on a Solana app typically\n' +
              '  takes 5–15 minutes on a modern VPS; on underpowered machines\n' +
              '  (< 4 GB RAM / 2 vCPU) it may run out of memory or appear to hang.\n' +
              '  If the build never finishes, consider upgrading your VPS plan\n' +
              '  (e.g. to core2 or larger) from https://dashboard.erpc.global.',
          ),
        )
      }
    } catch (error) {
      console.error(
        colors.red('❌ Failed to download or extract template:'),
        error,
      )
      // The live appDir is untouched — we only ever worked in stagingDir.
      // Clean up the staging dir (best-effort) and bail. If we already
      // persisted protected files to the rescue dir, leave them there as
      // a recovery trail.
      try {
        await exec(`rm -rf "${stagingDir}"`)
      } catch { /* non-fatal */ }
      if (rescueInfo) {
        console.log(
          colors.yellow(
            `🛡  Protected files remain at ${rescueInfo.rescueDir}`,
          ),
        )
      }
      return false
    }
    return true
  } catch (error) {
    console.error(colors.red('❌ Failed to initialize bot template:'), error)
    return false
  }
}
