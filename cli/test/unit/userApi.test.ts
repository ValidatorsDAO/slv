import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from '@std/assert'

import { userApiAuthFromApiKey } from '/lib/userApi/auth.ts'
import { userApiRequest } from '/lib/userApi/client.ts'
import {
  deleteDnsRecord,
  explainDnsDeleteError,
  explainDnsSetError,
  getDnsStatus,
  requestOriginCert,
  setDnsRecord,
} from '/lib/userApi/dns.ts'
import { openSupportTicket } from '/lib/userApi/support.ts'
import {
  callReadTool,
  isReadToolFailure,
  READ_TOOLS,
} from '/lib/userApi/readTools.ts'
import { CONTEXT_MODULES } from '@/ai/console/systemPrompt.ts'
import { TOOL_DEFINITIONS } from '@/ai/console/tools.ts'

// ---------------------------------------------------------------------------
// fetch stubbing helper — every test swaps `globalThis.fetch` out and back in
// a try/finally so a failure in one test never leaks a stub into the next.
// ---------------------------------------------------------------------------

type FetchStub = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>

const withFetchStub = async (
  stub: FetchStub,
  fn: () => Promise<void>,
): Promise<void> => {
  const original = globalThis.fetch
  globalThis.fetch = stub as typeof fetch
  try {
    await fn()
  } finally {
    globalThis.fetch = original
  }
}

const jsonResponse = (
  body: unknown,
  init: ResponseInit = { status: 200 },
): Response => new Response(JSON.stringify(body), init)

// ---------------------------------------------------------------------------
// T1 — getDnsStatus: GET, Bearer header, no body
// ---------------------------------------------------------------------------

Deno.test('T1: getDnsStatus issues a GET to /v3/dns/status with a Bearer header and no body', async () => {
  let capturedUrl = ''
  let capturedInit: RequestInit | undefined
  await withFetchStub(
    async (input, init) => {
      capturedUrl = String(input)
      capturedInit = init
      return jsonResponse({
        default: {
          fqdn: 'u-abc.erpc.global',
          slug: 'u-abc',
          ip: '1.2.3.4',
          proxied: true,
          exists: true,
          updatedAt: null,
        },
        custom: [],
      })
    },
    async () => {
      const result = await getDnsStatus(userApiAuthFromApiKey('test-key'))
      assertEquals(result.ok, true)
    },
  )
  assertEquals(capturedUrl, 'https://user-api.erpc.global/v3/dns/status')
  assertEquals(capturedInit?.method, 'GET')
  const headers = new Headers(capturedInit?.headers)
  assertEquals(headers.get('Authorization'), 'Bearer test-key')
  assertEquals(capturedInit?.body, undefined)
})

// ---------------------------------------------------------------------------
// T2 — setDnsRecord: POST, JSON, only provided keys
// ---------------------------------------------------------------------------

Deno.test('T2: setDnsRecord POSTs JSON containing only the keys the caller provided', async () => {
  let capturedUrl = ''
  let capturedInit: RequestInit | undefined
  await withFetchStub(
    async (input, init) => {
      capturedUrl = String(input)
      capturedInit = init
      return jsonResponse({
        success: true,
        fqdn: 'u-abc.erpc.global',
        slug: 'u-abc',
        ip: '5.6.7.8',
        proxied: true,
        message: 'ok',
      })
    },
    async () => {
      const result = await setDnsRecord(userApiAuthFromApiKey('k'), {
        ip: '5.6.7.8',
      })
      assertEquals(result.ok, true)
    },
  )
  assertEquals(capturedUrl, 'https://user-api.erpc.global/v3/dns/set')
  assertEquals(capturedInit?.method, 'POST')
  const headers = new Headers(capturedInit?.headers)
  assertEquals(headers.get('Content-Type'), 'application/json')
  assertEquals(headers.get('Authorization'), 'Bearer k')
  assertEquals(JSON.parse(String(capturedInit?.body)), { ip: '5.6.7.8' })
})

// ---------------------------------------------------------------------------
// T3 — 403 ip_not_owned keeps today's guidance text
// ---------------------------------------------------------------------------

