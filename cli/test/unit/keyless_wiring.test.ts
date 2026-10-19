import { assertEquals, assertStringIncludes } from '@std/assert'

Deno.test('slv v has keys:gen, keys:check, keys:try and hosts:pin: the validator command registers them once', async () => {
  const index = await Deno.readTextFile(
    new URL('../../src/validator/index.ts', import.meta.url),
  )
  assertStringIncludes(
    index,
    "import { registerKeylessCommands } from '/src/validator/keys/register.ts'",
  )
  assertEquals(
    index.split('registerKeylessCommands(validatorCmd)').length - 1,
    1,
  )
  // None of the four is defined a second time in the file.
  for (const verb of ['keys:gen', 'keys:check', 'keys:try', 'hosts:pin']) {
    assertEquals(index.includes(`.command('${verb}')`), false, verb)
  }
})
