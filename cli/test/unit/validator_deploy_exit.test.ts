import { assertEquals } from '@std/assert'

Deno.test('validator deploy and restart propagate failures and reject unknown networks', async () => {
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
        console.log('STUB_ACTION');
        if (limit !== 'example') throw new Error('unexpected target');
        return Promise.resolve(Deno.env.get('SLV_TEST_DEPLOY_RESULT') === 'success');
      }
      export const deployValidatorTestnet = result;
      export const deployValidatorMainnet = result;
      export function runAnsilbe(play: string, inventory: string, limit?: string) {
        const network = Deno.env.get('SLV_TEST_NETWORK');
        if (!play.endsWith('/' + network + '-validator/restart_node.yml') ||
            inventory !== network + '_validators') {
          console.log('STUB_ACTION');
          throw new Error('unexpected restart route');
        }
        return result(limit);
      }
      export function runAnsibleCapture() { throw new Error('unexpected capture'); }
    `,
    )
    for (const name of ['deployValidatorTestnet', 'deployValidatorMainnet']) {
      imports[`/src/validator/deploy/${name}.ts`] =
        new URL(`file://${stub}`).href
      imports[new URL(`src/validator/deploy/${name}.ts`, cli).href] =
        new URL(`file://${stub}`).href
    }
    imports['/lib/runAnsible.ts'] = new URL(`file://${stub}`).href
    imports[new URL('lib/runAnsible.ts', cli).href] =
      new URL(`file://${stub}`).href
    const map = `${dir}/imports.json`
    await Deno.writeTextFile(map, JSON.stringify({ imports }))
    const runner = `${dir}/runner.ts`
    await Deno.writeTextFile(
      runner,
      `
      import { validatorCmd } from ${
        JSON.stringify(new URL('src/validator/index.ts', cli).href)
      };
      await validatorCmd.parse([Deno.args[1], '-n', Deno.args[0], '-p', 'example']);
    `,
    )
    for (const command of ['deploy', 'restart']) {
      for (const network of ['mainnet', 'testnet', 'invalid']) {
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
              command,
            ],
            env: { SLV_TEST_DEPLOY_RESULT: result, SLV_TEST_NETWORK: network },
            stdout: 'piped',
            stderr: 'piped',
          }).output()
          assertEquals(
            run.code,
            result === 'success' && network !== 'invalid' ? 0 : 1,
            `${command}/${network}/${result}: ${
              new TextDecoder().decode(run.stderr)
            }`,
          )
          assertEquals(
            new TextDecoder().decode(run.stdout).includes('STUB_ACTION'),
            network !== 'invalid',
          )
        }
      }
    }
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})
