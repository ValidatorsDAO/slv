import { assert, assertEquals } from 'jsr:@std/assert@1'

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

const SKILLS = {
  validator: {
    ansible: ['mainnet-validator', 'testnet-validator'],
    jinja: ['mainnet-validator', 'testnet-validator'],
  },
  rpc: {
    ansible: ['mainnet-rpc', 'testnet-rpc', 'devnet-rpc'],
    jinja: ['mainnet-rpc', 'testnet-rpc', 'devnet-rpc'],
  },
  'grpc-geyser': {
    ansible: ['mainnet-rpc'],
    jinja: ['mainnet-rpc'],
  },
} as const

type Skill = keyof typeof SKILLS
type ProcessResult = { code: number; stdout: string; stderr: string }
type InventoryEntry = { path: string; sha256: string }

async function run(
  cwd: string,
  command: string,
  args: string[],
): Promise<ProcessResult> {
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

async function writeFixtureFile(
  root: string,
  relativePath: string,
  content: string | Uint8Array,
): Promise<void> {
  const path = `${root}/${relativePath}`
  await Deno.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true })
  if (typeof content === 'string') {
    await Deno.writeTextFile(path, content)
  } else {
    await Deno.writeFile(path, content)
  }
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const input = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer
  const hash = await crypto.subtle.digest('SHA-256', input)
  return Array.from(
    new Uint8Array(hash),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('')
}

async function inventory(root: string): Promise<InventoryEntry[]> {
  const files: InventoryEntry[] = []
  const collect = async (directory: string, prefix: string): Promise<void> => {
    for await (const entry of Deno.readDir(directory)) {
      const path = `${directory}/${entry.name}`
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory) {
        await collect(path, relativePath)
      } else if (entry.isFile) {
        files.push({
          path: relativePath,
          sha256: await sha256(await Deno.readFile(path)),
        })
      }
    }
  }
  await collect(root, '')
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

async function assertTreesEqual(source: string, destination: string) {
  const sourceInventory = await inventory(source)
  const destinationInventory = await inventory(destination)
  assertEquals(destinationInventory, sourceInventory)
  for (const { path } of sourceInventory) {
    assertEquals(
      await Deno.readFile(`${destination}/${path}`),
      await Deno.readFile(`${source}/${path}`),
      `changed packaged bytes: ${path}`,
    )
  }
}

async function assertMissing(path: string) {
  try {
    await Deno.lstat(path)
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return
    throw error
  }
  throw new Error(`unexpected path: ${path}`)
}

async function writeTemplateFixture(root: string): Promise<void> {
  const template = `template/${PREVIOUS_VERSION}`
  await writeFixtureFile(root, `${template}/AGENTS.md`, 'fixture guidance\n')
  const ansibleDirectories = new Set(
    (Object.values(SKILLS) as Array<(typeof SKILLS)[Skill]>).flatMap((skill) =>
      skill.ansible
    ),
  )
  const jinjaDirectories = new Set(
    (Object.values(SKILLS) as Array<(typeof SKILLS)[Skill]>).flatMap((skill) =>
      skill.jinja
    ),
  )
  const playbook = `---
- import_playbook: ../cmn/tasks/direct.yml
- import_playbook: ../cmn/shared.yml
- name: use common jinja
  ansible.builtin.template:
    src: .slv/cmn/common.j2
`
  for (const directory of ansibleDirectories) {
    await writeFixtureFile(
      root,
      `${template}/ansible/${directory}/init.yml`,
      playbook,
    )
  }
  for (const directory of jinjaDirectories) {
    await writeFixtureFile(
      root,
      `${template}/jinja/${directory}/service.j2`,
      `fixture ${directory}\n`,
    )
  }
  await writeFixtureFile(
    root,
    `${template}/jinja/mainnet-rpc/start-mainnet-rpc.sh.j2`,
    '#!/bin/sh\necho fixture\n',
  )
  await writeFixtureFile(
    root,
    `${template}/jinja/mainnet-validator/solv.service.j2`,
    '[Service]\nExecStart=/usr/bin/true\n',
  )
  await writeFixtureFile(
    root,
    `${template}/jinja/cmn/common.j2`,
    'common {{ value }}\n',
  )
  await writeFixtureFile(
    root,
    `${template}/ansible/cmn/shared.yml`,
    '---\n- import_playbook: transitive.yml\n- include_tasks: tasks/another.yml\n',
  )
  await writeFixtureFile(
    root,
    `${template}/ansible/cmn/transitive.yml`,
    '---\n- name: transitive common task\n  ansible.builtin.debug:\n    msg: transitive\n',
  )
  await writeFixtureFile(
    root,
    `${template}/ansible/cmn/install_solana.yml`,
    '---\n- name: required sync fixture\n  ansible.builtin.debug:\n    msg: sync\n',
  )
  await writeFixtureFile(
    root,
    `${template}/ansible/cmn/tasks/direct.yml`,
    '---\n- name: direct nested task\n  import_tasks: deep/child.yml\n',
  )
  await writeFixtureFile(
    root,
    `${template}/ansible/cmn/tasks/another.yml`,
    '---\n- name: another task\n  ansible.builtin.debug:\n    msg: another\n',
  )
  await writeFixtureFile(
    root,
    `${template}/ansible/cmn/tasks/deep/child.yml`,
    '---\n- name: deeply nested task\n  ansible.builtin.debug:\n    msg: child\n',
  )
  await writeFixtureFile(
    root,
    `${template}/ansible/cmn/tasks/README-雪.txt`,
    'UTF-8 adjacent task metadata: 雪\n',
  )
  await writeFixtureFile(
    root,
    `${template}/ansible/cmn/tasks/payload.bin`,
    new Uint8Array([0, 1, 2, 255, 128, 10]),
  )
}

