import {
  loaderResolvedPaths,
  parseGlibcVersions,
  portableReceiptValue,
} from './verify-linux-product.ts'

Deno.test('ELF GLIBC parser accepts the 2.27 ceiling and rejects newer/private requirements', () => {
  const versions = parseGlibcVersions('GLIBC_2.2.5 GLIBC_2.27 GLIBC_2.2.5')
  if (JSON.stringify(versions) !== JSON.stringify(['2.2', '2.27'])) {
    throw new Error(`unexpected parsed versions: ${JSON.stringify(versions)}`)
  }
  for (const report of ['GLIBC_2.28', 'GLIBC_PRIVATE']) {
    let rejected = false
    try {
      parseGlibcVersions(report)
    } catch {
      rejected = true
    }
    if (!rejected) throw new Error(`unsafe ELF report accepted: ${report}`)
  }
})

Deno.test('compatibility receipts retain only portable command cwd and logs', () => {
  const command = {
    command: ['/pinned/loader', '--list', '/product/slv'],
    cwd: '/tmp/proof/linux-compatibility',
    started_at: '2026-10-13T00:00:00.000Z',
    finished_at: '2026-10-13T00:00:01.000Z',
    exit_code: 0,
    log: '/tmp/proof/linux-compatibility/product-version.log',
    log_sha256: 'a'.repeat(64),
  }
  const portable = portableReceiptValue(command, command.cwd) as Record<
    string,
    unknown
  >
  if (portable.cwd !== '.' || portable.log !== 'product-version.log') {
    throw new Error(
      `command receipt was not made portable: ${JSON.stringify(portable)}`,
    )
  }
  let rejected = false
  try {
    portableReceiptValue(
      { ...command, log: '/tmp/elsewhere/product-version.log' },
      command.cwd,
    )
  } catch {
    rejected = true
  }
  if (!rejected) throw new Error('out-of-tree command log was accepted')
})

Deno.test('loader parser keeps complete sysroot paths and rejects a host fallback', () => {
  const sysroot = '/tmp/pinned-sysroot'
  const paths = loaderResolvedPaths(
    `\nlibc.so.6 => ${sysroot}/lib/x86_64-linux-gnu/libc.so.6 (0x1)\n${sysroot}/lib/x86_64-linux-gnu/ld-2.27.so (0x2)\nlinux-vdso.so.1 (0x3)\n`,
  )
  if (
    JSON.stringify(paths) !==
      JSON.stringify([
        `${sysroot}/lib/x86_64-linux-gnu/libc.so.6`,
        `${sysroot}/lib/x86_64-linux-gnu/ld-2.27.so`,
      ])
  ) {
    throw new Error(`incorrect resolved loader paths: ${JSON.stringify(paths)}`)
  }
  const host = loaderResolvedPaths('libc.so.6 => /usr/lib/libc.so.6 (0x1)')
  if (host[0] !== '/usr/lib/libc.so.6') {
    throw new Error('host fallback was not parsed')
  }
  let rejected = false
  try {
    loaderResolvedPaths('libc.so.6 => not found')
  } catch {
    rejected = true
  }
  if (!rejected) throw new Error('missing library was accepted')
})
