// Development only: this file is not part of the slv executable.
//
// Runs `op read -n <reference>` the way the keyless verbs do (the same function,
// the same spawn, the same environment) against a field of a test item that holds
// no secret (its pubkey field), and prints the number of bytes op gave, and
// nothing of what it gave.
//
//   deno run -A --config=cli/deno.json cli/scripts/op_env_probe.ts op://<vault id>/<item id>/pubkey

import { zero } from '/lib/secret/keypairBytes.ts'
import { opRead, ResolveError } from '/lib/secret/resolveIdentity.ts'
import {
  defaultSecretSetupDeps,
  prepareSecretSetup,
  SecretRefusal,
  type SecretSetupDeps,
} from '/lib/secret/setup.ts'
import { describe } from '/src/validator/keys/io.ts'

type ProbeDeps = {
  setup: SecretSetupDeps
  out: (line: string) => void
  err: (line: string) => void
}

const USAGE = 'usage: op_env_probe.ts op://<vault id>/<item id>/pubkey'

/** The vault and the item by their ids (26 lower-case letters and digits), and a field by its name. */
const PROBE_REFERENCE =
  /^op:\/\/[a-z0-9]{26}\/[a-z0-9]{26}\/([A-Za-z0-9_-]{1,64})$/

/** The one field the probe reads: the pubkey field of an item, which holds no secret. 1Password reads the name of a field without regard to case, so the probe does too. */
const PROBE_FIELD = 'pubkey'

const defaultProbeDeps = (): ProbeDeps => ({
  setup: defaultSecretSetupDeps(),
  out: (line) => console.log(line),
  err: (line) => console.error(line),
})

/** 0 when op gave the field, 1 when it did not, 2 for a wrong command line. */
const runProbe = async (
  args: string[],
  overrides: Partial<ProbeDeps> = {},
): Promise<number> => {
  const deps: ProbeDeps = { ...defaultProbeDeps(), ...overrides }
  if (args.length !== 1) {
    deps.err(USAGE)
    return 2
  }
  const reference = args[0]
  const field = PROBE_REFERENCE.exec(reference)?.[1]
  if (field === undefined) {
    deps.err(`${USAGE}\nnot a reference of a field by ids: ${reference}`)
    return 2
  }
  if (field.toLowerCase() !== PROBE_FIELD) {
    deps.err(
      `${USAGE}\n${reference} is not the pubkey field of an item. The probe reads that field only: it holds no secret.`,
    )
    return 2
  }
  try {
    // keyless.yml is not read: the probe runs without a service account.
    const setup = await prepareSecretSetup('testnet', {
      ...deps.setup,
      readConfig: () => Promise.resolve({ networks: {}, identityAgent: null }),
    })
    const bytes = await opRead(reference, setup.resolve)
    const length = bytes.length
    zero(bytes)
    deps.out(String(length))
    return 0
  } catch (error) {
    if (error instanceof SecretRefusal || error instanceof ResolveError) {
      deps.err(error.message)
    } else {
      deps.err(`op_env_probe stopped: ${describe(error)}`)
    }
    return 1
  }
}

if (import.meta.main) {
  Deno.exit(await runProbe(Deno.args))
}

export { runProbe }
export type { ProbeDeps }
