import type { CmnType } from '@cmn/types/config.ts'
import { stringify } from '@std/yaml'
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

const defaultVersionsObject = (): CmnType => ({
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
})

const defaultVersionsYml = (): string => {
  return stringify(defaultVersionsObject(), {
    indent: 2,
    lineWidth: -1,
    useAnchors: false,
    compatMode: false,
  })
}

export { defaultVersionsYml, defaultVersionsObject }
