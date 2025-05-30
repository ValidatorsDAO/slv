import { exec, spawnSync } from '@elsoul/child-process'
import { configRoot } from '@cmn/constants/path.ts'
import { colors } from '@cliffy/colors'
import { join } from '@std/path'
import { Input, prompt, Select } from '@cliffy/prompt'
import { BotTempDLinkMap, BotTempTypeArray } from '@cmn/zod/bot.ts'

/**
 * Initialize a new Solana trade bot application by downloading the template
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

    const downloadUrl =
      BotTempDLinkMap[templateType as keyof typeof BotTempDLinkMap]

    if (!downloadUrl) {
      console.error(
        colors.red(
          `❌ No download URL found for template type: ${templateType}`,
        ),
      )
      return false
    }

    console.log(colors.gray(`Download URL: ${downloadUrl}`))

    // Create a temporary file for the download
    const tempFile = join(appDir, 'template.tar.gz')

    try {
      // Download the template archive
      console.log(colors.blue('📥 Downloading template archive...'))
      const downloadResult = await exec(
        `wget -q --show-progress "${downloadUrl}" -O "${tempFile}"`,
      )

      if (!downloadResult.success) {
        throw new Error(
          `Download failed: ${downloadResult.message || 'Unknown error'}`,
        )
      }

      // Verify the download
      const fileInfo = await Deno.stat(tempFile)
      if (fileInfo.size === 0) {
        throw new Error('Downloaded file is empty')
      }

      console.log(
        colors.green(
          `✅ Download completed (${Math.round(fileInfo.size / 1024)}KB)`,
        ),
      )

      // Extract the archive
      console.log(colors.blue('📤 Extracting template...'))
      await spawnSync(
        `tar -xzf "${tempFile}" -C "${appDir}" --strip-components=1`,
      )
      // Remove the temporary file after extraction
      await Deno.remove(tempFile)
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
      console.log(colors.white(`
To get started with your new application, run the following commands:
  
$ cd ${appName}
${msg}
  `))
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
