import { parse } from '@std/yaml'
import { colors } from '@cliffy/colors'
import { spawnSync } from '@elsoul/child-process'
import type { InventoryType, NetworkType } from '@cmn/types/config.ts'
import { getInventoryPath } from '@cmn/constants/path.ts'

// SIMD-0387 (BLS pubkey management in vote account) requires every voting
// validator to register the BLS public key derived from its authorized voter
// keypair. Without it, the vote account behaves as unstaked once SIMD-0357
// (Alpenglow voting) is active on the cluster. As of mid-2026 SIMD-0387 is
// active on testnet only; on mainnet the command is a safe no-op until then.
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
    return json?.blsPubkeyCompressed ?? null
  } catch {
    return null
  }
}

const readBlsHosts = async (
  inventoryType: InventoryType,
  limit?: string,
): Promise<BlsHost[]> => {
  const filePath = getInventoryPath(inventoryType)
  let yamlText: string
  try {
    yamlText = await Deno.readTextFile(filePath)
  } catch (_e) {
    console.error(colors.red(`❌ Failed to read inventory file: ${filePath}`))
    return []
  }
  const data = parse(yamlText) as Record<string, any>
  const allHosts = data?.[inventoryType]?.hosts ?? {}
  const names = limit && limit.trim().toLowerCase() !== 'all'
    ? limit.split(',').map((s) => s.trim()).filter(Boolean)
    : Object.keys(allHosts)

  const out: BlsHost[] = []
  for (const name of names) {
    const h = allHosts[name]
    if (!h) {
      console.error(colors.red(`❌ Host not found in inventory: ${name}`))
      continue
    }
    if (!h.vote_account || !h.identity_account) {
      console.warn(
        colors.yellow(
          `⚠️ ${name}: missing vote_account/identity_account — skipping BLS registration`,
        ),
      )
      continue
    }
    out.push({
      name,
      identity_account: h.identity_account,
      vote_account: h.vote_account,
    })
  }
  return out
}

// Registers the BLS public key on each validator's vote account.
// The authorized voter defaults to the validator identity, so the identity
// keypair signs and `vote-authorize-voter-checked` (voter unchanged) fills in
// the derived BLS pubkey. Failures are non-fatal: the cluster may not have
// SIMD-0387 active yet, the key may already be set, or the CLI may be too old.
const registerBlsPubkey = async (
  network: NetworkType,
  limit?: string,
): Promise<boolean> => {
  const inventoryType: InventoryType = network === 'mainnet'
    ? 'mainnet_validators'
    : 'testnet_validators'
  const rpcUrl = RPC_URLS[network]
  const home = Deno.env.get('HOME') || ''

  const hosts = await readBlsHosts(inventoryType, limit)
  if (hosts.length === 0) {
    console.log(colors.yellow('⚠️ No hosts to register BLS pubkey for'))
    return false
  }

  console.log(
    colors.white(
      `🔑 Registering BLS public key on vote accounts (${network})...`,
    ),
  )
  let allOk = true
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
    const keypair = `${home}/.slv/keys/${h.identity_account}.json`
    const cmd =
      `solana vote-authorize-voter-checked ${h.vote_account} ${keypair} ${keypair} --use-v2-instruction --url ${rpcUrl}`
    const result = await spawnSync(cmd)
    if (!result.success) {
      console.warn(
        colors.yellow(
          `⚠️ ${h.name}: could not set BLS pubkey — SIMD-0387 is likely not ` +
            `active on ${network} yet (or the identity keypair is not the vote ` +
            `authority / solana CLI is too old). No state changed; re-run ` +
            `\`slv v register:bls\` after activation.`,
        ),
      )
      allOk = false
      continue
    }

    // Confirm the key actually landed on-chain before reporting success.
    if (await getBlsPubkey(h.vote_account, rpcUrl)) {
      console.log(colors.green(`✔︎ ${h.name}: BLS public key set`))
    } else {
      console.warn(
        colors.yellow(
          `⚠️ ${h.name}: tx sent but BLS pubkey still unset — SIMD-0387 is not ` +
            `active on ${network} yet. Re-run \`slv v register:bls\` after activation.`,
        ),
      )
      allOk = false
    }
  }
  return allOk
}

export { registerBlsPubkey }