Deno.test('T3: explainDnsSetError returns the ip_not_owned guidance text on a 403', async () => {
  await withFetchStub(
    async () => jsonResponse({ error: 'ip_not_owned' }, { status: 403 }),
    async () => {
      const result = await setDnsRecord(userApiAuthFromApiKey('k'), {
        ip: '1.1.1.1',
      })
      assertEquals(result.ok, false)
      if (!result.ok) {
        assertEquals(
          explainDnsSetError(result),
          'The detected IP is not registered against your account. Register the VPS in erpc first, or pass --ip <owned-ip>.',
        )
      }
    },
  )
})

// ---------------------------------------------------------------------------
// T4 — input-validation 400 with an object `error` is normalized away
// ---------------------------------------------------------------------------

Deno.test('T4: a 400 with an object error field drops body.error and falls back to Bad request.', async () => {
  await withFetchStub(
    async () =>
      jsonResponse(
        { success: false, error: { issues: ['ip required'] } },
        { status: 400 },
      ),
    async () => {
      const result = await setDnsRecord(userApiAuthFromApiKey('k'), {
        ip: '1.1.1.1',
      })
      assertEquals(result.ok, false)
      if (!result.ok) {
        assertEquals(result.body?.error, undefined)
        assertEquals(explainDnsSetError(result), 'Bad request.')
      }
    },
  )
})

// ---------------------------------------------------------------------------
// T5 — 401 always means "run `slv login`"
// ---------------------------------------------------------------------------

Deno.test('T5: a 401 with {error: "Unauthorized"} maps to the slv login guidance', async () => {
  await withFetchStub(
    async () => jsonResponse({ error: 'Unauthorized' }, { status: 401 }),
    async () => {
      const result = await setDnsRecord(userApiAuthFromApiKey('k'), {
        ip: '1.1.1.1',
      })
      assertEquals(result.ok, false)
      if (!result.ok) {
        assertStringIncludes(explainDnsSetError(result), 'slv login')
      }
    },
  )
})

// ---------------------------------------------------------------------------
// T6 — deleteDnsRecord with a slug fires exactly one DELETE
// ---------------------------------------------------------------------------

Deno.test('T6: deleteDnsRecord with an explicit slug issues exactly one DELETE', async () => {
  let callCount = 0
  let capturedUrl = ''
  let capturedInit: RequestInit | undefined
  await withFetchStub(
    async (input, init) => {
      callCount++
      capturedUrl = String(input)
      capturedInit = init
      return jsonResponse({
        success: true,
        fqdn: 'x.erpc.global',
        message: 'deleted',
      })
    },
    async () => {
      const result = await deleteDnsRecord(userApiAuthFromApiKey('k'), {
        slug: 'myslug',
      })
      assertEquals(result.ok, true)
    },
  )
  assertEquals(callCount, 1)
  assertEquals(capturedUrl, 'https://user-api.erpc.global/v3/dns/delete')
  assertEquals(capturedInit?.method, 'DELETE')
  const headers = new Headers(capturedInit?.headers)
  assertEquals(headers.get('Content-Type'), 'application/json')
  assertEquals(JSON.parse(String(capturedInit?.body)), { slug: 'myslug' })
})

// ---------------------------------------------------------------------------
// T7 — deleteDnsRecord without a slug resolves it from status first;
// a failed status read never reaches DELETE
// ---------------------------------------------------------------------------

Deno.test('T7a: deleteDnsRecord without a slug reads status first, then DELETEs with default.slug', async () => {
  const calls: string[] = []
  let deleteBody = ''
  await withFetchStub(
    async (input, init) => {
      const method = String(init?.method ?? 'GET')
      calls.push(`${method} ${String(input)}`)
      if (String(input).endsWith('/v3/dns/status')) {
        return jsonResponse({
          default: {
            fqdn: 'u-def.erpc.global',
            slug: 'u-def',
            ip: '1.2.3.4',
            proxied: true,
            exists: true,
            updatedAt: null,
          },
          custom: [],
        })
      }
      deleteBody = String(init?.body ?? '')
      return jsonResponse({
        success: true,
        fqdn: 'u-def.erpc.global',
        message: 'deleted',
      })
    },
    async () => {
      const result = await deleteDnsRecord(userApiAuthFromApiKey('k'), {})
      assertEquals(result.ok, true)
    },
  )
  assertEquals(calls, [
    'GET https://user-api.erpc.global/v3/dns/status',
    'DELETE https://user-api.erpc.global/v3/dns/delete',
  ])
  // Pins the actual field used, not just that *a* DELETE happened —
  // a mutant that reads `default.fqdn` instead of `default.slug`
  // left this test green before this assert existed.
  assertEquals(JSON.parse(deleteBody), { slug: 'u-def' })
})

