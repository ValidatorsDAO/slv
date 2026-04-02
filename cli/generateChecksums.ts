import { encodeHex } from 'jsr:@std/encoding@1/hex'

const getChecksumFileName = (fileName: string) =>
  fileName.startsWith('slv-') ? fileName.replace(/^slv-/, '') : fileName

/**
 * Generates SHA256 checksums for all .tar.gz files in dist/
 * Outputs dist/SHA256SUMS in GNU coreutils compatible format.
 *
 * For executable archives, the checksum file uses the uploaded filename
 * (for example x86_64-unknown-linux-gnu-exe.tar.gz rather than
 * slv-x86_64-unknown-linux-gnu-exe.tar.gz).
 */
const generateChecksums = async () => {
  const distDir = './dist'
  const outputPath = `${distDir}/SHA256SUMS`
  const lines: string[] = []

  console.log('Generating SHA256 checksums for dist/ archives...')

  for await (const entry of Deno.readDir(distDir)) {
    if (!entry.isFile || !entry.name.endsWith('.tar.gz')) {
      continue
    }

    const filePath = `${distDir}/${entry.name}`
    const checksumFileName = getChecksumFileName(entry.name)
    const fileContent = await Deno.readFile(filePath)
    const hashBuffer = await crypto.subtle.digest('SHA-256', fileContent)
    const hashHex = encodeHex(new Uint8Array(hashBuffer))

    // GNU coreutils format: two spaces between hash and filename
    lines.push(`${hashHex}  ${checksumFileName}`)
    console.log(`  ${hashHex}  ${checksumFileName}`)
  }

  if (lines.length === 0) {
    throw new Error('No .tar.gz files found in dist/')
  }

  lines.sort()

  await Deno.writeTextFile(outputPath, lines.join('\n') + '\n')
  console.log(`\n✅ SHA256SUMS written to ${outputPath} (${lines.length} files)`)
}

await generateChecksums()
