import { fromFileUrl } from '@std/path'
import { buildCommandEnv } from '@/ai/console/toolSafety.ts'

// Fixed argv only: this tool cannot turn a request for syntax into an operation.
export const HELP_COMMANDS = [
  'validator',
  'validator init',
  'validator deploy',
  'validator set:identity',
  'validator set:unstaked',
  'validator switch',
  'validator build:solana',
  'validator update:script',
  'validator restart',
  'rpc',
  'rpc init',
  'rpc deploy',
  'rpc restart',
  'install firewall',
  'install wireguard',
  'backup create',
  'gateway',
  'gateway start',
  'gateway run',
  'gateway config set-mode',
  'login',
  'onboard',
  'ai',
] as const

export function helpArguments(command: string): string[] | null {
  return (HELP_COMMANDS as readonly string[]).includes(command)
    ? [...command.split(' '), '--help']
    : null
}

export async function getCommandHelp(command: string): Promise<string> {
  const args = helpArguments(command)
  if (!args) {
    return 'Unknown help topic. Choose one of the supported command names.'
  }
  const cliArgs = Deno.build.standalone ? args : [
    'run',
    '--cached-only',
    '--no-prompt',
    '-A',
    fromFileUrl(new URL('../../index.ts', import.meta.url)),
    ...args,
  ]
  try {
    const result = await new Deno.Command(Deno.execPath(), {
      args: cliArgs,
      clearEnv: true,
      env: buildCommandEnv(Deno.env.toObject(), 'en'),
      stdin: 'null',
      stdout: 'piped',
      stderr: 'piped',
      signal: AbortSignal.timeout(10_000),
    }).output()
    if (!result.success) {
      return `Could not read local help. Ask the operator to run slv ${command} --help; do not invent options.`
    }
    const text = new TextDecoder().decode(result.stdout)
    // CLI help contains no account data. Limit context even if future help grows.
    return text.slice(0, 16_000)
  } catch {
    return `Could not read local help. Ask the operator to run slv ${command} --help; do not invent options.`
  }
}