Deno.test('T7b: deleteDnsRecord never DELETEs when the status read fails', async () => {
  let deleteCalled = false
  await withFetchStub(
    async (_input, init) => {
      if (String(init?.method ?? 'GET') === 'DELETE') deleteCalled = true
      return jsonResponse({ error: 'Unauthorized' }, { status: 401 })
    },
    async () => {
      const result = await deleteDnsRecord(userApiAuthFromApiKey('k'), {})
      assertEquals(result.ok, false)
    },
  )
  assertEquals(deleteCalled, false)
})

// ---------------------------------------------------------------------------
// T8 — delete 404 no_record surfaces the server's message
// ---------------------------------------------------------------------------

Deno.test('T8: deleteDnsRecord 404 no_record surfaces the server message', async () => {
  await withFetchStub(
    async () =>
      jsonResponse(
        { error: 'no_record', message: 'No record found for that slug.' },
        { status: 404 },
      ),
    async () => {
      const result = await deleteDnsRecord(userApiAuthFromApiKey('k'), {
        slug: 'gone',
      })
      assertEquals(result.ok, false)
      if (!result.ok) {
        assertEquals(
          explainDnsDeleteError(result),
          'No record found for that slug.',
        )
      }
    },
  )
})

// ---------------------------------------------------------------------------
// T9 — origin-cert: 404 + non-JSON body => not_available; 502 + JSON => error
// ---------------------------------------------------------------------------

Deno.test('T9a: requestOriginCert treats a 404 with a non-JSON body as not_available', async () => {
  let capturedUrl = ''
  let capturedInit: RequestInit | undefined
  await withFetchStub(
    async (input, init) => {
      capturedUrl = String(input)
      capturedInit = init
      return new Response('Not Found', { status: 404 })
    },
    async () => {
      const result = await requestOriginCert(userApiAuthFromApiKey('k'), {
        csr: 'csr-pem',
      })
      assertEquals(result.ok, false)
      if (!result.ok) assertEquals(result.kind, 'not_available')
    },
  )
  assertEquals(capturedUrl, 'https://user-api.erpc.global/v3/dns/origin-cert')
  assertEquals(capturedInit?.method, 'POST')
  assertEquals(JSON.parse(String(capturedInit?.body)), { csr: 'csr-pem' })
})

Deno.test('T9b: requestOriginCert surfaces a 502 with a JSON body as a typed error', async () => {
  await withFetchStub(
    async () =>
      jsonResponse({ error: 'upstream_unreachable' }, { status: 502 }),
    async () => {
      const result = await requestOriginCert(userApiAuthFromApiKey('k'), {
        csr: 'csr-pem',
      })
      assertEquals(result.ok, false)
      if (!result.ok) {
        assertEquals(result.kind, 'error')
        if (result.kind === 'error') assertEquals(result.status, 502)
      }
    },
  )
})

// ---------------------------------------------------------------------------
// T10 — support ticket: link is trimmed; 403 error = server message
// ---------------------------------------------------------------------------

