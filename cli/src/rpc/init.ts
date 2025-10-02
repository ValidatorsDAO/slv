import { Input, Number, prompt, Select } from '@cliffy/prompt'
import { RPC_TYPE } from '@cmn/constants/rpc.ts'
import { colors } from '@cliffy/colors'
import type { CmnType, RpcConfig, RpcType } from '@cmn/types/config.ts'
import { genPasswordYml } from '/lib/genPasswordYml.ts'
import { genIdentityKey } from '/src/validator/init/genIdentityKey.ts'
import { checkSSHConnection } from '@cmn/prompt/checkSSHConnection.ts'
import { getInventoryPath } from '@cmn/constants/path.ts'
import type { CmnMainnetRpcType } from '@cmn/types/config.ts'
import {
  JITO_BLOCK_ENGINE_REGIONS,
  SHREDSTREAM_ADDRESS,
  SolanaNodeTypes,
} from '@cmn/constants/config.ts'
import { genOrReadVersions } from '/lib/genOrReadVersions.ts'
import { updateVersionsYml } from '/lib/config/updateVersionsYml.ts'
import { updateAllowedSshIps } from '/lib/config/updateAllowedSshIps.ts'
import { updateAllowedIps } from '/lib/config/updateAllowedIps.ts'
import { genSolvUser } from '/src/validator/init/genSolvUser.ts'
import { addMainnetRPCInventory } from '/lib/addMainnetRPCInventory.ts'
import { updateMainnetRPCInventory } from '/lib/updateMainnetRPCInventory.ts'
import { listAction } from '/src/metal/list/listAction.ts'
import { configRoot } from '@cmn/constants/path.ts'
import denoJson from '/deno.json' with { type: 'json' }
import { copy } from '@std/fs'
import { join } from '@std/path'

async function copyTemplateDirs() {
  const templateBase = join(configRoot, 'template', denoJson.version, 'jinja')
  const pairs = [
    ['mainnet-rpc', 'mainnet-rpc'],
    ['mainnet-validator', 'mainnet-validator'],
  ] as const

  await Promise.all(
    pairs.map(([srcName, destName]) =>
      copy(
        join(templateBase, srcName),
        join(configRoot, destName),
        { overwrite: true }, // 上書き許可（元コードのcp -r相当の期待値）
      )
    ),
  )
}

const init = async () => {
  await copyTemplateDirs()
  const currentVersion = await genOrReadVersions()
  const hasBareMetal = await prompt([{
    name: 'bareMetal',
    message: '🛡️ Do you have a Solana Node Compatabile Server?',
    type: Select,
    options: ['yes', 'no'],
    default: 'no',
  }])
  if (hasBareMetal.bareMetal === 'no') {
    console.log(
      colors.red(
        '⚠️ You need a Solana Node Compatabile High Performance Server to Run a RPC Node',
      ),
    )
    console.log(colors.green('🟢 You can get one from the following list:'))
    await listAction('RPC')
    return
  }
  const result = await checkSSHConnection()
  if (!result) {
    console.error(colors.red('❌ SSH connection failed'))
    return
  }

  // Set solv password
  await genPasswordYml()
  const identity_account = await genIdentityKey()
  const rpcTypes = await prompt([
    {
      name: 'validatorType',
      message: 'Select Solana CLI',
      type: Select,
      options: SolanaNodeTypes,
      default: 'jito',
    },
    {
      name: 'rpc_type',
      message: 'Select an RPC type',
      type: Select,
      options: RPC_TYPE,
      after: async ({ rpc_type }, next) => {
        if (rpc_type === 'Geyser gRPC') {
          await next()
        }
      },
    },
  ])

  const rpcConfig: RpcConfig = {
    ansible_host: result.ip,
    ansible_user: result.username,
    ansible_ssh_private_key_file: result.rsa_key_path,
    identity_account: identity_account,
    name: identity_account,
    rpc_type: rpcTypes.rpc_type as RpcType,
    region: rpcTypes.blockEngineRegion!,
    snapshot_url: '',
    limit_ledger_size: 200000000,
    shredstream_address: SHREDSTREAM_ADDRESS[
      rpcTypes.blockEngineRegion as keyof typeof SHREDSTREAM_ADDRESS
    ],
  }

  const rpcCmnConfig: Partial<CmnMainnetRpcType> = {
    port_rpc: rpcTypes.port_rpc!,
    port_grpc: rpcTypes.port_grpc!,
    x_token: rpcTypes.x_token!,
  }

  // Update ~/.slv/versions.yml
  const versions = await genOrReadVersions()
  const body: Partial<CmnType> = {
    ...versions,
    mainnet_rpcs: {
      ...versions.mainnet_rpcs,
      ...rpcCmnConfig,
    },
  }
  await updateVersionsYml(body)
  const inventoryCheck = await addMainnetRPCInventory(
    identity_account,
    result,
    rpcTypes.rpc_type as RpcType,
    rpcTypes.blockEngineRegion!,
    '',
  )
  if (!inventoryCheck) {
    console.log(colors.yellow('⚠️ Inventory check failed'))
    return
  }
  colors.green('✔︎ RPC configuration completed')
  const rpcs: RpcConfig[] = []
  rpcs.push(rpcConfig)
  await updateAllowedSshIps('mainnet_rpcs')
  await updateAllowedIps('mainnet_rpcs')
  await updateMainnetRPCInventory(
    identity_account,
    rpcConfig,
  )
  await genSolvUser(identity_account, 'mainnet_rpcs')
  const yamlPath = getInventoryPath('mainnet_rpcs')

  console.log(
    `✔︎ ${colors.green('mainnet_rpcs')} inventory file has been saved to ${
      colors.green(
        yamlPath,
      )
    }`,
  )
  console.log(colors.white(`Now you can deploy with:

$ slv rpc deploy -n mainnet -p ${identity_account}    
`))
  return rpcConfig
}

export { init }
