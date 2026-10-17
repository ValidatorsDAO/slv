import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1'

const VERSION = '2026.7.8.0901'
const PREVIOUS_VERSION = '2026.7.7.0901'
const BLOCKED_DELIVERY_TASKS = {
  'build:all':
    "echo 'Direct build/upload is disabled; use the reviewed GitHub release workflow.' && exit 1",
  'upload:script':
    "echo 'Direct upload is disabled; use the reviewed GitHub release workflow.' && exit 1",
  'upload:exe':
    "echo 'Direct upload is disabled; use the reviewed GitHub release workflow.' && exit 1",
  'upload:template':
    "echo 'Direct upload is disabled; use the reviewed GitHub release workflow.' && exit 1",
  'purge:cache':
    "echo 'Direct release cache mutation is disabled; use the reviewed GitHub release workflow.' && exit 1",
}
const REVIEWED_PACKAGE_TASK =
  'deno run --frozen --allow-read --allow-write --allow-run scripts/release/release.ts pack'
const decoder = new TextDecoder()

Deno.test({
  name:
    'build-skill preserves nested common tasks without duplicating their root',
  permissions: { read: true, run: true, write: true },
  async fn() {
    const root = await Deno.makeTempDir({ prefix: 'slv-build-skill-' })
    const source = `${root}/template/${VERSION}`
    const nestedTask = '- name: Nested fixture\n  debug:\n    msg: nested\n'
    const commonTask = '- name: Common fixture\n  debug:\n    msg: common\n'
    try {
      const files: Record<string, string> = {
        'ansible/mainnet-validator/init.yml':
          '- import_playbook: ../cmn/check_state.yml\n' +
          '- import_playbook: ../cmn/tasks/nested/observe.yml\n',
        'ansible/testnet-validator/init.yml': '---\n',
        'ansible/cmn/check_state.yml':
          '- include_tasks: tasks/alpenglow_state.yml\n',
        'ansible/cmn/tasks/alpenglow_state.yml': commonTask,
        'ansible/cmn/tasks/nested/observe.yml': nestedTask,
        'jinja/mainnet-validator/service.j2': 'mainnet fixture\n',
        'jinja/testnet-validator/service.j2': 'testnet fixture\n',
      }
      for (const [name, content] of Object.entries(files)) {
        const path = `${source}/${name}`
        await Deno.mkdir(path.slice(0, path.lastIndexOf('/')), {
          recursive: true,
        })
        await Deno.writeTextFile(path, content)
      }
      await Deno.copyFile(
        new URL('../../build-skill.sh', import.meta.url),
        `${root}/build-skill.sh`,
      )
      const generated = await run(root, 'bash', [
        `${root}/build-skill.sh`,
        'validator',
        VERSION,
      ])
      assertEquals(
        generated.code,
        0,
        `skill generator failed: ${generated.stderr || generated.stdout}`,
      )
      const output = `${root}/dist/skills/slv-validator/ansible/cmn/tasks`
      assertEquals(
        await Deno.readTextFile(`${output}/nested/observe.yml`),
        nestedTask,
      )
      assertEquals(
        await Deno.readTextFile(`${output}/alpenglow_state.yml`),
        commonTask,
      )
      await assertRejects(
        () => Deno.lstat(`${output}/tasks`),
        Deno.errors.NotFound,
      )
    } finally {
      await Deno.remove(root, { recursive: true })
    }
  },
})

async function run(
  cwd: string,
  command: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const output = await new Deno.Command(command, {
    args,
    cwd,
    stdout: 'piped',
    stderr: 'piped',
  }).output()
  return {
    code: output.code,
    stdout: decoder.decode(output.stdout),
    stderr: decoder.decode(output.stderr),
  }
}

async function writeTemplateFixture(root: string): Promise<void> {
  const files = [
    'AGENTS.md',
    'jinja/mainnet-validator/solv.service.j2',
    'ansible/mainnet-validator/init.yml',
    'jinja/mainnet-rpc/start-mainnet-rpc.sh.j2',
    'ansible/cmn/install_solana.yml',
    'tests/alpenglow_floor_vectors.json',
  ]
  for (const file of files) {
    const path = `${root}/template/${PREVIOUS_VERSION}/${file}`
    await Deno.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true })
    await Deno.writeTextFile(
      path,
      file.endsWith('.json') ? '[]\n' : `fixture ${file}\n`,
    )
  }
}