Deno.test('T10a: openSupportTicket trims the returned link', async () => {
  let capturedUrl = ''
  let capturedInit: RequestInit | undefined
  await withFetchStub(
    async (input, init) => {
      capturedUrl = String(input)
      capturedInit = init
      return jsonResponse({
        success: true,
        message: 'chan-1',
        link: '  https://discord.com/channels/1/2  ',
      })
    },
    async () => {
      const result = await openSupportTicket(userApiAuthFromApiKey('k'), {
        title: 't',
        description: 'd',
      })
      assertEquals(result.ok, true)
      if (result.ok) {
        assertEquals(result.link, 'https://discord.com/channels/1/2')
      }
    },
  )
  assertEquals(
    capturedUrl,
    'https://user-api.erpc.global/v3/user/support/ticket',
  )
  assertEquals(capturedInit?.method, 'POST')
  assertEquals(JSON.parse(String(capturedInit?.body)), {
    title: 't',
    description: 'd',
  })
})

Deno.test('T10b: openSupportTicket 403 surfaces the server message as error', async () => {
  await withFetchStub(
    async () =>
      jsonResponse(
        {
          success: false,
          message: 'Forbidden for this account.',
          errorCode: 'blocked',
        },
        { status: 403 },
      ),
    async () => {
      const result = await openSupportTicket(userApiAuthFromApiKey('k'), {
        title: 't',
        description: 'd',
      })
      assertEquals(result.ok, false)
      if (!result.ok) {
        assertEquals(result.error, 'Forbidden for this account.')
      }
    },
  )
})

// ---------------------------------------------------------------------------
// T11 — 5xx non-JSON body => body null + raw text; a fetch rejection
// propagates instead of being swallowed
// ---------------------------------------------------------------------------

Deno.test('T11a: a 5xx with a non-JSON body yields body null and the raw text', async () => {
  await withFetchStub(
    async () => new Response('upstream exploded', { status: 503 }),
    async () => {
      const result = await userApiRequest(
        userApiAuthFromApiKey('k'),
        'GET',
        '/v3/dns/status',
      )
      assertEquals(result.ok, false)
      if (!result.ok) {
        assertEquals(result.body, null)
        assertEquals(result.raw, 'upstream exploded')
      }
    },
  )
})

Deno.test('T11b: a fetch rejection propagates instead of being swallowed', async () => {
  await withFetchStub(
    async () => {
      throw new Error('network down')
    },
    async () => {
      await assertRejects(
        () =>
          userApiRequest(userApiAuthFromApiKey('k'), 'GET', '/v3/dns/status'),
        Error,
        'network down',
      )
    },
  )
})

// ---------------------------------------------------------------------------
// T12 — readTools: unknown names, path encoding, missing/unsafe path
// values, GET-only table, failure formatting
// ---------------------------------------------------------------------------

Deno.test('T12a: callReadTool returns "Unknown tool" for an unrecognized name without fetching', async () => {
  let fetchCalled = false
  await withFetchStub(
    async () => {
      fetchCalled = true
      return new Response('{}', { status: 200 })
    },
    async () => {
      const result = await callReadTool(
        userApiAuthFromApiKey('k'),
        'get_not_a_tool',
        {},
      )
      assertEquals(result, 'Unknown tool: get_not_a_tool')
    },
  )
  assertEquals(fetchCalled, false)
})

Deno.test('T12b: callReadTool encodes path args and sends declared args as query params', async () => {
  let capturedUrl = ''
  let capturedInit: RequestInit | undefined
  await withFetchStub(
    async (input, init) => {
      capturedUrl = String(input)
      capturedInit = init
      return new Response('{}', { status: 200 })
    },
    async () => {
      // This route declares `limit`/`cursor` as query params (unlike
      // its parent `get_support_chat_rooms_chat_room_id`, which takes
      // none) — exercises both path encoding and the query allowlist
      // in one call.
      const result = await callReadTool(
        userApiAuthFromApiKey('k'),
        'get_support_chat_rooms_chat_room_id_messages',
        { chatRoomId: 'room/with spaces', limit: 10 },
      )
      assertEquals(result, '{}')
    },
  )
  const url = new URL(capturedUrl)
  assertEquals(
    url.pathname,
    '/v3/support-chat/rooms/room%2Fwith%20spaces/messages',
  )
  assertEquals(url.searchParams.get('limit'), '10')
  assertEquals(capturedInit?.method, 'GET')
  const headers = new Headers(capturedInit?.headers)
  assertEquals(headers.get('Authorization'), 'Bearer k')
})