async function assertSkillPackage(root: string, skill: Skill): Promise<void> {
  const template = `${root}/template/${VERSION}`
  const output = `${root}/dist/skills/slv-${skill}`
  for (const directory of SKILLS[skill].ansible) {
    await assertTreesEqual(
      `${template}/ansible/${directory}`,
      `${output}/ansible/${directory}`,
    )
  }
  for (const file of ['shared.yml', 'transitive.yml']) {
    assertEquals(
      await Deno.readFile(`${output}/ansible/cmn/${file}`),
      await Deno.readFile(`${template}/ansible/cmn/${file}`),
      `changed packaged common file: ${file}`,
    )
  }
  await assertTreesEqual(
    `${template}/ansible/cmn/tasks`,
    `${output}/ansible/cmn/tasks`,
  )
  await assertTreesEqual(`${template}/jinja/cmn`, `${output}/jinja/cmn`)
  for (const directory of SKILLS[skill].jinja) {
    await assertTreesEqual(
      `${template}/jinja/${directory}`,
      `${output}/jinja/${directory}`,
    )
  }
  await assertMissing(`${output}/ansible/cmn/tasks/tasks`)
}

Deno.test({
  name:
    'update-version packages nested common tasks with the real three-skill packager',
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
        new URL('../../build-skill.sh', import.meta.url),
        `${root}/build-skill.sh`,
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
      const sourceBefore = await inventory(
        `${root}/template/${PREVIOUS_VERSION}`,
      )
      await Deno.symlink(
        PREVIOUS_VERSION,
        `${root}/template/latest`,
        { type: 'dir' },
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
      assertEquals(
        await inventory(`${root}/template/${PREVIOUS_VERSION}`),
        sourceBefore,
        'generator changed its source template',
      )

      const denoJson = JSON.parse(await Deno.readTextFile(`${root}/deno.json`))
      assertEquals(
        denoJson.tasks['create:template'],
        `tar -czf dist/template.tar.gz ./template/${VERSION}`,
      )
      assertEquals(denoJson.tasks['release:package'], REVIEWED_PACKAGE_TASK)
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

      for (const skill of Object.keys(SKILLS) as Skill[]) {
        await assertSkillPackage(root, skill)
      }
      const firstInventory = await inventory(`${root}/dist/skills`)

      await Deno.writeTextFile(
        `${root}/dist/skills/slv-validator/stale-artifact.txt`,
        'stale\n',
      )
      for (const skill of Object.keys(SKILLS) as Skill[]) {
        const rebuilt = await run(root, 'bash', [
          'build-skill.sh',
          skill,
          VERSION,
        ])
        assert(
          rebuilt.code === 0,
          `fixture ${skill} packager failed: ${
            rebuilt.stderr || rebuilt.stdout
          }`,
        )
        await assertSkillPackage(root, skill)
      }
      assertEquals(await inventory(`${root}/dist/skills`), firstInventory)

      const unsupported = await run(root, 'bash', [
        'build-skill.sh',
        'unsupported',
        VERSION,
      ])
      assert(unsupported.code !== 0, 'unsupported skill unexpectedly passed')
    } finally {
      await Deno.remove(root, { recursive: true })
    }
  },
})
