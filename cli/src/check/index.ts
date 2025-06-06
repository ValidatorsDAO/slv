import { Command } from '@cliffy'
import { Input } from '@cliffy/prompt'
import { colors } from '@cliffy/colors'
import { exec, spawnSync } from '@elsoul/child-process'
import { join } from '@std/path'

// Define the path for the scripts
const userBinDir = join(Deno.env.get('HOME') || '', '.slv', 'bin')

// check Command
export const checkCmd = new Command()
  .description('Check RPC and gRPC endpoints')
  .action(() => {
    checkCmd.showHelp()
  })

// RPC check subcommand
checkCmd.command('rpc')
  .description('Check RPC endpoint')
  .option('--endpoint <endpoint:string>', 'RPC endpoint URL')
  .action(async (options) => {
    let endpoint = options.endpoint

    // If no endpoint is provided, prompt for it
    if (!endpoint) {
      endpoint = await Input.prompt({
        message: 'Enter RPC endpoint URL:',
        default: 'https://api.mainnet-beta.solana.com',
      })
    }

    console.log(colors.blue(`Checking RPC endpoint: ${endpoint}`))

    try {
      // Execute the curl command with stderr redirected to stdout to capture time output
      // Ensure the URL is properly formatted
      const formattedEndpoint = endpoint.trim()
      const command =
        `curl -X POST -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"getEpochInfo","params":[]}' -w "Total time: %{time_total}s" -o /dev/null -s ${formattedEndpoint}`

      const process = await exec(command)

      // Extract and format the real time from the output regardless of success/failure
      const output = process.message
      const timeMatch = output.match(/Total time: (\d+\.\d+)s/)
      if (timeMatch) {
        const time = parseFloat(timeMatch[1])
        const timeColor = time < 1 ? colors.green : colors.red
        console.log(timeColor(`Total time: ${time}s`))
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error
        ? error.message
        : String(error)
      console.error(colors.red('Error executing curl command:'), errorMessage)
    }
  })

// gRPC check subcommand
checkCmd.command('grpc')
  .description('Check gRPC endpoint')
  .option('--endpoint <endpoint:string>', 'gRPC endpoint URL')
  .option('--token <token:string>', 'Token for authentication')
  .action(async (options) => {
    let endpoint = options.endpoint
    let token = options.token

    // If no endpoint is provided, prompt for it
    if (!endpoint) {
      endpoint = await Input.prompt({
        message: 'Enter gRPC endpoint URL:',
      })
    }

    // If no token is provided, prompt for it
    if (!token) {
      token = await Input.prompt({
        message: 'Enter Token for authentication:',
      })
    }

    console.log(colors.blue(`Checking gRPC endpoint: ${endpoint}`))

    try {
      // Path to the gRPC test binary
      const grpcTestPath = join(userBinDir, 'grpc_test')

      // Execute the gRPC test binary with the provided token and endpoint
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

    // If no endpoint is provided, prompt for it
    if (!endpoint) {
      endpoint = await Input.prompt({
        message: 'Enter Shreds endpoint URL:',
      })
    }

    console.log(colors.blue(`Checking Shreds endpoint: ${endpoint}`))

    try {
      // Path to the Shreds test binary
      const shredsTestPath = join(userBinDir, 'shreds_test')

      // Execute the gRPC test binary with the provided token and endpoint
      const command = `${shredsTestPath} ${endpoint}`

      await spawnSync(command)
    } catch (error: unknown) {
      const errorMessage = error instanceof Error
        ? error.message
        : String(error)
      console.error(colors.red('Error executing Shreds test:'), errorMessage)
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