Deno.test('T12c: callReadTool does not fetch when a required path argument is missing', async () => {
  let fetchCalled = false
  await withFetchStub(
    async () => {
      fetchCalled = true
      return new Response('{}', { status: 200 })
    },
    async () => {
      const result = await callReadTool(
        userApiAuthFromApiKey('k'),
        'get_support_chat_rooms_chat_room_id',
        {},
      )
      assertStringIncludes(result, 'chatRoomId')
    },
  )
  assertEquals(fetchCalled, false)
})

Deno.test('T12d: callReadTool refuses empty, dot, and encoded dot-segment path values', async () => {
  for (const bad of ['', '.', '..', '%2e%2e']) {
    let fetchCalled = false
    await withFetchStub(
      async () => {
        fetchCalled = true
        return new Response('{}', { status: 200 })
      },
      async () => {
        const result = await callReadTool(
          userApiAuthFromApiKey('k'),
          'get_support_chat_rooms_chat_room_id',
          { chatRoomId: bad },
        )
        assertStringIncludes(result, 'chatRoomId')
      },
    )
    assertEquals(
      fetchCalled,
      false,
      `expected no fetch for chatRoomId=${JSON.stringify(bad)}`,
    )
  }
})

Deno.test('T12e: every entry in the read tools table is GET', () => {
  for (const [name, entry] of Object.entries(READ_TOOLS)) {
    assertEquals(entry.method, 'GET', `${name} must be GET`)
  }
})

Deno.test('T12f: callReadTool formats a failed response as "Request failed (...)."', async () => {
  await withFetchStub(
    async () =>
      new Response('{"error":"boom"}', {
        status: 500,
        statusText: 'Internal Server Error',
      }),
    async () => {
      const result = await callReadTool(
        userApiAuthFromApiKey('k'),
        'get_user_get',
        {},
      )
      assertEquals(
        result,
        'Request failed (500 Internal Server Error).\n{"error":"boom"}',
      )
    },
  )
})

Deno.test('callReadTool treats inherited property names as unknown tools, not a crash', async () => {
  let fetchCalled = false
  await withFetchStub(
    async () => {
      fetchCalled = true
      return new Response('{}', { status: 200 })
    },
    async () => {
      for (const name of ['constructor', 'toString', 'hasOwnProperty']) {
        const result = await callReadTool(userApiAuthFromApiKey('k'), name, {})
        assertEquals(result, `Unknown tool: ${name}`)
      }
    },
  )
  assertEquals(fetchCalled, false)
})

Deno.test('callReadTool rejects an argument not declared for that route, without fetching', async () => {
  let fetchCalled = false
  await withFetchStub(
    async () => {
      fetchCalled = true
      return new Response('{}', { status: 200 })
    },
    async () => {
      // get_user_get declares no query params at all.
      const result = await callReadTool(
        userApiAuthFromApiKey('k'),
        'get_user_get',
        { region: 'amsterdam' },
      )
      assertStringIncludes(result, 'region')
    },
  )
  assertEquals(fetchCalled, false)
})

Deno.test('callReadTool passes through a query argument the route declares', async () => {
  let capturedUrl = ''
  await withFetchStub(
    async (input) => {
      capturedUrl = String(input)
      return new Response('{}', { status: 200 })
    },
    async () => {
      const result = await callReadTool(
        userApiAuthFromApiKey('k'),
        'get_ai_usage',
        { boost: true },
      )
      assertEquals(result, '{}')
    },
  )
  const url = new URL(capturedUrl)
  assertEquals(url.searchParams.get('boost'), 'true')
})

Deno.test('callReadTool passes through the token query param on the avatar route', async () => {
  // The avatar route's `token` is a real query param the route reads
  // (tokened avatar URLs carry `?token=…` and 404 without it), even
  // though it isn't declared on the path itself.
  let capturedUrl = ''
  await withFetchStub(
    async (input) => {
      capturedUrl = String(input)
      return new Response('{}', { status: 200 })
    },
    async () => {
      const result = await callReadTool(
        userApiAuthFromApiKey('k'),
        'get_user_profile_avatar_user_id_file_name',
        { userId: 'u1', fileName: 'avatar.png', token: 'tok123' },
      )
      assertEquals(result, '{}')
    },
  )
  const url = new URL(capturedUrl)
  assertEquals(url.pathname, '/v3/user/profile/avatar/u1/avatar.png')
  assertEquals(url.searchParams.get('token'), 'tok123')
})

