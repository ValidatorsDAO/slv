import {
  VERSION_FIREDANCER_DEVNET,
  VERSION_FIREDANCER_MAINNET,
  VERSION_FIREDANCER_TESTNET,
  VERSION_GEYSER_YELLOWSTONE_DEVNET,
  VERSION_GEYSER_YELLOWSTONE_MAINNET,
  VERSION_GEYSER_YELLOWSTONE_TESTNNET,
  VERSION_JITO_BAM_MAINNET,
  VERSION_JITO_BAM_TESTNET,
  VERSION_JITO_DEVNET,
  VERSION_JITO_MAINNET,
  VERSION_JITO_TESTNET,
  VERSION_SOLANA_DEVNET,
  VERSION_SOLANA_MAINNET,
  VERSION_SOLANA_TESTNET,
} from '@cmn/constants/version.ts'
import { VERSIONS_PATH } from '@cmn/constants/path.ts'
import { stringify } from '@std/yaml'
import { genOrReadVersions } from '/lib/genOrReadVersions.ts'
import { colors } from '@cliffy/colors'

/**
 * Helper function to display version changes with visual indicators
 */
const displayVersionChange = (
  name: string,
  oldVersion: string,
  newVersion: string,
  indent = 2,
) => {
  const padding = ' '.repeat(indent)

  // Always show both versions for clarity
  if (oldVersion === newVersion) {
    // No change in version - show with equals sign
    console.log(
      `${padding}${colors.bold(name)}: ${colors.dim(oldVersion)} ${
        colors.blue('=')
      } ${colors.green(newVersion)}`,
    )
  } else {
    // Version has changed - show both with an arrow
    console.log(
      `${padding}${colors.bold(name)}: ${colors.dim(oldVersion)} ${
        colors.yellow('→')
      } ${colors.green.bold(newVersion)}`,
    )
  }
}

