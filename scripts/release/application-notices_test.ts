import { assertEquals, assertRejects } from 'jsr:@std/assert@1'
import {
  acquireApplicationNoticeEvidence,
  materializeApplicationNotices,
} from './application-notices.ts'

async function hash(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  const value = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(value)].map((byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')
}

async function fixture(): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: 'slv-application-notices-' })
  const write = (path: string, text: string) => Deno.writeTextFile(path, text)
  const npm = `${root}/node_modules/.deno/example@1.2.3/node_modules/example`
  const evidence = `${root}/scripts/release/application-notices/evidence`
  await Deno.mkdir(npm, { recursive: true })
  await Deno.mkdir(evidence, { recursive: true })
  await Deno.mkdir(`${root}/dist/release-inputs`, { recursive: true })
  await write(
    `${npm}/package.json`,
    JSON.stringify({ name: 'example', version: '1.2.3', license: 'MIT' }),
  )
  await write(`${npm}/LICENSE`, 'npm license text\n')
  await write(`${evidence}/jsr-license.txt`, 'jsr license text\n')
  await write(`${evidence}/std-license.txt`, 'std license text\n')
  await write(
    `${root}/dist/release-inputs/compiled-module-graph.json`,
    JSON.stringify({
      schema_version: 1,
      npm: ['example@1.2.3'],
      jsr: ['@scope/pkg@1.0.0'],
      remote: [
        'https://deno.land/std@0.1.0/a.ts',
        'https://deno.land/std@0.1.0/b.ts',
      ],
    }),
  )
  await write(
    `${root}/scripts/release/application-notices/evidence-index.json`,
    JSON.stringify({
      schema_version: 1,
      distributions: [
        {
          id: 'jsr:@scope/pkg@1.0.0',
          files: [{
            path: 'evidence/jsr-license.txt',
            sha256: await hash('jsr license text\n'),
            source: 'https://primary.example/jsr-license.txt',
          }],
        },
        {
          id: 'deno.land/std@0.1.0',
          files: [{
            path: 'evidence/std-license.txt',
            sha256: await hash('std license text\n'),
            source: 'https://primary.example/std-license.txt',
          }],
        },
      ],
    }),
  )
  return root
}

async function addSupplementedEvidence(
  root: string,
): Promise<{ integrity: string; mappingPath: string }> {
  const indexPath =
    `${root}/scripts/release/application-notices/evidence-index.json`
  const index = JSON.parse(await Deno.readTextFile(indexPath)) as {
    distributions: unknown[]
    additional_components?: unknown[]
  }
  const integrity =
    'sha512-KDfHqv/Wy4elVseZXgokbHxeWuqBL+AZfqsOMpEihBMUsk/fJ+bLIi3Sf70JFVpt1Ihui8RasYrInozt7ZBDIA=='
  const evidence = `${root}/scripts/release/application-notices/evidence`
  const supplement = 'supplemental license text\n'
  const generator = 'generator source\n'
  const unicodeData = 'Copyright (c) 1991-2015 Unicode, Inc.\ndata\n'
  const unicodeLicense = 'UNICODE LICENSE V3\npermission\n'
  const mapping = JSON.stringify([[0, 1], [2, 3]])
  const mappingPath =
    `${root}/node_modules/.deno/example@1.2.3/node_modules/example/lib/mappingTable.json`
  await Deno.mkdir(`${evidence}/unicode`, { recursive: true })
  await Deno.mkdir(`${evidence}/npm`, { recursive: true })
  await Deno.mkdir(mappingPath.slice(0, mappingPath.lastIndexOf('/')), {
    recursive: true,
  })
  await Deno.writeTextFile(`${evidence}/npm/supplement.txt`, supplement)
  await Deno.writeTextFile(`${evidence}/npm/generator.js`, generator)
  await Deno.writeTextFile(`${evidence}/unicode/table.txt`, unicodeData)
  await Deno.writeTextFile(`${evidence}/unicode/license.txt`, unicodeLicense)
  await Deno.writeTextFile(mappingPath, mapping)
  await Deno.writeTextFile(
    `${root}/deno.lock`,
    JSON.stringify({
      npm: { 'example@1.2.3': { integrity } },
    }),
  )
  index.distributions.push({
    id: 'npm:example@1.2.3',
    files: [{
      path: 'evidence/npm/supplement.txt',
      sha256: await hash(supplement),
      source: 'https://primary.example/supplement.txt',
    }],
    supplement: {
      original_archive_integrity: integrity,
      original_evidence_receipt: 'unresolved-omissions.json',
      supplement_source_commit: 'a'.repeat(40),
      same_source_verified: false,
      rationale: 'later source supplement',
      maintainer_statement: 'https://primary.example/maintainer-statement',
    },
  })
  index.additional_components = [{
    id: 'unicode:fixture@8.0.0',
    inclusion_basis: 'actual-shipped',
    files: [
      {
        path: 'evidence/npm/generator.js',
        sha256: await hash(generator),
        source: 'https://primary.example/generator.js',
        role: 'source-material',
      },
      {
        path: 'evidence/unicode/table.txt',
        sha256: await hash(unicodeData),
        source: 'https://primary.example/table.txt',
        role: 'source-material',
      },
      {
        path: 'evidence/unicode/license.txt',
        sha256: await hash(unicodeLicense),
        source: 'https://primary.example/license.txt',
      },
    ],
    derived_unicode_data: {
      npm_key: 'example@1.2.3',
      output_path: 'lib/mappingTable.json',
      output_sha256: await hash(mapping),
      output_bytes: new TextEncoder().encode(mapping).length,
      output_rows: 2,
      generator_path: 'evidence/npm/generator.js',
      generator_sha256: await hash(generator),
      source_data_path: 'evidence/unicode/table.txt',
      source_data_sha256: await hash(unicodeData),
      original_attribution: 'Copyright (c) 1991-2015 Unicode, Inc.',
      transform_description: 'fixture transformation',
      historical_modification_notice: 'fixture modification notice',
      current_distribution_permission:
        'fixture current distribution permission',
    },
  }]
  await Deno.writeTextFile(indexPath, JSON.stringify(index))
  return { integrity, mappingPath }
}

