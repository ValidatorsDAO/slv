import { colors } from '@cliffy/colors'
import { Row, Table } from '@cliffy/table'
import { genOrReadInventory } from '/lib/genOrReadInventory.ts'
import type { NetworkType } from '@cmn/types/config.ts'
import { genOrReadVersions } from '/lib/genOrReadVersions.ts'

const listValidators = async (network: NetworkType, pubkey?: string) => {
  const inventoryType = network === 'mainnet'
    ? 'mainnet_validators'
    : 'testnet_validators'
  const inventory = await genOrReadInventory(inventoryType)
  const header = [
    'Identity Key',
    'Vote Key',
    'Authority Key',
    'IP',
    'Validator Type',
    'Version',
  ]
  let validators = [] as any
  const version = await genOrReadVersions()
  let validatorVersion = ''
  if (network === 'mainnet') {
    console.log(colors.white('Your Mainnet Validators Settings:'))
    if (!inventory.mainnet_validators || !inventory.mainnet_validators.hosts) {
      console.log(colors.yellow('⚠️ No validators found\n\n $ slv v init'))
      return
    }
    validators = Object.values(inventory.mainnet_validators.hosts)
    if (!validators) {
      console.log(colors.yellow('⚠️ No validators found\n\n $ slv v init'))
      return
    }
    if (pubkey) {
      const validator = inventory.mainnet_validators.hosts[pubkey]
      if (!validator) {
        console.log(colors.yellow('⚠️ Validator not found'))
        return
      }
      validators = [validator]
    }
  } else {
    console.log(colors.white('Your Testnet Validators Settings:'))
    if (!inventory.testnet_validators || !inventory.testnet_validators.hosts) {
      console.log(colors.yellow('⚠️ No validators found\n\n $ slv v init'))
      return
    }
    validators = Object.values(inventory.testnet_validators.hosts)
    if (!validators) {
      console.log(colors.yellow('⚠️ No validators found\n\n $ slv v init'))
      return
    }
    if (pubkey) {
      const validator = inventory.testnet_validators.hosts[pubkey]
      if (!validator) {
        console.log(colors.yellow('⚠️ Validator not found'))
        return
      }
      validators = [validator]
    }
    validatorVersion = version.testnet_validators.version_firedancer
  }
  for (const validator of validators) {
    if (network === 'mainnet') {
      if (validator.validator_type.includes('firedancer')) {
        validatorVersion = version.mainnet_validators.version_firedancer
      } else if (validator.validator_type === 'jito-bam') {
        validatorVersion = version.mainnet_validators.version_jito_bam ||
          version.mainnet_validators.version_jito
      } else if (validator.validator_type.includes('jito')) {
        validatorVersion = version.mainnet_validators.version_jito
      } else {
        validatorVersion = version.mainnet_validators.version_agave
      }
    } else {
      if (validator.validator_type === 'agave') {
        validatorVersion = version.testnet_validators.version_agave
      } else if (validator.validator_type === 'jito-bam') {
        validatorVersion = version.testnet_validators.version_jito_bam ||
          version.testnet_validators.version_jito
      } else if (validator.validator_type === 'jito') {
        validatorVersion = version.testnet_validators.version_jito
      } else {
        validatorVersion = version.testnet_validators.version_firedancer
      }
    }
    const table = new Table()
    table
      .body([
        new Row(
          colors.blue(header[0]),
          colors.white(validator.identity_account),
        )
          .border(
            true,
          ),
        new Row(
          colors.blue(header[1]),
          colors.white(validator.vote_account),
        )
          .border(true),
        new Row(
          colors.blue(header[2]),
          colors.white(validator.authority_account),
        )
          .border(true),
        new Row(
          colors.blue(header[3]),
          colors.white(validator.ansible_host),
        )
          .border(true),
        new Row(
          colors.blue(header[4]),
          colors.white(validator.validator_type),
        )
          .border(true),
        new Row(
          colors.blue(header[5]),
          colors.white(validatorVersion),
        ).border(
          true,
        ),
      ])
    table.render()
  }
}

export { listValidators }
