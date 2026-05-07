import { Command } from '@cliffy'
import { Input, Select } from '@cliffy/prompt'
import { colors } from '@cliffy/colors'
import { exec, spawnSync } from '@elsoul/child-process'
import { join } from '@std/path'
import { parse } from '@std/yaml'
import { checkRpcEndpoint, sanitizeEndpointForDisplay } from '@/check/rpc.ts'
import { checkBoostForTargets, printTargetReport } from '/lib/checkBoost.ts'
import type { InventoryType } from '@cmn/types/config.ts'

const userBinDir = join(Deno.env.get('HOME') || '', '.slv', 'bin')
const slvDir = join(Deno.env.get('HOME') || '', '.slv')

const DEFAULT_BENCH_REGION = 'frankfurt'
const DEFAULT_TRANSACTIONS = 10000
const DEFAULT_ACCOUNT = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'
const DEFAULT_COMMITMENT = 'processed'
const DEFAULT_ERPC_URL = 'https://edge.erpc.global'

type ApiYml = {
  slv?: {
    api_key?: string
  }
}

async function readSlvApiKey(): Promise<string | null> {
  try {
    const raw = await Deno.readTextFile(join(slvDir, 'api.yml'))
    const yml = parse(raw) as ApiYml | null
    return yml?.slv?.api_key?.trim() || null
  } catch {
    return null
  }
}

function geyserKindFor(kind: string): string {
  switch (kind) {
    case 'grpc':
      return 'yellowstone'
    case 'shredstream':
      return 'shredstream'
    case 'rpc':
      return 'arpc'
    default:
      return kind
  }
}

async function ensureGeyserbenchConfig(options: {
  kind: string
  region: string
  endpoints: string[]
  transactions: number
}): Promise<string> {
  const apiKey = await readSlvApiKey()
  if (!apiKey) {
    throw new Error(
      'No SLV API key found in ~/.slv/api.yml. Get a free API key and configure it first.',
    )
  }

  const configDir = join(slvDir, 'check', 'geyserbench')
  await Deno.mkdir(configDir, { recursive: true })
  const configPath = join(configDir, 'config.toml')
  const endpointKind = geyserKindFor(options.kind)

  const configToml = [
    '[config]',
    `region = "${options.region}"`,
    `erpc_url = "${DEFAULT_ERPC_URL}"`,
    `erpc_api_key = "${apiKey}"`,
    `transactions = ${options.transactions}`,
    `account = "${DEFAULT_ACCOUNT}"`,
    `commitment = "${DEFAULT_COMMITMENT}"`,
    '',
    ...options.endpoints.flatMap((endpoint) => [
      '[[endpoint]]',
      `name = \"${endpoint}\"`,
      `url = \"${endpoint}\"`,
      `kind = \"${endpointKind}\"`,
      '',
    ]),
  ].join('\n')

  await Deno.writeTextFile(configPath, configToml)
  return configPath
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

function startSpinner(message: string): { stop: () => void } {
  let frameIndex = 0
  const startTime = Date.now()
  const encoder = new TextEncoder()

  const intervalId = setInterval(() => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000)
    const frame = SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length]
    const text = `\r${frame} ${message} ${elapsed}s`
    Deno.stdout.writeSync(encoder.encode(text))
    frameIndex++
  }, 80)

  return {
    stop() {
      clearInterval(intervalId)
      Deno.stdout.writeSync(encoder.encode('\r' + ' '.repeat(60) + '\r'))
    },
  }
}

async function runGeyserbenchCommand(commandArgs: string[]): Promise<void> {
  const spinner = startSpinner('Running geyserbench...')

  try {
    const proc = new Deno.Command(commandArgs[0], {
      args: commandArgs.slice(1),
      stdout: 'piped',
      stderr: 'piped',
    })
    const { code, stdout, stderr } = await proc.output()

    spinner.stop()

    const stdoutText = new TextDecoder().decode(stdout)
    const stderrText = new TextDecoder().decode(stderr)

    if (stdoutText.trim()) {
      console.log(stdoutText.trimEnd())
    }
    if (stderrText.trim()) {
      console.error(stderrText)
    }

    if (code !== 0) {
      throw new Error(`geyserbench exited with code ${code}`)
    }
  } catch (error) {
    spinner.stop()
    throw error
  }
}

export const checkCmd = new Command()
  .description('Check RPC, gRPC, Shreds, and benchmark endpoints')
  .action(() => {
    checkCmd.showHelp()
  })

