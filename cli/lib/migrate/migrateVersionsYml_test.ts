import { assert, assertEquals, assertExists } from '@std/assert'
import { parse } from '@std/yaml'
import { join } from '@std/path'
import { defaultVersionsObject } from '/lib/config/defaultVersionsYml.ts'
import { migrateVersionsYml } from '/lib/migrate/migrateVersionsYml.ts'

const withTempDir = async (
  fn: (dir: string) => Promise<void>,
): Promise<void> => {
  const dir = await Deno.makeTempDir({ prefix: 'slv-versions-migrate-' })
  try {
    await fn(dir)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
}

const readYaml = async (path: string): Promise<Record<string, unknown>> => {
  const value = parse(await Deno.readTextFile(path))
  assert(typeof value === 'object' && value !== null && !Array.isArray(value))
  return value as Record<string, unknown>
}

Deno.test('versions migration creates defaults for a missing settings file', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'versions.yml')

    assertEquals(await migrateVersionsYml(path), true)
    assertEquals(
      await readYaml(path),
      defaultVersionsObject() as unknown as Record<string, unknown>,
    )
  })
})

Deno.test('versions migration keeps configured values and unknown keys', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'versions.yml')
    await Deno.writeTextFile(
      path,
      [
        'mainnet_validators:',
        '  version_agave: user-selected-version',
        '  future_setting:',
        '    enabled: true',
        'custom_section:',
        '  keep: this-value',
        '',
      ].join('\n'),
    )

    assertEquals(await migrateVersionsYml(path), true)

    const migrated = await readYaml(path)
    const validators = migrated.mainnet_validators as Record<string, unknown>
    assertEquals(validators.version_agave, 'user-selected-version')
    assertExists(validators.version_jito)
    assertEquals(validators.future_setting, { enabled: true })
    assertEquals(migrated.custom_section, { keep: 'this-value' })
  })
})

Deno.test('versions migration backs up invalid YAML before restoring defaults', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'versions.yml')
    const invalid = 'mainnet_validators: [unclosed\n'
    const events: string[] = []
    await Deno.writeTextFile(path, invalid)

    const migrated = await migrateVersionsYml(path, {
      now: () => 123,
      rename: async (source, destination) => {
        events.push('rename')
        await Deno.rename(source, destination)
      },
      writeTextFile: async (destination, data) => {
        events.push('write')
        await Deno.writeTextFile(destination, data)
      },
    })

    assertEquals(migrated, true)
    assertEquals(events, ['rename', 'write'])
    assertEquals(await Deno.readTextFile(`${path}.bak.123`), invalid)
    assertEquals(
      await readYaml(path),
      defaultVersionsObject() as unknown as Record<string, unknown>,
    )
  })
})

Deno.test('versions migration leaves invalid settings unchanged when backup fails', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'versions.yml')
    const invalid = 'mainnet_validators: [unclosed\n'
    let writes = 0
    await Deno.writeTextFile(path, invalid)

    const migrated = await migrateVersionsYml(path, {
      rename: () => Promise.reject(new Deno.errors.PermissionDenied('denied')),
      writeTextFile: () => {
        writes += 1
        return Promise.resolve()
      },
    })

    assertEquals(migrated, false)
    assertEquals(writes, 0)
    assertEquals(await Deno.readTextFile(path), invalid)
  })
})

Deno.test('versions migration does not replace settings after a non-NotFound read error', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'versions.yml')
    const original = 'mainnet_validators:\n  version_agave: preserve-me\n'
    let renames = 0
    let writes = 0
    await Deno.writeTextFile(path, original)

    const migrated = await migrateVersionsYml(path, {
      readTextFile: () =>
        Promise.reject(
          new Deno.errors.PermissionDenied('settings unavailable'),
        ),
      rename: () => {
        renames += 1
        return Promise.resolve()
      },
      writeTextFile: () => {
        writes += 1
        return Promise.resolve()
      },
    })

    assertEquals(migrated, false)
    assertEquals(renames, 0)
    assertEquals(writes, 0)
    assertEquals(await Deno.readTextFile(path), original)
  })
})

Deno.test('versions migration returns false when writing migrated settings fails', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'versions.yml')
    const valid =
      'mainnet_validators:\n  version_agave: user-selected-version\n'
    await Deno.writeTextFile(path, valid)

    const migrated = await migrateVersionsYml(path, {
      writeTextFile: () =>
        Promise.reject(new Deno.errors.PermissionDenied('settings read-only')),
    })

    assertEquals(migrated, false)
    assertEquals(await Deno.readTextFile(path), valid)
  })
})

Deno.test('upgrade:settings exits nonzero when versions migration cannot read settings', async () => {
  await withTempDir(async (home) => {
    const settingsDir = join(home, '.slv')
    await Deno.mkdir(join(settingsDir, 'versions.yml'), { recursive: true })

    const command = new Deno.Command(Deno.execPath(), {
      args: [
        'run',
        '--frozen',
        '--allow-env',
        '--allow-read',
        '--allow-write',
        'cli/src/index.ts',
        'upgrade:settings',
      ],
      cwd: Deno.cwd(),
      env: { HOME: home },
      stdout: 'piped',
      stderr: 'piped',
    })

    const result = await command.output()
    assert(result.code !== 0)
    assertEquals(
      (await Deno.stat(join(settingsDir, 'versions.yml'))).isDirectory,
      true,
    )
  })
})
