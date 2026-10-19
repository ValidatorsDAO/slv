import { colors } from '@cliffy/colors'

// Where the keyless verbs write: lines for the person, and the exit code. What
// is written never holds a key; the verbs only pass public keys, references,
// names and the first line of an error through here.

type Io = {
  info: (line: string) => void
  error: (line: string) => void
  setExitCode: (code: number) => void
}

const defaultIo = (): Io => ({
  info: (line) => console.log(colors.white(line)),
  error: (line) => console.error(colors.red(line)),
  setExitCode: (code) => {
    Deno.exitCode = code
  },
})

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export { defaultIo, describe }
export type { Io }