Deno.test('isReadToolFailure identifies every callReadTool failure shape and nothing else', () => {
  assertEquals(isReadToolFailure('Unknown tool: get_not_a_tool'), true)
  assertEquals(
    isReadToolFailure('Invalid or missing path argument: chatRoomId'),
    true,
  )
  assertEquals(
    isReadToolFailure('Unknown argument for get_user_get: region'),
    true,
  )
  assertEquals(
    isReadToolFailure('Request failed (500 Internal Server Error).\n{}'),
    true,
  )
  assertEquals(isReadToolFailure('{"id":"u-1","email":"a@b.com"}'), false)
  assertEquals(isReadToolFailure(''), false)
})

// ---------------------------------------------------------------------------
// A 2xx response with a non-JSON body is a failure (parse_error), never
// `{ ok: true, data: null }` — a null `data` crashes any caller that
// destructures it immediately, as openSupportTicket and deleteDnsRecord do.
// ---------------------------------------------------------------------------

Deno.test('userApiRequest treats a 2xx non-JSON body as a parse_error failure', async () => {
  await withFetchStub(
    async () => new Response('<html>ok</html>', { status: 200 }),
    async () => {
      const result = await userApiRequest(
        userApiAuthFromApiKey('k'),
        'GET',
        '/v3/dns/status',
      )
      assertEquals(result.ok, false)
      if (!result.ok) {
        assertEquals(result.body?.error, 'parse_error')
        assertEquals(result.raw, '<html>ok</html>')
      }
    },
  )
})

Deno.test('openSupportTicket returns a failure, not a throw, on a 200 non-JSON body', async () => {
  await withFetchStub(
    async () => new Response('<html>ok</html>', { status: 200 }),
    async () => {
      const result = await openSupportTicket(userApiAuthFromApiKey('k'), {
        title: 't',
        description: 'd',
      })
      assertEquals(result.ok, false)
    },
  )
})

Deno.test('deleteDnsRecord with a slug returns a failure, not a throw, on a 200 non-JSON body', async () => {
  await withFetchStub(
    async () => new Response('<html>ok</html>', { status: 200 }),
    async () => {
      const result = await deleteDnsRecord(userApiAuthFromApiKey('k'), {
        slug: 'x',
      })
      assertEquals(result.ok, false)
    },
  )
})

// ---------------------------------------------------------------------------
// T13 — every AGENT.md / SKILL.md under oss-skills/ and dist/oss-skills/,
// systemPrompt's mcp_reference, and the call_mcp tool schema itself only
// name tools that exist in the read tools table. The doc list is derived
// from the tree (not hand-picked), so a new or renamed skill doc is
// covered automatically.
// ---------------------------------------------------------------------------

const repoRoot = new URL('../../../', import.meta.url)
const repoRootPath = repoRoot.pathname

const SKILL_DOC_NAMES = new Set(['AGENT.md', 'SKILL.md'])

// Recursively collects every AGENT.md / SKILL.md under `dirPath`. Returns
// [] for a directory that doesn't exist rather than throwing, so a tree
// rename shows up as "0 docs found" (caught by the assert below) instead
// of a confusing stack trace.
const findSkillDocs = async (dirPath: string): Promise<string[]> => {
  let entries: Deno.DirEntry[]
  try {
    entries = []
    for await (const entry of Deno.readDir(dirPath)) entries.push(entry)
  } catch {
    return []
  }
  const found: string[] = []
  for (const entry of entries) {
    const childPath = `${dirPath}/${entry.name}`
    if (entry.isDirectory) {
      found.push(...(await findSkillDocs(childPath)))
    } else if (entry.isFile && SKILL_DOC_NAMES.has(entry.name)) {
      found.push(childPath)
    }
  }
  return found
}