checkCmd.command('rpc')
  .description('Check RPC endpoint')
  .option('--url <url:string>', 'RPC endpoint URL')
  .option(
    '--endpoint <endpoint:string>',
    'RPC endpoint URL (deprecated, use --url)',
  )
  .option('--timeout <timeout:number>', 'Timeout in milliseconds', {
    default: 10000,
  })
  .action(async (options) => {
    let endpoint = options.url || options.endpoint
    if (!endpoint) {
      endpoint = await Input.prompt({
        message: 'Enter RPC endpoint URL:',
        default: 'https://api.mainnet-beta.solana.com',
      })
    }

    const displayEndpoint = sanitizeEndpointForDisplay(endpoint)
    console.log(colors.blue(`Checking RPC endpoint: ${displayEndpoint}`))

    try {
      const result = await checkRpcEndpoint(
        endpoint,
        Number(options.timeout || 10000),
      )
      if (result.details?.length) {
        for (const detail of result.details) {
          console.log(colors.gray(detail))
        }
      }

      if (result.ok) {
        console.log(colors.green(result.summary))
        console.log(colors.green('✅ working'))
        return
      }

      console.error(colors.red(result.summary))
      console.error(colors.red('❌ not working'))
      Deno.exitCode = 1
    } catch (error: unknown) {
      const errorMessage = error instanceof Error
        ? error.message
        : String(error)
      console.error(colors.red(errorMessage))
      console.error(colors.red('❌ not working'))
      Deno.exitCode = 1
    }
  })

checkCmd.command('grpc')
  .description('Check gRPC endpoint')
  .option('--endpoint <endpoint:string>', 'gRPC endpoint URL')
  .option('--token <token:string>', 'Token for authentication')
  .action(async (options) => {
    let endpoint = options.endpoint
    let token = options.token
    if (!endpoint) {
      endpoint = await Input.prompt({ message: 'Enter gRPC endpoint URL:' })
    }
    if (!token) {
      token = await Input.prompt({ message: 'Enter Token for authentication:' })
    }

    console.log(colors.blue(`Checking gRPC endpoint: ${endpoint}`))

    try {
      const grpcTestPath = join(userBinDir, 'grpc_test')
      const command = `env TOKEN=${token} ENDPOINT=${endpoint} ${grpcTestPath}`
      await spawnSync(command)
    } catch (error: unknown) {
      const errorMessage = error instanceof Error
        ? error.message
        : String(error)
      console.error(colors.red('Error executing gRPC test:'), errorMessage)
    }
  })

checkCmd.command('shreds')
  .description('Check Shreds endpoint')
  .option('--endpoint <endpoint:string>', 'Shreds endpoint URL')
  .action(async (options) => {
    let endpoint = options.endpoint
    if (!endpoint) {
      endpoint = await Input.prompt({ message: 'Enter Shreds endpoint URL:' })
    }

    console.log(colors.blue(`Checking Shreds endpoint: ${endpoint}`))

    try {
      const shredsTestPath = join(userBinDir, 'shreds_test')
      const command = `${shredsTestPath} ${endpoint}`
      await spawnSync(command)
    } catch (error: unknown) {
      const errorMessage = error instanceof Error
        ? error.message
        : String(error)
      console.error(colors.red('Error executing Shreds test:'), errorMessage)
    }
  })

checkCmd.command('geyserbench')
  .description('Run geyserbench with generated config')
  .option('--kind <kind:string>', 'Benchmark kind: shredstream | grpc | rpc')
  .option(
    '--region <region:string>',
    'Benchmark region for region-aware measurement',
  )
  .option('--endpoint <endpoint:string>', 'Endpoint URL to compare', {
    collect: true,
  })
  .option('--transactions <transactions:number>', 'Transaction sample size', {
    default: DEFAULT_TRANSACTIONS,
  })
  .action(async (options) => {
    let kind = options.kind
    let region = options.region
    const endpoints = Array.isArray(options.endpoint)
      ? [...options.endpoint]
      : options.endpoint
      ? [options.endpoint]
      : []
    const transactions = Number(options.transactions || DEFAULT_TRANSACTIONS)

    if (!kind) {
      kind = await Input.prompt({
        message: 'Benchmark kind (shredstream / grpc / rpc):',
        default: 'shredstream',
      })
    }
    if (!region) {
      region = await Input.prompt({
        message: 'Region (--region) for accurate measurement:',
        default: DEFAULT_BENCH_REGION,
      })
    }
    while (endpoints.length < 2) {
      const label = endpoints.length === 0
        ? 'First endpoint URL:'
        : 'Next endpoint URL:'
      endpoints.push(await Input.prompt({ message: label }))
    }

    const geyserbenchPath = join(userBinDir, 'geyserbench')
    try {
      await Deno.stat(geyserbenchPath)
    } catch {
      console.error(
        colors.red('geyserbench is not installed. Run slv install first.'),
      )
      return
    }

    try {
      const configPath = await ensureGeyserbenchConfig({
        kind: String(kind).trim(),
        region: String(region).trim(),
        endpoints: endpoints.map((endpoint) => String(endpoint).trim()).filter(
          Boolean,
        ),
        transactions,
      })

      const normalizedKind = String(kind).trim().toLowerCase()
      const normalizedRegion = String(region).trim()
      if (!normalizedRegion) {
        throw new Error(
          'Region is required for accurate benchmark measurement.',
        )
      }
      console.log(
        colors.blue(
          `Running geyserbench (${normalizedKind}) in region ${normalizedRegion}`,
        ),
      )
      console.log(colors.gray(`Config: ${configPath}`))
      await runGeyserbenchCommand([
        geyserbenchPath,
        '--config',
        configPath,
        '--region',
        normalizedRegion,
      ])
    } catch (error: unknown) {
      const errorMessage = error instanceof Error
        ? error.message
        : String(error)
      console.error(colors.red('Error executing geyserbench:'), errorMessage)
      if (errorMessage.includes('No SLV API key found')) {
        console.log(
          colors.yellow(
            'Get a free API key and configure ~/.slv/api.yml, then run this command again.',
          ),
        )
      }
    }
  })

