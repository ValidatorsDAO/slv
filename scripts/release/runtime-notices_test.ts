import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1'
import {
  buildRuntimeNotices,
  containsFullLicenseText,
  RUNTIME_NOTICE_TARGETS,
} from './runtime-notices.ts'

const digest = async (text: string) => {
  const bytes = new TextEncoder().encode(text)
  const value = await crypto.subtle.digest(
    'SHA-256',
    bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
  )
  return [...new Uint8Array(value)].map((byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')
}

async function fixture(): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: 'slv-runtime-notices-' })
  const files: Record<string, string> = {
    'evidence/deno/Cargo.lock': 'locked packages\\n',
    'evidence/deno/LICENSE.md': 'Deno MIT\\n',
    'evidence/rusty_v8/LICENSE': 'rusty_v8 MIT\\n',
    'evidence/v8/LICENSE': 'V8 BSD and native supplier list\\n',
    'evidence/extra/NOTICE': 'extra native notice\\n',
  }
  for (const [path, content] of Object.entries(files)) {
    await Deno.mkdir(`${root}/${path.slice(0, path.lastIndexOf('/'))}`, {
      recursive: true,
    })
    await Deno.writeTextFile(`${root}/${path}`, content)
  }
  const component = async (
    name: string,
    files: string[],
    inclusion_basis: 'actual-shipped' | 'conservative-extra' = 'actual-shipped',
    version = '1.0.0',
  ) => ({
    component: name,
    version,
    immutable_source: `https://example.invalid/${name}`,
    source_pin: 'a'.repeat(40),
    files: await Promise.all(
      files.map(async (path) => ({
        path,
        sha256: await digest(
          files === undefined ? '' : await Deno.readTextFile(`${root}/${path}`),
        ),
      })),
    ),
    target_coverage: [...RUNTIME_NOTICE_TARGETS],
    inclusion_basis,
  })
  const index = {
    schema_version: 1,
    generator: 'scripts/release/runtime-notices.ts',
    runtime: {
      component: 'deno',
      version: '2.9.3',
      cargo_lock: {
        path: 'evidence/deno/Cargo.lock',
        sha256: await digest(files['evidence/deno/Cargo.lock']),
      },
    },
    components: [
      await component('v8', ['evidence/v8/LICENSE', 'evidence/extra/NOTICE']),
      await component('deno', ['evidence/deno/LICENSE.md']),
      await component(
        'rusty_v8',
        ['evidence/rusty_v8/LICENSE'],
        'conservative-extra',
        '149.4.0',
      ),
    ],
  }
  const closure = {
    schema_version: 1,
    deno_source_commit: 'b'.repeat(40),
    cargo_lock_sha256: index.runtime.cargo_lock.sha256,
    roots: ['denort@2.9.3'],
    dependency_kinds: 'normal (kind = null only)',
    command:
      'cargo metadata --locked --format-version 1 --filter-platform <target>',
    target_metadata: RUNTIME_NOTICE_TARGETS.map((target) => ({
      target,
      sha256: 'c'.repeat(64),
    })),
    packages: [{
      package: 'fixture@1.0.0',
      target_coverage: [...RUNTIME_NOTICE_TARGETS],
      notice_component: 'deno@1.0.0',
    }],
    required_components: ['deno@1.0.0', 'v8@1.0.0'],
  }
  const closurePath = 'evidence/closure.json'
  const closureText = JSON.stringify(closure, null, 2) + '\n'
  await Deno.writeTextFile(`${root}/${closurePath}`, closureText)
  ;(index.runtime as Record<string, unknown>).closure = {
    path: closurePath,
    sha256: await digest(closureText),
  }
  await Deno.writeTextFile(
    `${root}/evidence-index.json`,
    JSON.stringify(index, null, 2),
  )
  return root
}

async function indexAt(root: string): Promise<Record<string, unknown>> {
  return JSON.parse(await Deno.readTextFile(`${root}/evidence-index.json`))
}

