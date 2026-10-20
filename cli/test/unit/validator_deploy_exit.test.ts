import { assertEquals } from '@std/assert'

Deno.test('validator deploy CLI propagates unsuccessful completion on either network', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'slv-deploy-exit-' })
  const root = new URL('../../../', import.meta.url)
  const cli = new URL('cli/', root)
  try {
    const imports: Record<string, string> = {}
    for (
      const config of [new URL('deno.json', root), new URL('deno.json', cli)]
    ) {
      const value = JSON.parse(await Deno.readTextFile(config))
      for (
        const [key, target] of Object.entries(
          value.imports as Record<string, string>,
        )
      ) {
        imports[key] = target.startsWith('.')
          ? new URL(target, config).href
          : target
      }
    }
    // The CLI's "/" alias must not remap absolute fixture/source URLs.
    imports[root.href] = root.href
    const fixtureRoot = new URL(`file://${dir}/`).href
    imports[fixtureRoot] = fixtureRoot
    const stub = `${dir}/deployment.ts`
    await Deno.writeTextFile(
      stub,
      `
      function result(limit?: string) {
        if (limit !== 'example') throw new Error('unexpected target');
        return Promise.resolve(Deno.env.get('SLV_TEST_DEPLOY_RESULT') === 'success');
      }
      export const deployValidatorTestnet = result;
      export const deployValidatorMainnet = result;
    `,
    )
    for (const name of ['deployValidatorTestnet', 'deployValidatorMainnet']) {
      imports[`/src/validator/deploy/${name}.ts`] =
        new URL(`file://${stub}`).href
      imports[new URL(`src/validator/deploy/${name}.ts`, cli).href] =
        new URL(`file://${stub}`).href
    }
    const map = `${dir}/imports.json`
    await Deno.writeTextFile(map, JSON.stringify({ imports }))
    const runner = `${dir}/runner.ts`
    await Deno.writeTextFile(
      runner,
      `
      import { validatorCmd } from ${
        JSON.stringify(new URL('src/validator/index.ts', cli).href)
      };
      await validatorCmd.parse(['deploy', '-n', Deno.args[0], '-p', 'example']);
    `,
    )
    for (const network of ['mainnet', 'testnet']) {
      for (const result of ['success', 'failure']) {
        const run = await new Deno.Command(Deno.execPath(), {
          args: [
            'run',
            '--no-config',
            '--no-prompt',
            '--allow-env',
            '--import-map',
            map,
            new URL(`file://${runner}`).href,
            network,
          ],
          env: { SLV_TEST_DEPLOY_RESULT: result },
          stdout: 'piped',
          stderr: 'piped',
        }).output()
        assertEquals(
          run.code,
          result === 'success' ? 0 : 1,
          `${network}/${result}: ${new TextDecoder().decode(run.stderr)}`,
        )
      }
    }
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})
