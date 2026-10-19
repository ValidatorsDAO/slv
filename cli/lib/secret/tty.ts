// Questions to a person, asked on /dev/tty and not on stdin, so that nothing a
// pipe or a script feeds in can answer them.

type Tty = {
  /** Writes `prompt` to the terminal and returns the line that is typed. */
  ask: (prompt: string) => Promise<string>
  /** Writes lines to the terminal. */
  say: (text: string) => Promise<void>
}

const encoder = new TextEncoder()

const defaultTty: Tty = {
  ask: async (prompt) => {
    const tty = await Deno.open('/dev/tty', { read: true, write: true })
    try {
      await tty.write(encoder.encode(prompt))
      const bytes: number[] = []
      const chunk = new Uint8Array(1)
      while (true) {
        const read = await tty.read(chunk)
        if (read === null || chunk[0] === 0x0a) break
        bytes.push(chunk[0])
      }
      return new TextDecoder().decode(Uint8Array.from(bytes)).replace(/\r$/, '')
    } finally {
      tty.close()
    }
  },
  say: async (text) => {
    const tty = await Deno.open('/dev/tty', { write: true })
    try {
      await tty.write(encoder.encode(text))
    } finally {
      tty.close()
    }
  },
}

export { defaultTty }
export type { Tty }
