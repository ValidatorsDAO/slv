import { Confirm, Input, prompt, Select } from '@cliffy/prompt'
import { colors } from '@cliffy/colors'
import { stringify } from 'https://deno.land/std@0.202.0/yaml/stringify.ts'
import { VERSIONS_PATH } from '@cmn/constants/path.ts'
import { genOrReadVersions } from '/lib/genOrReadVersions.ts'

/**
 * Type for the section to update in versions.yml
 * Only includes sections that have allowed_ssh_ips
 */
export type VersionSection =
  | 'mainnet_validators'
  | 'testnet_validators'
  | 'mainnet_rpcs'
  | 'devnet_rpcs'
  | 'testnet_rpcs'

/**
 * Updates the allowed SSH IPs in versions.yml
 * This function handles both prompting for IPs and updating the file
 * @param section The section to update (defaults to 'mainnet_validators')
 */
export const updateAllowedSshIps = async (
  section: VersionSection = 'mainnet_validators',
): Promise<boolean> => {
  console.log(colors.blue(`🔒 Updating Allowed SSH IPs for ${section}`))

  try {
    // Read current versions
    const versionsData = await genOrReadVersions()

    // Get current IPs to show as defaults
    // Handle case where allowed_ssh_ips might not be an array or might be undefined
    const currentIps = Array.isArray(versionsData[section].allowed_ssh_ips)
      ? [...versionsData[section].allowed_ssh_ips].filter((ip) =>
        ip && ip.trim() !== ''
      )
      : []

    // Show current IPs if any exist
    if (currentIps.length > 0) {
      console.log('')
      console.log(colors.white.bold('Current Allowed SSH IPs:'))
      currentIps.forEach((ip) => {
        console.log(`  - ${colors.dim(ip)}`)
      })
      console.log('')
    }

    // Ask if user wants to keep current IPs
    let ips: string[] = []

    if (currentIps.length > 0) {
      const { action } = await prompt([{
        name: 'action',
        message: 'What would you like to do with the current IPs?',
        type: Select,
        options: [
          { name: 'Keep and add more', value: 'add' },
          { name: 'Replace all', value: 'replace' },
          { name: 'Keep as is', value: 'keep' },
        ],
      }])

      if (action === 'keep') {
        console.log(colors.green('✔ Keeping current IPs'))
        return true
      } else if (action === 'add') {
        ips = [...currentIps]
      }
    }

    // Prompt for IPs
    const { addIps } = await prompt([{
      name: 'addIps',
      message: 'Enter IP addresses (comma-separated):',
      type: Input,
      hint: 'e.g. 192.168.1.1, 10.0.0.1',
    }])

    if (addIps && addIps.trim() !== '') {
      // Parse and validate IPs
      const newIps = addIps.split(',')
        .map((ip) => ip.trim())
        .filter((ip) => ip !== '')

      // Basic IP validation
      const ipRegex = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/
      const validIps: string[] = []
      const invalidIps: string[] = []

      newIps.forEach((ip) => {
        if (ipRegex.test(ip)) {
          // Check if IP already exists in the list
          if (!ips.includes(ip)) {
            validIps.push(ip)
          }
        } else {
          invalidIps.push(ip)
        }
      })

      // Add valid IPs to the list
      ips = [...ips, ...validIps]

      // Show results
      if (validIps.length > 0) {
        console.log('')
        console.log(colors.green.bold(`✔ Added ${validIps.length} IP(s):`))
        validIps.forEach((ip) => console.log(`  - ${colors.green(ip)}`))
      }

      if (invalidIps.length > 0) {
        console.log('')
        console.log(
          colors.yellow.bold(`⚠️ Skipped ${invalidIps.length} invalid IP(s):`),
        )
        invalidIps.forEach((ip) => console.log(`  - ${colors.yellow(ip)}`))
      }
    }

    // If no IPs were added or kept
    if (ips.length === 0) {
      console.log('')
      console.log(colors.yellow('⚠️ No IPs were specified.'))
      const { proceed } = await prompt([{
        name: 'proceed',
        message: 'Do you want to continue with an empty IP list?',
        type: Confirm,
      }])

      if (!proceed) {
        console.log(
          colors.yellow('⚠️ Operation cancelled. No changes were made.'),
        )
        return false
      }
    } else {
      // Show final list and confirm
      console.log('')
      console.log(colors.white.bold('Final Allowed SSH IPs:'))
      ips.forEach((ip) => console.log(`  - ${colors.green(ip)}`))
      console.log('')

      const { confirm } = await prompt([{
        name: 'confirm',
        message: 'Update versions.yml with these IPs?',
        type: Confirm,
      }])

      if (!confirm) {
        console.log(
          colors.yellow('⚠️ Operation cancelled. No changes were made.'),
        )
        return false
      }
    }

    // Update allowed_ssh_ips for the specified section
    // Ensure empty arrays are properly formatted in YAML
    const ipsList = ips.length === 0 ? [''] : ips
    versionsData[section].allowed_ssh_ips = ipsList

    // Write the updated version to the file
    await Deno.writeTextFile(
      VERSIONS_PATH,
      stringify(versionsData as any, {
        noRefs: true, // Prevent YAML anchors and aliases
      }),
    )

    console.log('')
    console.log(
      colors.green.bold(
        `✅ Allowed SSH IPs for ${section} updated successfully`,
      ),
    )

    return true
  } catch (error) {
    console.error(
      colors.red(
        `Error updating allowed SSH IPs: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    )
    return false
  }
}
