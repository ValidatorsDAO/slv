import { runReleaseEngine } from '/lib/release/index.ts'
import { VERSION } from '@cmn/constants/version.ts'

const upgrade = async () => {
  const args = ['upgrade', '--current-version', VERSION]
  // In source mode Deno.execPath() is the Deno runtime. Passing it would turn
  // a release update into an attempt to replace Deno, so only standalone SLV
  // builds are allowed to nominate their own executable.
  if (Deno.build.standalone && Deno.execPath().endsWith('/slv')) {
    args.push('--running-binary', Deno.execPath())
  }
  const output = await runReleaseEngine(args)
  if (output) console.log(output.trim())
}

export { upgrade }
