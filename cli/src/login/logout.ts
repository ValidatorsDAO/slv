import { Command } from '@cliffy'
import { colors } from '@cliffy/colors'
import { resolveHome } from '/lib/getApiKeyFromYml.ts'
import { parse, stringify } from '@std/yaml'

export const logoutCmd = new Command()
  .description('Logout from SLV')
  .action(async () => {
    const loginTxt = `⚡️ SLV Logout to remove API Key ⚡️\n`
    console.log(colors.bold.blue(loginTxt))
    const home = resolveHome()
    const configDir = home + '/.slv'
    const inventoryPath = configDir + '/api.yml'
    await Deno.mkdir(configDir, { recursive: true })

    // Read existing config to preserve other sections (e.g. ai)
    let existing: Record<string, unknown> = {}
    try {
      const content = await Deno.readTextFile(inventoryPath)
      existing = (parse(content) as Record<string, unknown>) ?? {}
    } catch {
      // File doesn't exist or is invalid — start fresh
    }
    existing.slv = { api_key: null }
    await Deno.writeTextFile(inventoryPath, stringify(existing))
    await Deno.chmod(inventoryPath, 0o600)

    console.log(
      colors.green('\n✔️ API Key Successfully Removed from ~/.slv/api.yml\n'),
    )
    console.log(colors.white(`🚀 You have been logged out\n`))
  })