Deno.test({
  name:
    'update-version preserves blocked delivery tasks and tracks versioned test fixtures',
  permissions: { read: true, run: true, write: true },
  async fn() {
    const root = await Deno.makeTempDir({ prefix: 'slv-update-version-' })
    try {
      await Deno.mkdir(`${root}/scripts`, { recursive: true })
      await Deno.mkdir(`${root}/cmn/constants`, { recursive: true })
      await Deno.mkdir(`${root}/cli`, { recursive: true })
      await Deno.mkdir(`${root}/sh`, { recursive: true })
      await Deno.copyFile(
        new URL('../update-version.ts', import.meta.url),
        `${root}/scripts/update-version.ts`,
      )
      await Deno.copyFile(
        new URL('../check-version-sync.ts', import.meta.url),
        `${root}/scripts/check-version-sync.ts`,
      )
      await Deno.copyFile(
        new URL('../../.gitignore', import.meta.url),
        `${root}/.gitignore`,
      )
      await Deno.writeTextFile(
        `${root}/cmn/constants/version.ts`,
        `export const VERSION = '${VERSION}'\n`,
      )
      await Deno.writeTextFile(
        `${root}/cli/deno.json`,
        JSON.stringify({ version: PREVIOUS_VERSION }, null, 2),
      )
      await Deno.writeTextFile(
        `${root}/deno.json`,
        JSON.stringify(
          {
            imports: {
              '@std/fs': 'jsr:@std/fs@0.224.0',
              '@std/path': 'jsr:@std/path@0.224.0',
            },
            tasks: {
              'create:template':
                `tar -czf dist/template.tar.gz ./template/${PREVIOUS_VERSION}`,
              'release:package': REVIEWED_PACKAGE_TASK,
              ...BLOCKED_DELIVERY_TASKS,
            },
          },
          null,
          2,
        ),
      )
      await Deno.writeTextFile(
        `${root}/sh/install`,
        `#!/bin/sh\nVERSION="${PREVIOUS_VERSION}"\n`,
      )
      await writeTemplateFixture(root)
      await Deno.symlink(
        PREVIOUS_VERSION,
        `${root}/template/latest`,
        { type: 'dir' },
      )
      await Deno.writeTextFile(
        `${root}/build-skill.sh`,
        `#!/usr/bin/env bash
set -euo pipefail
mkdir -p "dist/oss-skills/slv-$1"
echo "fixture skill $1 $2"
`,
      )

      const generated = await run(root, 'deno', [
        'run',
        '-A',
        'scripts/update-version.ts',
      ])
      assert(
        generated.code === 0,
        `fixture generator failed: ${generated.stderr || generated.stdout}`,
      )
      const denoJson = JSON.parse(await Deno.readTextFile(`${root}/deno.json`))
      assertEquals(
        denoJson.tasks['create:template'],
        `tar -czf dist/template.tar.gz ./template/${VERSION}`,
      )
      assertEquals(
        denoJson.tasks['release:package'],
        REVIEWED_PACKAGE_TASK,
      )
      for (const [task, value] of Object.entries(BLOCKED_DELIVERY_TASKS)) {
        assertEquals(
          denoJson.tasks[task],
          value,
          `update-version changed blocked delivery task ${task}`,
        )
      }

      const versionSync = await run(root, 'deno', [
        'run',
        '-A',
        'scripts/check-version-sync.ts',
      ])
      assert(
        versionSync.code === 0,
        `fixture version sync failed: ${
          versionSync.stderr || versionSync.stdout
        }`,
      )

      const initialized = await run(root, 'git', ['init', '--quiet'])
      assertEquals(initialized.code, 0, initialized.stderr)
      const staged = await run(root, 'git', ['add', '--all'])
      assertEquals(staged.code, 0, staged.stderr)
      const fixturePath =
        `template/${VERSION}/tests/alpenglow_floor_vectors.json`
      const tracked = await run(root, 'git', [
        'ls-files',
        '--error-unmatch',
        '--',
        fixturePath,
      ])
      assertEquals(
        tracked.code,
        0,
        `generated public test fixture is missing from the commit: ${tracked.stderr}`,
      )
      assertEquals(await Deno.readTextFile(`${root}/${fixturePath}`), '[]\n')
    } finally {
      await Deno.remove(root, { recursive: true })
    }
  },
})