Deno.test('materializer derives npm from frozen node_modules and maps JSR/remote modules to pinned distributions', async () => {
  const root = await fixture()
  try {
    const report = await materializeApplicationNotices(root)
    assertEquals(report, {
      materialized: 4,
      unresolvedActual: [],
      conservativeExtrasWithoutText: [],
    })
    const index = JSON.parse(
      await Deno.readTextFile(
        `${root}/dist/release-inputs/license-evidence.json`,
      ),
    ) as {
      components: Array<
        {
          namespace: string
          key: string
          files: string[]
          declared_license?: string
        }
      >
    }
    assertEquals(
      index.components.map((component) =>
        `${component.namespace}:${component.key}`
      ),
      [
        'jsr:@scope/pkg@1.0.0',
        'npm:example@1.2.3',
        'remote:https://deno.land/std@0.1.0/a.ts',
        'remote:https://deno.land/std@0.1.0/b.ts',
      ],
    )
    assertEquals(
      index.components.every((component) => component.files.length === 1),
      true,
    )
    assertEquals(
      index.components.find((component) => component.namespace === 'npm')
        ?.declared_license,
      'MIT',
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('materializer reports an unmapped remote distribution once rather than per module', async () => {
  const root = await fixture()
  try {
    const graph = JSON.parse(
      await Deno.readTextFile(
        `${root}/dist/release-inputs/compiled-module-graph.json`,
      ),
    ) as { remote: string[] }
    graph.remote = [
      'https://deno.land/x/unmapped@1.0.0/a.ts',
      'https://deno.land/x/unmapped@1.0.0/b.ts',
    ]
    await Deno.writeTextFile(
      `${root}/dist/release-inputs/compiled-module-graph.json`,
      JSON.stringify({
        schema_version: 1,
        npm: [],
        jsr: [],
        remote: graph.remote,
      }),
    )
    const report = await materializeApplicationNotices(root)
    assertEquals(report.unresolvedActual, ['deno.land/x/unmapped@1.0.0'])
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('materializer accepts checked-in primary text for an exact npm graph identity', async () => {
  const root = await fixture()
  try {
    const indexPath =
      `${root}/scripts/release/application-notices/evidence-index.json`
    const index = JSON.parse(await Deno.readTextFile(indexPath)) as {
      distributions: unknown[]
    }
    const text = 'primary npm license text\n'
    await Deno.writeTextFile(
      `${root}/scripts/release/application-notices/evidence/npm-license.txt`,
      text,
    )
    index.distributions.push({
      id: 'npm:example@1.2.3',
      files: [{
        path: 'evidence/npm-license.txt',
        sha256: await hash(text),
        source: 'https://primary.example/npm-license.txt',
      }],
    })
    await Deno.writeTextFile(indexPath, JSON.stringify(index))
    await Deno.remove(
      `${root}/node_modules/.deno/example@1.2.3/node_modules/example/LICENSE`,
    )

    const report = await materializeApplicationNotices(root)
    assertEquals(report.unresolvedActual, [])
    const output = JSON.parse(
      await Deno.readTextFile(
        `${root}/dist/release-inputs/license-evidence.json`,
      ),
    ) as { components: Array<{ namespace: string; files: string[] }> }
    assertEquals(
      output.components.find((component) => component.namespace === 'npm')
        ?.files,
      [
        'dist/release-inputs/application-notices/npm_example_1.2.3/0-npm-license.txt',
      ],
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('supplemented package and Unicode data require exact source, archive, and generated-output evidence', async () => {
  const root = await fixture()
  try {
    const { integrity, mappingPath } = await addSupplementedEvidence(root)
    const report = await materializeApplicationNotices(root)
    assertEquals(report.unresolvedActual, [])
    const output = JSON.parse(
      await Deno.readTextFile(
        `${root}/dist/release-inputs/license-evidence.json`,
      ),
    ) as {
      components: Array<{ supplement?: { same_source_verified: boolean } }>
      additional_components: Array<{ id: string; files: string[] }>
    }
    assertEquals(
      output.components.some((component) =>
        component.supplement?.same_source_verified === false
      ),
      true,
    )
    assertEquals(output.additional_components[0].id, 'unicode:fixture@8.0.0')
    assertEquals(output.additional_components[0].files.length, 1)

    await Deno.writeTextFile(
      `${root}/deno.lock`,
      JSON.stringify({
        npm: { 'example@1.2.3': { integrity: `${integrity}x` } },
      }),
    )
    await assertRejects(
      () => materializeApplicationNotices(root),
      Error,
      'archive integrity differs',
    )

    await Deno.writeTextFile(
      `${root}/deno.lock`,
      JSON.stringify({ npm: { 'example@1.2.3': { integrity } } }),
    )
    await Deno.writeTextFile(mappingPath, '[]')
    await assertRejects(
      () => materializeApplicationNotices(root),
      Error,
      'mapping output size differs',
    )

    await Deno.writeTextFile(mappingPath, JSON.stringify([[0, 1], [2, 3]]))
    await Deno.remove(
      `${root}/scripts/release/application-notices/evidence/unicode/table.txt`,
    )
    assertEquals(
      (await materializeApplicationNotices(root)).unresolvedActual,
      ['unicode:fixture@8.0.0'],
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('supplemented evidence rejects a changed source-text digest', async () => {
  const root = await fixture()
  try {
    await addSupplementedEvidence(root)
    await Deno.writeTextFile(
      `${root}/scripts/release/application-notices/evidence/npm/supplement.txt`,
      'tampered source text\n',
    )
    await assertRejects(
      () => materializeApplicationNotices(root),
      Error,
      'digest differs',
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('explicit acquisition accepts only the indexed primary bytes and leaves normal materialization offline', async () => {
  const root = await fixture()
  try {
    const evidence = `${root}/scripts/release/application-notices/evidence`
    await Deno.remove(evidence, { recursive: true })
    await acquireApplicationNoticeEvidence(root, async (source) => {
      const text = String(source).includes('jsr-license')
        ? 'jsr license text\n'
        : 'std license text\n'
      return new Response(text, { status: 200 })
    })
    assertEquals(
      await Deno.readTextFile(`${evidence}/jsr-license.txt`),
      'jsr license text\n',
    )
    assertEquals(
      (await materializeApplicationNotices(root)).unresolvedActual,
      [],
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('materializer retains recognized dual-license names and rejects source-code lookalikes', async () => {
  const root = await fixture()
  try {
    const npm = `${root}/node_modules/.deno/example@1.2.3/node_modules/example`
    await Deno.writeTextFile(`${npm}/LICENSE-MIT`, 'second legal text\n')
    await Deno.writeTextFile(`${npm}/COPYING-phase.h`, 'not legal text\n')
    await materializeApplicationNotices(root)
    const index = JSON.parse(
      await Deno.readTextFile(
        `${root}/dist/release-inputs/license-evidence.json`,
      ),
    ) as { components: Array<{ namespace: string; files: string[] }> }
    assertEquals(
      index.components.find((component) => component.namespace === 'npm')?.files
        .length,
      2,
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})