checkCmd.command('boost')
  .description(
    '🚀 Verify CPU performance boost on a deployed validator/RPC node',
  )
  .option(
    '-n, --network <network:string>',
    'Solana network (mainnet/testnet/devnet)',
  )
  .option(
    '-t, --type <type:string>',
    'Node type (validator/rpc)',
  )
  .option(
    '-p, --pubkey <pubkey:string>',
    'Inventory key (identity_account / name) — leave empty to check all',
  )
  .action(async (options) => {
    let network = options.network
    let type = options.type

    if (!type) {
      type = await Select.prompt({
        message: 'Node type to check',
        options: [
          { name: 'Validator', value: 'validator' },
          { name: 'RPC', value: 'rpc' },
        ],
        default: 'validator',
      })
    }
    if (!network) {
      const networkOptions = type === 'rpc'
        ? ['mainnet', 'testnet', 'devnet']
        : ['mainnet', 'testnet']
      network = await Select.prompt({
        message: 'Solana network',
        options: networkOptions,
        default: 'mainnet',
      })
    }
    if (type === 'validator' && !['mainnet', 'testnet'].includes(network)) {
      console.error(
        colors.red(
          `❌ Validator boost-check is only available on mainnet/testnet (got "${network}").`,
        ),
      )
      Deno.exitCode = 1
      return
    }

    const inventoryType =
      (type === 'rpc' ? `${network}_rpcs` : `${network}_validators`) as InventoryType

    console.log(
      colors.blue(
        `🔎 Running CPU boost diagnostics on ${type} ${
          options.pubkey ?? '(all)'
        } (${network})...`,
      ),
    )
    try {
      const results = await checkBoostForTargets(
        inventoryType,
        options.pubkey,
      )
      if (results.length === 0) {
        console.log(
          colors.yellow(
            '⚠️  No hosts matched. Check your inventory and --pubkey.',
          ),
        )
        Deno.exitCode = 1
        return
      }
      let worst: 'OK' | 'WARN' | 'NG' = 'OK'
      for (const r of results) {
        printTargetReport(r)
        if (r.overallStatus === 'NG') worst = 'NG'
        else if (r.overallStatus === 'WARN' && worst === 'OK') worst = 'WARN'
      }
      console.log()
      if (worst === 'OK') {
        console.log(
          colors.green(
            '🎉 All green! Boost is fully active and the node is ready for prime time.',
          ),
        )
      } else if (worst === 'WARN') {
        console.log(
          colors.yellow(
            '🟡 Boost is partially active. See per-check details above.',
          ),
        )
        Deno.exitCode = 1
      } else {
        console.log(
          colors.red(
            '🔴 Boost is not active. See per-check details above.',
          ),
        )
        Deno.exitCode = 2
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      console.error(colors.red(`❌ Boost check failed: ${msg}`))
      Deno.exitCode = 1
    }
  })

checkCmd.command('ip')
  .description('IP - 📡 Get Local')
  .action(async () => {
    try {
      const cmd = `curl ipinfo.io/ip`
      const ip = await exec(cmd)
      console.log(colors.white(`${ip.message.trim()}`))
    } catch (error: unknown) {
      const errorMessage = error instanceof Error
        ? error.message
        : String(error)
      console.error(colors.red('Error fetching IP address:'), errorMessage)
    }
  })
