import { parse } from '@std/yaml'
import { colors } from '@cliffy/colors'
import type { InventoryType, NetworkType } from '@cmn/types/config.ts'
import { getInventoryPath } from '@cmn/constants/path.ts'

// SIMD-0387 (BLS pubkey management in vote account) requires every voting
// validator to register the BLS public key derived from its authorized voter
// keypair. Without it, the vote account behaves as unstaked once SIMD-0357
// (Alpenglow voting) is active on the cluster. SIMD-0387 is active on testnet
// and mainnet, so a registration that does not happen is an error.
const RPC_URLS: Record<NetworkType, string> = {
  testnet: 'https://api.testnet.solana.com',
  mainnet: 'https://api.mainnet-beta.solana.com',
  devnet: 'https://api.devnet.solana.com',
}

interface BlsHost {
  name: string
  identity_account: string
  vote_account: string
}

// Reads the on-chain BLS pubkey for a vote account, or null if unset.
// The plain `solana vote-account` table output omits this field, so we parse
// JSON and read `blsPubkeyCompressed` (null until SIMD-0387 fills it in).
const getBlsPubkey = async (
  voteAccount: string,
  rpcUrl: string,
): Promise<string | null> => {
  try {
    const out = await new Deno.Command('solana', {
      args: [
        'vote-account',
        voteAccount,
        '--url',
        rpcUrl,
        '--output',
        'json',
      ],
      stdout: 'piped',
      stderr: 'piped',
    }).output()
    if (!out.success) return null
    const json = JSON.parse(new TextDecoder().decode(out.stdout))
    const bls = json?.blsPubkeyCompressed
    // Treat null/empty as "unset" so a non-empty base58 key is the only "set".
    return typeof bls === 'string' && bls.length > 0 ? bls : null
  } catch {
    return null
  }
}

// The hosts to register, and how many of the hosts asked for were left out
// because the inventory has no such host or no accounts for it.
const readBlsHosts = async (
  inventoryType: InventoryType,
  limit?: string,
): Promise<{ hosts: BlsHost[]; skipped: number }> => {
  const filePath = getInventoryPath(inventoryType)
  let yamlText: string
  try {
    yamlText = await Deno.readTextFile(filePath)
  } catch (_e) {
    console.error(colors.red(`❌ Failed to read inventory file: ${filePath}`))
    return { hosts: [], skipped: 0 }
  }
  let data: Record<string, any>
  try {
    data = parse(yamlText) as Record<string, any>
  } catch (e) {
    console.error(
      colors.red(
        `❌ Failed to parse inventory file ${filePath}: ${
          e instanceof Error ? e.message : e
        }`,
      ),
    )
    return { hosts: [], skipped: 0 }
  }
  const allHosts = data?.[inventoryType]?.hosts ?? {}
  const names = limit && limit.trim().toLowerCase() !== 'all'
    ? limit.split(',').map((s) => s.trim()).filter(Boolean)
    : Object.keys(allHosts)

  const out: BlsHost[] = []
  let skipped = 0
  for (const name of names) {
    const h = allHosts[name]
    if (!h) {
      console.error(colors.red(`❌ Host not found in inventory: ${name}`))
      skipped++
      continue
    }
    if (!h.vote_account || !h.identity_account) {
      console.error(
        colors.red(
          `❌ ${name}: missing vote_account/identity_account — its BLS public key is not registered`,
        ),
      )
      skipped++
      continue
    }
    out.push({
      name,
      identity_account: h.identity_account,
      vote_account: h.vote_account,
    })
  }
  return { hosts: out, skipped }
}

