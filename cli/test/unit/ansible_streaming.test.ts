import { assertEquals, assertStringIncludes } from '@std/assert'
import { streamProcess } from '/lib/runAnsible.ts'

Deno.test('progress is forwarded before the child exits, and both streams remain captured', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'slv-streaming-' })
  const marker = `${dir}/progress-seen`
  const decoder = new TextDecoder()
  let seenOut = ''
  let seenErr = ''
  try {
    const result = await streamProcess(Deno.execPath(), [
      'eval',
      '--no-config',
      `
      console.log('PLAY [fixture]');
      let acknowledged = false;
      for (let i = 0; i < 100; i++) {
        try { await Deno.stat(${
        JSON.stringify(marker)
      }); acknowledged = true; break } catch {}
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      if (!acknowledged) Deno.exit(12);
      console.error('fixture diagnostic');
      console.log('PLAY RECAP');
    `,
    ], async (chunk) => {
      const text = decoder.decode(chunk)
      seenOut += text
      if (text.includes('PLAY [fixture]')) {
        await Deno.writeTextFile(marker, 'received')
      }
    }, (chunk) => {
      seenErr += decoder.decode(chunk)
      return Promise.resolve()
    })
    // A buffer-until-exit runner cannot acknowledge the first output, so the
    // child exits 12. This proves the timing, rather than merely the final text.
    assertEquals(result.success, true)
    assertEquals(result.streamed, true)
    assertEquals(decoder.decode(result.stdout), seenOut)
    assertEquals(decoder.decode(result.stderr), seenErr)
    assertStringIncludes(seenOut, 'PLAY RECAP')
    assertStringIncludes(seenErr, 'fixture diagnostic')
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('large stdout and stderr are drained concurrently and failure status is retained', async () => {
  const result = await streamProcess(
    Deno.execPath(),
    [
      'eval',
      '--no-config',
      `
    const data = new Uint8Array(256 * 1024).fill(65);
    async function writeAll(stream) {
      let offset = 0;
      while (offset < data.length) offset += await stream.write(data.subarray(offset));
    }
    await Promise.all([writeAll(Deno.stdout), writeAll(Deno.stderr)]);
    Deno.exit(7);
  `,
    ],
    async () => {},
    async () => {},
  )
  assertEquals(result.success, false)
  assertEquals(result.code, 7)
  assertEquals(result.stdout.length, 256 * 1024)
  assertEquals(result.stderr.length, 256 * 1024)
})

Deno.test('a closed display sink does not discard diagnostics or abort the child', async () => {
  const result = await streamProcess(
    Deno.execPath(),
    [
      'eval',
      '--no-config',
      `
    console.log('start');
    console.error('diagnostic');
    await new Promise(resolve => setTimeout(resolve, 30));
    console.log('complete');
  `,
    ],
    () => Promise.reject(new Error('closed sink')),
    () => Promise.reject(new Error('closed sink')),
  )
  assertEquals(result.success, true)
  assertStringIncludes(new TextDecoder().decode(result.stdout), 'complete')
  assertStringIncludes(new TextDecoder().decode(result.stderr), 'diagnostic')
})
