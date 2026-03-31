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

/**
 * Initialize a new Solana trade bot application by downloading the template
 * directly from the GitHub repository (temp-release/).
 * @param options Options for initializing the bot
 * @returns Promise<boolean> indicating success or failure
 */

export const initBotTemplate = async (options: { queue: boolean }) => {
  try {
    // Create a directory for the bot if it doesn't exist
    const botConfigDir = join(configRoot, 'bot')
    try {
      await Deno.stat(botConfigDir)
    } catch (_error) {
      await Deno.mkdir(botConfigDir, { recursive: true })
    }

    // Select template type
    const { templateType } = await prompt([
      {
        name: 'templateType',
        message: 'Select Bot Template Type',
        type: Select,
        options: BotTempTypeArray,
      },
    ])

    if (!templateType) {
      console.log(colors.yellow('⚠️ No template type selected'))
      return false
    }

    // Create a directory for the new bot application
    const { appName } = await prompt([
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
    try {
      await Deno.stat(appDir)
      console.log(colors.yellow(`⚠️ Directory ${appDir} already exists`))
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
    } catch (_error) {
      // Directory doesn't exist, which is fine
    }

    // Remove existing directory if overwriting
    if (shouldOverwrite) {
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
      const dlResult = await exec(
        `curl -fsSL "${BOT_TEMP_ARCHIVE_URL}" | tar -xz -C "${appDir}" --strip-components=3 "${tarFilter}"`,
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

      const isRust = templateType.includes('rust')
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
        ? `$ cargo build\n$ cargo run`
        : `$ pnpm install\n$ pnpm dev`
      console.log(
        colors.white(`
To get started with your new application, run the following commands:
  
$ cd ${appName}
${msg}
  `),
      )
    } catch (error) {
      console.error(
        colors.red('❌ Failed to download or extract template:'),
        error,
      )
      return false
    }
    return true
  } catch (error) {
    console.error(colors.red('❌ Failed to initialize bot template:'), error)
    return false
  }
}