// Registers the BLS public key on each validator's vote account.
// The authorized voter defaults to the validator identity, so the identity
// keypair signs and pays, and `vote-authorize-voter-checked` (voter unchanged)
// fills in the derived BLS pubkey. Nothing here throws for a host that is not
// registered: that is an error line for the host and a false result.
const registerBlsOnHosts = async (
  network: NetworkType,
  limit?: string,
): Promise<boolean> => {
  if (network !== 'testnet' && network !== 'mainnet') {
    console.warn(
      colors.yellow(
        `⚠️ BLS registration supports testnet/mainnet only (got "${network}") — skipping.`,
      ),
    )
    return false
  }
  const inventoryType: InventoryType = network === 'mainnet'
    ? 'mainnet_validators'
    : 'testnet_validators'
  const rpcUrl = RPC_URLS[network]
  const home = Deno.env.get('HOME') || ''
  if (!home) {
    console.error(
      colors.red('❌ HOME is not set — cannot locate ~/.slv/keys keypairs.'),
    )
    return false
  }

  const { hosts, skipped } = await readBlsHosts(inventoryType, limit)
  if (hosts.length === 0) {
    console.log(colors.yellow('⚠️ No hosts to register BLS pubkey for'))
    return false
  }

  console.log(
    colors.white(
      `🔑 Registering BLS public key on vote accounts (${network})...`,
    ),
  )
  let allOk = skipped === 0
  for (const h of hosts) {
    console.log(colors.white(`→ ${h.name}: ${h.vote_account}`))

    // Idempotent: skip if the BLS pubkey is already on-chain.
    if (await getBlsPubkey(h.vote_account, rpcUrl)) {
      console.log(
        colors.green(`✔︎ ${h.name}: BLS public key already set — skipping`),
      )
      continue
    }

    // `--use-v2-instruction` forces the SIMD-0387 (BLS) instruction. When the
    // feature gate is inactive the tx fails cleanly at simulation WITHOUT
    // mutating state — unlike the auto-detect path, which silently falls back
    // to a plain voter re-authorization (a wasted tx that also burns the
    // once-per-epoch voter-change slot). The authorized voter is unchanged.
    // Use an argv array (not a shell string) so keypair paths containing
    // spaces are passed as a single argument rather than word-split.
    // The identity pays the fee (--fee-payer). Without it the solana CLI takes
    // its own default keypair, ~/.config/solana/id.json, as the fee payer and
    // stops when there is none.
    const keypair = `${home}/.slv/keys/${h.identity_account}.json`
    const again = `slv v register:bls -n ${network} -p ${h.name}`
    let sent: boolean
    try {
      const result = await new Deno.Command('solana', {
        args: [
          'vote-authorize-voter-checked',
          h.vote_account,
          keypair,
          keypair,
          '--fee-payer',
          keypair,
          '--use-v2-instruction',
          '--url',
          rpcUrl,
        ],
        stdout: 'inherit',
        stderr: 'inherit',
      }).output()
      sent = result.success
    } catch (error) {
      console.error(
        colors.red(
          `❌ ${h.name}: could not run solana (${
            error instanceof Error ? error.message : error
          }). Install the solana CLI, 4.3.0 or later, and put it on PATH, then ` +
            `run \`${again}\` again.`,
        ),
      )
      allOk = false
      continue
    }
    if (!sent) {
      console.error(
        colors.red(
          [
            `❌ ${h.name}: the BLS public key of ${h.vote_account} was not registered: the solana command failed (see above). Check that:`,
            `   - ${keypair} is here and is the key of the authorized voter or the authorized withdrawer of the vote account`,
            `   - the solana CLI is 4.3.0 or later (solana --version): the instruction that registers the key is in 4.3.0 and later`,
            `   - the identity ${h.identity_account} has SOL: it pays the fee of the transaction`,
            `   - the voter of the vote account was not changed in this epoch: one voter change is accepted per epoch, and this registration is one`,
            `   Then run \`${again}\` again.`,
          ].join('\n'),
        ),
      )
      allOk = false
      continue
    }

    // Confirm the key actually landed on-chain before reporting success.
    if (await getBlsPubkey(h.vote_account, rpcUrl)) {
      console.log(colors.green(`✔︎ ${h.name}: BLS public key set`))
    } else {
      console.error(
        colors.red(
          `❌ ${h.name}: the transaction was sent, but the vote account ${h.vote_account} does not show a BLS public key (or could not be read). ` +
            `Run \`${again}\` again: it reads the vote account first and sends nothing when the key is there.`,
        ),
      )
      allOk = false
    }
  }
  return allOk
}

type RegisterBlsOptions = {
  /** Called with 1 when a host is left without its BLS public key. The deploy does not give it, and its exit code stays as it is. */
  setExitCode?: (code: number) => void
}

const registerBlsPubkey = async (
  network: NetworkType,
  limit?: string,
  options: RegisterBlsOptions = {},
): Promise<boolean> => {
  const registered = await registerBlsOnHosts(network, limit)
  if (!registered) options.setExitCode?.(1)
  return registered
}

export { registerBlsPubkey }
export type { RegisterBlsOptions }
