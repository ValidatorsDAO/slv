import { Command } from '@cliffy'
import { app } from '/src/server/api/index.ts'

export const serverCmd = new Command()
  .action(() => {
    const port = Number(Deno.env.get('PORT')) || 2010
    Deno.serve({ port }, app.fetch)
  })
