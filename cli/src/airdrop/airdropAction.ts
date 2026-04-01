import { getApiKeyFromYml } from '/lib/getApiKeyFromYml.ts'
import { colors } from '@cliffy/colors'
import { Input } from '@cliffy/prompt'
import Kia from 'https://deno.land/x/kia@0.4.1/mod.ts'

const USER_API_URL = 'https://user-api.erpc.global/v3/ai/airdrop'
const BASE58_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

export const airdropAction = async (walletAddress?: string) => {
  const apiKey = await getApiKeyFromYml()

  if (!walletAddress) {
    walletAddress = await Input.prompt({
      message: colors.white('Enter your Solana wallet address'),
    })
  }

  if (!BASE58_REGEX.test(walletAddress)) {
    console.log(colors.red('\n  ❌ Invalid Solana wallet address format\n'))
    return
  }

  const spinner = new Kia(colors.cyan('Requesting Testnet SOL airdrop...'))
  spinner.start()

  try {
    const response = await fetch(USER_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ walletAddress }),
    })

    const data = (await response.json()) as Record<string, unknown>

    if (!response.ok) {
      spinner.fail('Airdrop failed')
      if (response.status === 409) {
        console.log(
          colors.yellow('\n  You have already received your Testnet SOL airdrop.\n'),
        )
      } else if (response.status === 403) {
        console.log(
          colors.yellow(
            '\n  Payment verification required. Please complete signup first.\n',
          ),
        )
      } else {
        const msg = (data?.message as string) ?? `HTTP ${response.status}`
        console.log(colors.red(`\n  ${msg}\n`))
      }
      return
    }

    spinner.succeed('Airdrop successful!')

    const txSignature = data.txSignature as string | undefined
    console.log(colors.green('\n  ✅ 1 Testnet SOL sent to your wallet!\n'))
    console.log(
      colors.white(`  Wallet: ${walletAddress}`),
    )
    if (txSignature) {
      console.log(
        colors.gray(
          `  Explorer: https://explorer.solana.com/tx/${txSignature}?cluster=testnet\n`,
        ),
      )
    }
  } catch (error) {
    spinner.fail('Airdrop failed')
    console.log(colors.red(`\n  ${(error as Error).message}\n`))
  }
}
