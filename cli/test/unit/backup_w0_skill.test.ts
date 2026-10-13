// slv overhaul W0: text checks on dist/oss-skills/slv-backup/SKILL.md.

import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from '@std/assert'

const SKILL = new URL(
  '../../../dist/oss-skills/slv-backup/SKILL.md',
  import.meta.url,
)

const lines = (text: string): string[] => text.split('\n')

/** The lines inside ``` fences: the commands the console would copy. */
const codeLines = (text: string): string[] => {
  const code: string[] = []
  let inFence = false
  for (const line of lines(text)) {
    if (line.startsWith('```')) {
      inFence = !inFence
    } else if (inFence) {
      code.push(line)
    }
  }
  return code
}

Deno.test('k5: the skill recommends no plain --upload and no schedule without --restic, and says a plain tar archive stays local', async () => {
  const text = await Deno.readTextFile(SKILL)

  // a plain tar archive is never uploaded: --upload may only appear next to --restic
  const plainUploads = lines(text).filter(
    (line) => line.includes('--upload') && !line.includes('--restic'),
  )
  assertEquals(
    plainUploads,
    [],
    'lines that recommend or describe a plain --upload',
  )

  // every command the console could copy is the encrypted one, or removes a schedule
  const copyable = [
    ...codeLines(text),
    ...lines(text).filter((line) =>
      line.startsWith('|') && line.includes('slv backup create')
    ),
    ...lines(text).filter((line) =>
      /time to snapshot this box with/.test(line)
    ),
  ].filter((line) => /slv backup create/.test(line))
  assert(copyable.length > 0, 'no slv backup create command found')
  const unencrypted = copyable.filter(
    (line) => !line.includes('--restic') && !/--cron off\b/.test(line),
  )
  assertEquals(unencrypted, [], 'slv backup create commands without --restic')

  // the table row and the proactive-suggestion examples name the restic backup
  const row = lines(text).find((line) =>
    line.includes('"take a backup of this server"')
  )
  assert(
    row,
    'decision-table row for "take a backup of this server" is missing',
  )
  assertStringIncludes(row, '--restic')

  // and the plain archive is described as local only
  assert(
    /plain tar archive stays local/i.test(text),
    'no "plain tar archive stays local"',
  )
})

/** Paragraphs and list items, each on one line of text. */
const units = (text: string): string[] => {
  const out: string[] = []
  let current: string[] = []
  const flush = () => {
    if (current.length > 0) out.push(current.join(' '))
    current = []
  }
  for (const line of lines(text)) {
    if (line.trim() === '') {
      flush()
      continue
    }
    if (/^\s*([-*]|\d+\.|\|)\s/.test(line) || line.startsWith('#')) flush()
    current.push(line.trim())
  }
  flush()
  return out
}

Deno.test('k6: the skill says wallets are backed up only with --restic, and promises no restic protection for keypairs or the key store', async () => {
  const text = await Deno.readTextFile(SKILL)
  assert(
    /wallets are backed up only with `--restic`/i.test(text),
    'no "Wallets are backed up only with `--restic`"',
  )

  // an item that speaks of validator keypairs, the key store or a signer key must not point to restic
  const keyTerms = /keypair|\.slv\/keys|signer key|key store/i
  const restic = /--restic|restic (backup|snapshot|restore)|encrypted/i
  const promises = units(text).filter((unit) =>
    keyTerms.test(unit) && restic.test(unit)
  )
  assertEquals(
    promises,
    [],
    'items that tie keypairs or the key store to restic',
  )

  // and it says they need an offline copy
  assert(
    units(text).some((unit) =>
      keyTerms.test(unit) && /offline copy/i.test(unit) &&
      /(never|no backup)/i.test(unit)
    ),
    'no item says keypairs and the key store are in no backup and need an offline copy',
  )
})

Deno.test('k7: the skill says SSH private keys are recognised by their content, under any name', async () => {
  const text = (await Deno.readTextFile(SKILL)).replace(/\s+/g, ' ')
  assert(
    /SSH private keys \([^)]*recogni[sz]ed by (their|its) content, under any name/i
      .test(text),
    'no "SSH private keys (recognised by their content, under any name ..."',
  )
  // and the old wording, which names only id_*, is gone
  assertFalse(/SSH private keys \(`id_\*`/.test(text))
})