// Matches `get_foo_bar`, `post_foo`, `delete_foo` style identifiers —
// the naming convention every call_mcp tool name follows. Path segments
// in docs use hyphens (`/v3/billing/get-product-by-product-id`), so they
// never collide with this underscore-only pattern.
const TOOL_NAME_RE = /\b(?:get|post|delete)_[a-z0-9]+(?:_[a-z0-9]+)*\b/g

const extractToolNames = (text: string): string[] =>
  Array.from(new Set(text.match(TOOL_NAME_RE) ?? []))

type CallMcpToolShape = {
  name: string
  description: string
  parameters: { properties?: { tool_name?: { description?: string } } }
}

// The `call_mcp` schema text the model reads on every turn, before
// `mcp_reference` is ever loaded. Covering it here catches this text
// drifting out of sync with `mcp_reference` (e.g. naming a tool that
// isn't in the read table) instead of letting it go unnoticed.
const callMcpSchemaText = (): string => {
  const def = (TOOL_DEFINITIONS as CallMcpToolShape[]).find((t) =>
    t.name === 'call_mcp'
  )
  assert(def, 'expected tools.ts to define a call_mcp tool')
  const toolNameDescription = def.parameters.properties?.tool_name
    ?.description ?? ''
  return `${def.description}\n${toolNameDescription}`
}

// Every place a model reads tool names or example arguments from:
// every AGENT.md/SKILL.md under oss-skills/ and dist/oss-skills/ (found
// by walking the tree, not a hand-picked list), systemPrompt's
// mcp_reference, and the call_mcp tool schema itself. Shared by every
// test below that scans these sources for something that should agree
// with the read tools table.
const collectPromptSources = async (): Promise<Record<string, string>> => {
  const docPaths = [
    ...await findSkillDocs(`${repoRootPath}oss-skills`),
    ...await findSkillDocs(`${repoRootPath}dist/oss-skills`),
  ]
  assert(
    docPaths.length > 0,
    'expected to find at least one AGENT.md/SKILL.md under oss-skills/ or dist/oss-skills/ — tree walk found none',
  )

  const sources: Record<string, string> = {
    'systemPrompt.mcp_reference': CONTEXT_MODULES.mcp_reference,
    'tools.ts call_mcp schema': callMcpSchemaText(),
  }
  for (const docPath of docPaths) {
    sources[docPath.slice(repoRootPath.length)] = Deno.readTextFileSync(
      docPath,
    )
  }
  return sources
}

Deno.test('T13: every oss-skills/dist skill doc, mcp_reference, and the call_mcp schema only name tools in the read table', async () => {
  const sources = await collectPromptSources()
  for (const [label, text] of Object.entries(sources)) {
    for (const name of extractToolNames(text)) {
      assert(name in READ_TOOLS, `${label} references unknown tool: ${name}`)
    }
  }
})

// ---------------------------------------------------------------------------
// Documented `nodeType` values must stay inside the set the route
// actually accepts (APP / MV / RPC / LG / UT / all — same list AGENT.md
// gives). A premium/top-tier suffix like `MV+` reads as a plausible
// value in prose but returns 400 from user-api.
// ---------------------------------------------------------------------------

// Matches AGENT.md's own list (`{nodeType: "APP" | "MV" | "RPC" | "LG" | "UT" | "all"}`)
// so a change there updates this test's source of truth automatically
// instead of needing a second hand-maintained list.
const NODE_TYPE_ENUM_SOURCE = (() => {
  const agentMd = Deno.readTextFileSync(
    new URL('oss-skills/slv-server-procurement/AGENT.md', repoRoot),
  )
  const match = agentMd.match(
    /nodeType:\s*((?:"[A-Za-z]+"\s*\|\s*)*"[A-Za-z]+")/,
  )
  assert(
    match,
    'expected oss-skills/slv-server-procurement/AGENT.md to document the nodeType enum',
  )
  return match[1]
})()

const VALID_NODE_TYPES = new Set(
  Array.from(NODE_TYPE_ENUM_SOURCE.matchAll(/"([A-Za-z]+)"/g), (m) => m[1]),
)