async function writeIndex(root: string, index: unknown): Promise<void> {
  await Deno.writeTextFile(
    `${root}/evidence-index.json`,
    JSON.stringify(index, null, 2),
  )
}

type FixtureIndex = {
  runtime: Record<string, unknown>
  components: Array<Record<string, unknown>>
}

async function addQualifiedSourceVendor(
  root: string,
): Promise<{
  index: FixtureIndex
  paths: {
    terms: string
    mapping: string
    qualification: string
    coverage: string
  }
  coverage: Record<string, unknown>
}> {
  const index = await indexAt(root) as unknown as FixtureIndex
  const lock = [
    'version = 4',
    '',
    '[[package]]',
    'name = "v8"',
    'version = "149.4.0"',
    'source = "registry+https://github.com/rust-lang/crates.io-index"',
    `checksum = "${'f'.repeat(64)}"`,
    '',
    '[[package]]',
    'name = "source-only"',
    'version = "1.0.0"',
    'source = "registry+https://github.com/rust-lang/crates.io-index"',
    `checksum = "${'e'.repeat(64)}"`,
    '',
  ].join('\n')
  await Deno.writeTextFile(`${root}/evidence/deno/Cargo.lock`, lock)
  index.runtime.cargo_lock = {
    path: 'evidence/deno/Cargo.lock',
    sha256: await digest(lock),
  }
  const closure = JSON.parse(
    await Deno.readTextFile(`${root}/evidence/closure.json`),
  ) as { cargo_lock_sha256: string }
  closure.cargo_lock_sha256 = (index.runtime.cargo_lock as { sha256: string })
    .sha256
  const closureText = JSON.stringify(closure, null, 2) + '\n'
  await Deno.writeTextFile(`${root}/evidence/closure.json`, closureText)
  index.runtime.closure = {
    path: 'evidence/closure.json',
    sha256: await digest(closureText),
  }
  const paths = {
    terms: 'evidence/vendor/LICENSE',
    mapping: 'evidence/vendor/mapping.json',
    qualification: 'evidence/vendor/qualification.json',
    coverage: 'evidence/source-vendor-coverage.json',
  }
  const contents = {
    [paths.terms]: 'Vendor Apache notice\n',
    [paths.mapping]: '{"files":72}\n',
    [paths.qualification]: '{"status":"qualified"}\n',
  }
  for (const [path, content] of Object.entries(contents)) {
    await Deno.mkdir(`${root}/${path.slice(0, path.lastIndexOf('/'))}`, {
      recursive: true,
    })
    await Deno.writeTextFile(`${root}/${path}`, content)
  }
  const files = [
    { path: paths.terms, sha256: await digest(contents[paths.terms]) },
    {
      path: paths.mapping,
      sha256: await digest(contents[paths.mapping]),
      role: 'source-material',
    },
    {
      path: paths.qualification,
      sha256: await digest(contents[paths.qualification]),
      role: 'source-material',
    },
  ]
  const component = {
    component: 'cargo:source-only',
    version: '1.0.0',
    immutable_source: `https://example.invalid/${'d'.repeat(40)}`,
    source_pin: 'd'.repeat(40),
    archive: {
      url:
        'https://static.crates.io/crates/source-only/source-only-1.0.0.crate',
      sha256: 'e'.repeat(64),
    },
    files,
    target_coverage: [],
    inclusion_basis: 'source-vendor',
  }
  index.components.push(component)
  const coverage: Record<string, unknown> = {
    schema_version: 1,
    cargo_lock_sha256: (index.runtime.cargo_lock as { sha256: string }).sha256,
    disposition: 'complete-with-qualification',
    v8_native_mapping: {
      cargo_package: 'v8@149.4.0',
      component: 'rusty_v8@149.4.0',
      source_pin: 'a'.repeat(40),
    },
    resolved_identities: [{
      package: 'source-only@1.0.0',
      component: 'cargo:source-only@1.0.0',
      source_pin: 'd'.repeat(40),
      archive: component.archive,
      evidence: files,
    }],
    qualifications: [{
      component: 'cargo:source-only@1.0.0',
      classification: 'historical-license-scope-inference',
      source_file_count: 72,
      webgl_xml_file_count: 55,
      direct_later_license_linked: 47,
      historical_scope_inference_paths: [
        'extensions/a.xml',
        'extensions/b.xml',
        'extensions/c.xml',
        'extensions/d.xml',
        'extensions/e.xml',
        'extensions/f.xml',
        'extensions/g.xml',
        'extensions/h.xml',
      ],
      receipt: files[2],
    }],
  }
  await writeCoverage(root, index, paths.coverage, coverage)
  return { index, paths, coverage }
}