export const updateDefaultVersion = async () => {
  // Read current versions before updating
  const currentVersion = await genOrReadVersions()

  // Store current versions before updating
  const oldVersions = {
    mainnet_validators: {
      version_agave: currentVersion.mainnet_validators.version_agave,
      version_jito: currentVersion.mainnet_validators.version_jito,
      version_jito_bam: currentVersion.mainnet_validators.version_jito_bam,
      version_firedancer: currentVersion.mainnet_validators.version_firedancer,
    },
    testnet_validators: {
      version_agave: currentVersion.testnet_validators.version_agave,
      version_firedancer: currentVersion.testnet_validators.version_firedancer,
      version_jito: currentVersion.testnet_validators.version_jito,
      version_jito_bam: currentVersion.testnet_validators.version_jito_bam,
    },
    mainnet_rpcs: {
      version_agave: currentVersion.mainnet_rpcs.version_agave,
      version_jito: currentVersion.mainnet_rpcs.version_jito,
      version_firedancer: currentVersion.mainnet_rpcs.version_firedancer,
      geyser_version: currentVersion.mainnet_rpcs.geyser_version,
    },
    devnet_rpcs: {
      version_agave: currentVersion.devnet_rpcs.version_agave,
      version_jito: currentVersion.devnet_rpcs.version_jito,
      version_firedancer: currentVersion.devnet_rpcs.version_firedancer,
      geyser_version: currentVersion.devnet_rpcs.geyser_version,
    },
    testnet_rpcs: {
      version_agave: currentVersion.testnet_rpcs.version_agave,
      version_jito: currentVersion.testnet_rpcs.version_jito,
      version_firedancer: currentVersion.testnet_rpcs.version_firedancer,
      geyser_version: currentVersion.testnet_rpcs.geyser_version,
    },
  }

  // Update to new versions
  currentVersion.mainnet_validators.version_agave = VERSION_SOLANA_MAINNET
  currentVersion.mainnet_validators.version_jito = VERSION_JITO_MAINNET
  currentVersion.mainnet_validators.version_jito_bam = VERSION_JITO_BAM_MAINNET
  currentVersion.mainnet_validators.version_firedancer =
    VERSION_FIREDANCER_MAINNET
  currentVersion.testnet_validators.version_agave = VERSION_SOLANA_TESTNET
  currentVersion.testnet_validators.version_firedancer =
    VERSION_FIREDANCER_TESTNET
  currentVersion.testnet_validators.version_jito = VERSION_JITO_TESTNET
  currentVersion.testnet_validators.version_jito_bam = VERSION_JITO_BAM_TESTNET
  currentVersion.mainnet_rpcs.version_agave = VERSION_SOLANA_MAINNET
  currentVersion.mainnet_rpcs.version_jito = VERSION_JITO_MAINNET
  currentVersion.mainnet_rpcs.version_firedancer = VERSION_FIREDANCER_MAINNET
  currentVersion.mainnet_rpcs.geyser_version =
    VERSION_GEYSER_YELLOWSTONE_MAINNET
  currentVersion.devnet_rpcs.version_agave = VERSION_SOLANA_DEVNET
  currentVersion.devnet_rpcs.version_jito = VERSION_JITO_DEVNET
  currentVersion.devnet_rpcs.version_firedancer = VERSION_FIREDANCER_DEVNET
  currentVersion.devnet_rpcs.geyser_version = VERSION_GEYSER_YELLOWSTONE_DEVNET
  currentVersion.testnet_rpcs.version_agave = VERSION_SOLANA_TESTNET
  currentVersion.testnet_rpcs.version_jito = VERSION_JITO_TESTNET
  currentVersion.testnet_rpcs.version_firedancer = VERSION_FIREDANCER_TESTNET
  currentVersion.testnet_rpcs.geyser_version =
    VERSION_GEYSER_YELLOWSTONE_TESTNNET

  // Display versions with changes highlighted
  console.log('')
  console.log(
    colors.yellow.bold('┌─ Mainnet Validators ───────────────────────┐'),
  )
  displayVersionChange(
    'Agave',
    oldVersions.mainnet_validators.version_agave,
    currentVersion.mainnet_validators.version_agave,
  )
  displayVersionChange(
    'Jito',
    oldVersions.mainnet_validators.version_jito,
    currentVersion.mainnet_validators.version_jito,
  )
  displayVersionChange(
    'Jito-bam',
    oldVersions.mainnet_validators.version_jito_bam,
    currentVersion.mainnet_validators.version_jito_bam,
  )
  displayVersionChange(
    'Firedancer',
    oldVersions.mainnet_validators.version_firedancer,
    currentVersion.mainnet_validators.version_firedancer,
  )

  console.log('')
  console.log(
    colors.yellow.bold('┌─ Testnet Validators ───────────────────────┐'),
  )
  displayVersionChange(
    'Agave',
    oldVersions.testnet_validators.version_agave,
    currentVersion.testnet_validators.version_agave,
  )
  displayVersionChange(
    'Jito',
    oldVersions.testnet_validators.version_jito,
    currentVersion.testnet_validators.version_jito,
  )
  displayVersionChange(
    'Jito-bam',
    oldVersions.testnet_validators.version_jito_bam,
    currentVersion.testnet_validators.version_jito_bam,
  )
  displayVersionChange(
    'Firedancer',
    oldVersions.testnet_validators.version_firedancer,
    currentVersion.testnet_validators.version_firedancer,
  )

  console.log('')
  console.log(
    colors.yellow.bold('┌─ Mainnet RPCs ────────────────────────────┐'),
  )
  displayVersionChange(
    'Agave',
    oldVersions.mainnet_rpcs.version_agave,
    currentVersion.mainnet_rpcs.version_agave,
  )
  displayVersionChange(
    'Jito',
    oldVersions.mainnet_rpcs.version_jito,
    currentVersion.mainnet_rpcs.version_jito,
  )
  displayVersionChange(
    'Firedancer',
    oldVersions.mainnet_rpcs.version_firedancer,
    currentVersion.mainnet_rpcs.version_firedancer,
  )
  displayVersionChange(
    'Geyser',
    oldVersions.mainnet_rpcs.geyser_version,
    currentVersion.mainnet_rpcs.geyser_version,
  )
  console.log('')

  // Write the updated version to the file
  await Deno.writeTextFile(VERSIONS_PATH, stringify(currentVersion as any))
  console.log(colors.white('✔ Default versions updated'))
  return true
}