// `nodeType: "APP"` / `nodeType: 'MV'` as used in call_mcp argument
// examples. `<TYPE>` placeholders don't match (no closing quote around
// a bare word starting with `<`).
const NODE_TYPE_ARG_RE = /nodeType:\s*["']([A-Za-z0-9+]+)["']/g

// A markdown table whose header row mentions `nodeType`, reading
// backtick-quoted values out of each row's first cell until the table
// ends (a line that no longer starts with `|`).
const extractNodeTypeTableValues = (text: string): string[] => {
  const lines = text.split('\n')
  const values: string[] = []
  for (let i = 0; i < lines.length; i++) {
    if (!/\|\s*nodetype\s*\|/i.test(lines[i])) continue
    for (
      let j = i + 2;
      j < lines.length && lines[j].trimStart().startsWith('|');
      j++
    ) {
      const cell = lines[j].match(/\|\s*`([^`]+)`/)
      if (cell) values.push(cell[1])
    }
  }
  return values
}

const extractNodeTypeValues = (text: string): string[] => [
  ...Array.from(text.matchAll(NODE_TYPE_ARG_RE), (m) => m[1]),
  ...extractNodeTypeTableValues(text),
]

Deno.test('every documented nodeType value is one the route actually accepts', async () => {
  assert(
    VALID_NODE_TYPES.size > 0,
    'expected to parse at least one valid nodeType from AGENT.md',
  )
  const sources = await collectPromptSources()
  let checked = 0
  for (const [label, text] of Object.entries(sources)) {
    for (const value of extractNodeTypeValues(text)) {
      checked++
      assert(
        VALID_NODE_TYPES.has(value),
        `${label} documents a nodeType value the route rejects: ${value}`,
      )
    }
  }
  assert(checked > 0, 'expected to find at least one documented nodeType value')
})

// ---------------------------------------------------------------------------
// Every argument name used in a documented call_mcp example must be a
// path param or a declared query name for that tool — otherwise the
// documented example itself would be rejected by callReadTool's
// allowlist (or silently ignored, for a path param typo).
// ---------------------------------------------------------------------------

// Two call shapes appear in the docs:
//   call_mcp(tool_name="get_x", arguments={key: val, ...})
//   `get_x` with `{key, ...}`
const CALL_MCP_ARGS_RE =
  /call_mcp\(tool_name="([a-z0-9_]+)"(?:,\s*arguments=\{([^}]*)\})?\)/g
const TOOL_WITH_ARGS_RE = /`([a-z0-9_]+)`\s+with\s+`\{([^}]*)\}`/g

const extractArgKeys = (argBlock: string): string[] =>
  Array.from(argBlock.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:/g), (m) => m[1])

const extractDocumentedCalls = (
  text: string,
): { toolName: string; argKeys: string[] }[] => {
  const calls: { toolName: string; argKeys: string[] }[] = []
  for (const re of [CALL_MCP_ARGS_RE, TOOL_WITH_ARGS_RE]) {
    for (const m of text.matchAll(re)) {
      if (!m[2]) continue // no arguments block — nothing to check
      calls.push({ toolName: m[1], argKeys: extractArgKeys(m[2]) })
    }
  }
  return calls
}

Deno.test('every argument in a documented call_mcp example is a declared path or query param', async () => {
  const sources = await collectPromptSources()
  let checked = 0
  for (const [label, text] of Object.entries(sources)) {
    for (const { toolName, argKeys } of extractDocumentedCalls(text)) {
      const entry = READ_TOOLS[toolName]
      if (!entry) continue // unknown-tool names are T13's job, not this test's
      const pathParams = new Set(
        Array.from(entry.path.matchAll(/\{([a-zA-Z0-9_]+)\}/g), (m) => m[1]),
      )
      const allowed = new Set([...pathParams, ...(entry.query ?? [])])
      for (const key of argKeys) {
        checked++
        assert(
          allowed.has(key),
          `${label} documents ${toolName} called with an argument it doesn't accept: ${key}`,
        )
      }
    }
  }
  assert(
    checked > 0,
    'expected to find at least one documented call_mcp argument to check',
  )
})
