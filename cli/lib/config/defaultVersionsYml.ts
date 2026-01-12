import type { CmnType } from '@cmn/types/config.ts'
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
  VERSION_RICHAT,
  VERSION_SOLANA_DEVNET,
  VERSION_SOLANA_MAINNET,
  VERSION_SOLANA_TESTNET,
} from '@cmn/constants/version.ts'

const defaultVersionsYml = (): string => {
  const defaultVersions: CmnType = {
    mainnet_validators: {
      version_agave: VERSION_SOLANA_MAINNET,
      version_jito: VERSION_JITO_MAINNET,
      version_jito_bam: VERSION_JITO_BAM_MAINNET,
      version_firedancer: VERSION_FIREDANCER_MAINNET,
      allowed_ssh_ips: [],
      allowed_ips: [],
    },
    testnet_validators: {
      version_agave: VERSION_SOLANA_TESTNET,
      version_jito: VERSION_JITO_TESTNET,
      version_jito_bam: VERSION_JITO_BAM_TESTNET,
      version_firedancer: VERSION_FIREDANCER_TESTNET,
      allowed_ssh_ips: [],
      allowed_ips: [],
    },
    mainnet_rpcs: {
      version_agave: VERSION_SOLANA_MAINNET,
      version_jito: VERSION_JITO_MAINNET,
      version_firedancer: VERSION_FIREDANCER_MAINNET,
      richat_version: VERSION_RICHAT,
      geyser_version: VERSION_GEYSER_YELLOWSTONE_MAINNET,
      allowed_ssh_ips: [],
      allowed_ips: [],
    },
    devnet_rpcs: {
      version_agave: VERSION_SOLANA_DEVNET,
      version_jito: VERSION_JITO_DEVNET,
      version_firedancer: VERSION_FIREDANCER_DEVNET,
      richat_version: VERSION_RICHAT,
      geyser_version: VERSION_GEYSER_YELLOWSTONE_DEVNET,
      allowed_ssh_ips: [],
      allowed_ips: [],
    },
    testnet_rpcs: {
      version_agave: VERSION_SOLANA_TESTNET,
      version_jito: VERSION_JITO_TESTNET,
      version_firedancer: VERSION_FIREDANCER_TESTNET,
      richat_version: VERSION_RICHAT,
      geyser_version: VERSION_GEYSER_YELLOWSTONE_TESTNNET,
      allowed_ssh_ips: [],
      allowed_ips: [],
    },
  }

  return `mainnet_validators:
  version_agave: ${defaultVersions.mainnet_validators.version_agave}
  version_jito: ${defaultVersions.mainnet_validators.version_jito}
  version_jito_bam: ${defaultVersions.mainnet_validators.version_jito_bam}
  version_firedancer: ${defaultVersions.mainnet_validators.version_firedancer}
  allowed_ssh_ips: ${defaultVersions.mainnet_validators.allowed_ssh_ips}
  allowed_ips: ${defaultVersions.mainnet_validators.allowed_ips}

testnet_validators:
  version_agave: ${defaultVersions.testnet_validators.version_agave}
  version_jito: ${defaultVersions.testnet_validators.version_jito}
  version_jito_bam: ${defaultVersions.testnet_validators.version_jito_bam}
  version_firedancer: ${defaultVersions.testnet_validators.version_firedancer}
  allowed_ssh_ips: ${defaultVersions.testnet_validators.allowed_ssh_ips}
  allowed_ips: ${defaultVersions.testnet_validators.allowed_ips}

mainnet_rpcs:
  version_agave: ${defaultVersions.mainnet_rpcs.version_agave}
  version_jito: ${defaultVersions.mainnet_rpcs.version_jito}
  version_firedancer: ${defaultVersions.mainnet_rpcs.version_firedancer}
  richat_version: ${defaultVersions.mainnet_rpcs.richat_version}
  geyser_version: ${defaultVersions.mainnet_rpcs.geyser_version}
  allowed_ssh_ips: ${defaultVersions.mainnet_rpcs.allowed_ssh_ips}
  allowed_ips: ${defaultVersions.mainnet_rpcs.allowed_ips}

devnet_rpcs:
  version_agave: ${defaultVersions.devnet_rpcs.version_agave}
  version_jito: ${defaultVersions.devnet_rpcs.version_jito}
  version_firedancer: ${defaultVersions.devnet_rpcs.version_firedancer}
  richat_version: ${defaultVersions.devnet_rpcs.richat_version}
  geyser_version: ${defaultVersions.devnet_rpcs.geyser_version}
  allowed_ssh_ips: ${defaultVersions.devnet_rpcs.allowed_ssh_ips}
  allowed_ips: ${defaultVersions.devnet_rpcs.allowed_ips}

testnet_rpcs:
  version_agave: ${defaultVersions.testnet_rpcs.version_agave}
  version_jito: ${defaultVersions.testnet_rpcs.version_jito}
  version_firedancer: ${defaultVersions.testnet_rpcs.version_firedancer}
  richat_version: ${defaultVersions.testnet_rpcs.richat_version}
  geyser_version: ${defaultVersions.testnet_rpcs.geyser_version}
  allowed_ssh_ips: ${defaultVersions.testnet_rpcs.allowed_ssh_ips}
  allowed_ips: ${defaultVersions.testnet_rpcs.allowed_ips}
`
}

export { defaultVersionsYml }