async function writeCoverage(
  root: string,
  index: FixtureIndex,
  path: string,
  coverage: Record<string, unknown>,
): Promise<void> {
  const text = JSON.stringify(coverage, null, 2) + '\n'
  await Deno.writeTextFile(`${root}/${path}`, text)
  index.runtime.source_vendor_coverage = {
    path,
    sha256: await digest(text),
    role: 'source-material',
  }
  index.runtime.selected_lock_coverage = {
    path,
    sha256: await digest(text),
    role: 'source-material',
  }
  await writeIndex(root, index)
}

Deno.test('buildRuntimeNotices emits all notices deterministically with inclusion basis and four-target coverage', async () => {
  const root = await fixture()
  try {
    const first = await buildRuntimeNotices(root)
    assertEquals(first.unresolvedRequired, [])
    assertEquals(first.unresolvedConservative, [])
    assert(first.text.includes('V8 BSD and native supplier list'))
    assert(first.text.includes('extra native notice'))
    assert(first.text.includes('Inclusion basis: actual-shipped'))
    assert(first.text.includes('Inclusion basis: conservative-extra'))
    const index = await indexAt(root) as { components: unknown[] }
    index.components.reverse()
    await writeIndex(root, index)
    assertEquals((await buildRuntimeNotices(root)).text, first.text)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('buildRuntimeNotices makes required gaps blocking and conservative gaps informational', async () => {
  const root = await fixture()
  try {
    await Deno.writeTextFile(`${root}/evidence/v8/LICENSE`, 'tampered\\n')
    const tampered = await buildRuntimeNotices(root)
    assert(
      tampered.unresolvedRequired.some((item) =>
        item.includes('digest mismatch: evidence/v8/LICENSE')
      ),
    )
    assertEquals(tampered.unresolved, tampered.unresolvedRequired)
    await Deno.writeTextFile(
      `${root}/evidence/v8/LICENSE`,
      'V8 BSD and native supplier list\\n',
    )
    await Deno.writeTextFile(
      `${root}/evidence/rusty_v8/LICENSE`,
      'tampered conservative\\n',
    )
    const conservative = await buildRuntimeNotices(root)
    assertEquals(conservative.unresolvedRequired, [])
    assert(
      conservative.unresolvedConservative.some((item) =>
        item.includes('digest mismatch: evidence/rusty_v8/LICENSE')
      ),
    )
    await Deno.writeTextFile(`${root}/evidence/extra/NOTICE`, '')
    await Deno.remove(`${root}/evidence/deno/LICENSE.md`)
    const absent = await buildRuntimeNotices(root)
    assert(
      absent.unresolvedRequired.some((item) =>
        item.includes('empty runtime notice evidence: evidence/extra/NOTICE')
      ),
    )
    assert(
      absent.unresolvedRequired.some((item) =>
        item.includes(
          'missing runtime notice evidence: evidence/deno/LICENSE.md',
        )
      ),
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('buildRuntimeNotices rejects an unpinned source or invalid target coverage', async () => {
  const root = await fixture()
  try {
    const index = await indexAt(root) as {
      components: Array<Record<string, unknown>>
    }
    index.components[0].source_pin = 'untrusted'
    await writeIndex(root, index)
    await assertRejects(
      () => buildRuntimeNotices(root),
      Error,
      'invalid runtime notice evidence index',
    )
    index.components[0].source_pin = 'a'.repeat(40)
    index.components[0].target_coverage = ['unsupported-target']
    await writeIndex(root, index)
    await assertRejects(
      () => buildRuntimeNotices(root),
      Error,
      'invalid runtime notice evidence index',
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('a closure-required component that is absent is a blocking gap', async () => {
  const root = await fixture()
  try {
    const index = await indexAt(root) as {
      runtime: { closure: { path: string; sha256: string } }
    }
    const closurePath = `${root}/${index.runtime.closure.path}`
    const closure = JSON.parse(await Deno.readTextFile(closurePath)) as {
      required_components: string[]
    }
    closure.required_components.push('missing-runtime-component@1.0.0')
    const closureText = JSON.stringify(closure, null, 2) + '\n'
    await Deno.writeTextFile(closurePath, closureText)
    index.runtime.closure.sha256 = await digest(closureText)
    await writeIndex(root, index)
    const result = await buildRuntimeNotices(root)
    assert(result.unresolvedRequired.includes(
      'required runtime component is not materialized: missing-runtime-component@1.0.0',
    ))
    assertEquals(result.unresolvedConservative, [])
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('a closure gap is not also reported as a Cargo-only conservative gap', async () => {
  const root = await fixture()
  try {
    const index = await indexAt(root) as {
      runtime: { closure: { path: string; sha256: string } }
      unresolved?: string[]
    }
    const closurePath = `${root}/${index.runtime.closure.path}`
    const closure = JSON.parse(await Deno.readTextFile(closurePath)) as {
      packages: Array<{
        package: string
        target_coverage: string[]
        notice_component: string
      }>
    }
    closure.packages[0] = {
      package: 'missing@1.0.0',
      target_coverage: [...RUNTIME_NOTICE_TARGETS],
      notice_component: 'cargo:missing@1.0.0',
    }
    const closureText = JSON.stringify(closure, null, 2) + '\n'
    await Deno.writeTextFile(closurePath, closureText)
    index.runtime.closure.sha256 = await digest(closureText)
    index.unresolved = [
      'conservative-extra:cargo:missing@1.0.0: LICENSE text not materialized',
    ]
    await writeIndex(root, index)
    const result = await buildRuntimeNotices(root)
    assert(result.unresolvedRequired.includes(
      'required denort closure package is not materialized: missing@1.0.0',
    ))
    assertEquals(result.unresolvedConservative, [])
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('source-vendor evidence is rendered without a denort target claim', async () => {
  const root = await fixture()
  try {
    await addQualifiedSourceVendor(root)
    const result = await buildRuntimeNotices(root)
    assertEquals(result.unresolvedRequired, [])
    assertEquals(result.unresolvedConservative, [])
    assertEquals(result.sourceVendorCoverage.complete, true)
    assertEquals(
      result.sourceVendorCoverage.disposition,
      'complete-with-qualification',
    )
    assertEquals(result.selectedLockCoverage.complete, true)
    assertEquals(result.selectedLockCoverage.registryPackageCount, 2)
    assertEquals(result.selectedLockCoverage.resolvedRegistryPackages, [
      'source-only@1.0.0',
    ])
    assert(result.text.includes('Inclusion basis: source-vendor'))
    assert(result.text.includes(
      'Scope: exact Cargo source-vendor archive; no denort binary-target inclusion claim',
    ))
    assert(result.text.includes(
      'Release archive: https://static.crates.io/crates/source-only/source-only-1.0.0.crate',
    ))
    assert(result.text.includes(`Release archive SHA-256: ${'e'.repeat(64)}`))
    assert(result.text.includes(
      'Materialized source-distribution notice coverage: complete-with-qualification',
    ))
    assert(!result.text.includes('Target coverage: \n'))
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('source-vendor coverage becomes incomplete when terms, mapping, hash, or qualification fails', async () => {
  const root = await fixture()
  try {
    const { index, paths, coverage } = await addQualifiedSourceVendor(root)
    const terms = 'Vendor Apache notice\n'
    const mapping = '{"files":72}\n'

    await Deno.remove(`${root}/${paths.terms}`)
    let result = await buildRuntimeNotices(root)
    assertEquals(result.sourceVendorCoverage.complete, false)
    assertEquals(result.selectedLockCoverage.complete, false)
    assert(
      result.sourceVendorCoverage.gaps.some((gap) =>
        gap.includes(`missing runtime notice evidence: ${paths.terms}`)
      ),
    )
    await Deno.writeTextFile(`${root}/${paths.terms}`, terms)

    await Deno.remove(`${root}/${paths.mapping}`)
    result = await buildRuntimeNotices(root)
    assertEquals(result.sourceVendorCoverage.complete, false)
    assertEquals(result.selectedLockCoverage.complete, false)
    assert(
      result.sourceVendorCoverage.gaps.some((gap) =>
        gap.includes(`missing runtime notice evidence: ${paths.mapping}`)
      ),
    )
    await Deno.writeTextFile(`${root}/${paths.mapping}`, mapping)

    await Deno.writeTextFile(`${root}/${paths.terms}`, 'tampered\n')
    result = await buildRuntimeNotices(root)
    assertEquals(result.sourceVendorCoverage.complete, false)
    assertEquals(result.selectedLockCoverage.complete, false)
    assert(
      result.sourceVendorCoverage.gaps.some((gap) =>
        gap.includes(`digest mismatch: ${paths.terms}`)
      ),
    )
    await Deno.writeTextFile(`${root}/${paths.terms}`, terms)

    coverage.qualifications = []
    await writeCoverage(root, index, paths.coverage, coverage)
    result = await buildRuntimeNotices(root)
    assertEquals(result.sourceVendorCoverage.complete, false)
    assertEquals(result.selectedLockCoverage.complete, false)
    assert(
      result.sourceVendorCoverage.gaps.some((gap) =>
        gap.includes('invalid source-vendor coverage receipt')
      ),
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('selected Cargo coverage rejects an identity that is not bound to the lock', async () => {
  const root = await fixture()
  try {
    const { index, paths, coverage } = await addQualifiedSourceVendor(root)
    const identities = coverage.resolved_identities as Array<{
      archive: { sha256: string }
    }>
    identities[0].archive.sha256 = 'f'.repeat(64)
    await writeCoverage(root, index, paths.coverage, coverage)

    const result = await buildRuntimeNotices(root)
    assertEquals(result.sourceVendorCoverage.complete, false)
    assertEquals(result.selectedLockCoverage.complete, false)
    assert(
      result.selectedLockCoverage.gaps.some((gap) =>
        gap.includes('invalid source-vendor coverage receipt')
      ),
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('COPYING-looking source code cannot become a notice by filename', () => {
  const code = '// Copyright 2025\nclass CopyingPhase {}\n'
  assertEquals(
    containsFullLicenseText('v8/src/compiler/copying-phase.cc', code),
    false,
  )
  assertEquals(containsFullLicenseText('COPYING-PHASE.H', code), false)
  assertEquals(
    containsFullLicenseText(
      'LICENSE',
      'Permission is hereby granted, free of charge, to any person obtaining a copy.\nTHE SOFTWARE IS PROVIDED "AS IS".',
    ),
    true,
  )
  assertEquals(
    containsFullLicenseText(
      'COPYRIGHT',
      'Copyright (c) 2020 Example\n\nPermission is hereby granted, free of charge, to any person obtaining a copy.\nTHE SOFTWARE IS PROVIDED "AS IS".',
    ),
    true,
  )
})
