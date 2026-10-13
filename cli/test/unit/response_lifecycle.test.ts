import { assert, assertEquals } from '@std/assert'
import { notifyDiscordWebhook } from '/lib/notifyDiscordWebhook.ts'
import { validateApiKey } from '/src/auth/index.ts'
import { singleUpload } from '/src/storage/upload/uploadAction.ts'
import type { UserApiAuth } from '/lib/userApi/auth.ts'
import { SLVProvider } from '/src/ai/console/providers/slv.ts'
import { clearAbort, killActiveProcess } from '/src/ai/console/tools.ts'

const withFetch = async <T>(
  replacement: typeof fetch,
  action: () => Promise<T>,
): Promise<T> => {
  const original = globalThis.fetch
  globalThis.fetch = replacement
  try {
    return await action()
  } finally {
    globalThis.fetch = original
  }
}

const withShortTimeout = async <T>(action: () => Promise<T>): Promise<T> => {
  const original = globalThis.setTimeout
  globalThis.setTimeout =
    ((callback: () => void) => original(callback, 10)) as typeof setTimeout
  try {
    return await action()
  } finally {
    globalThis.setTimeout = original
  }
}

const continuingResponse = (
  status: number,
): { response: Response; wasCancelled: () => boolean } => {
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('unread'))
    },
    cancel() {
      cancelled = true
    },
  })
  return {
    response: new Response(body, { status }),
    wasCancelled: () => cancelled,
  }
}

Deno.test('status-only response paths cancel continuing bodies', async () => {
  const webhook = continuingResponse(500)
  await withFetch(
    () => Promise.resolve(webhook.response),
    async () => {
      assertEquals(await notifyDiscordWebhook('https://local.test/hook', 'x'), {
        kind: 'http_error',
        status: 500,
      })
    },
  )
  assert(webhook.wasCancelled())

  const auth = continuingResponse(401)
  await withFetch(
    () => Promise.resolve(auth.response),
    async () => {
      assertEquals(await validateApiKey('openai', 'test-key'), {
        valid: false,
        error: 'Invalid API key',
      })
    },
  )
  assert(auth.wasCancelled())
})

Deno.test('Anthropic 403 keeps its deadline through JSON read and cleanup', async () => {
  let signalAborted = false
  await withFetch(
    (_input, init) => {
      init?.signal?.addEventListener('abort', () => {
        signalAborted = true
      }, { once: true })
      return Promise.resolve(Response.json({
        error: { message: 'Access denied by local control' },
      }, { status: 403 }))
    },
    async () => {
      assertEquals(await validateApiKey('anthropic', 'test-key'), {
        valid: false,
        error: 'Access denied by local control',
      })
    },
  )
  assert(!signalAborted)

  let deadlineObserved = false
  let pendingSignal: AbortSignal | undefined
  await withFetch(
    (_input, init) => {
      pendingSignal = init?.signal ?? undefined
      const continuingBody = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"error":'))
          // Keep the JSON read open until the validation request's real abort
          // signal terminates it.
          const abort = () => {
            deadlineObserved = true
            controller.error(
              new DOMException('validation timed out', 'AbortError'),
            )
          }
          pendingSignal?.addEventListener('abort', abort, { once: true })
        },
      })
      return Promise.resolve(new Response(continuingBody, { status: 403 }))
    },
    async () => {
      const result = await withShortTimeout(() =>
        validateApiKey('anthropic', 'test-key')
      )
      assertEquals(result.valid, false)
      assert(result.error?.startsWith('Connection error:'))
    },
  )
  assert(deadlineObserved)
})

Deno.test('single upload cancels an unread PUT response and closes its file', async () => {
  const filePath = await Deno.makeTempFile({
    prefix: 'slv-response-lifecycle-',
  })
  await Deno.writeTextFile(filePath, 'x')
  const upload = continuingResponse(201)
  let requests = 0
  const auth: UserApiAuth = { kind: 'access-token', token: 'a.b.c' }
  try {
    await withFetch(
      (input) => {
        requests++
        const url = String(input)
        if (url.includes('/storage/presign/upload')) {
          return Promise.resolve(Response.json({
            url: 'https://local.test/upload',
            method: 'PUT',
            region: 'eu',
            key: 'local',
            expiresAt: '2099-01-01T00:00:00.000Z',
          }))
        }
        return Promise.resolve(upload.response)
      },
      () => singleUpload(auth, filePath, 'local', 1, 'text/plain', 'eu'),
    )
    assertEquals(requests, 2)
    assert(upload.wasCancelled())
    await Deno.remove(filePath)
  } finally {
    await Deno.remove(filePath).catch(() => undefined)
  }
})

Deno.test('SLV provider cancels its reader on stream error and user abort', async () => {
  const auth: UserApiAuth = { kind: 'access-token', token: 'a.b.c' }
  let completions = 0
  const callbacks = {
    onStream: () => {},
    onToolCall: () => {},
    onComplete: () => {
      completions++
    },
  }

  let errorCancelled = false
  const errorStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          'data: {"type":"error","error":{"message":"local stream error"}}\n\n',
        ),
      )
    },
    cancel() {
      errorCancelled = true
    },
  })
  await withFetch(
    () => Promise.resolve(new Response(errorStream, { status: 200 })),
    async () => {
      const provider = new SLVProvider(auth, 'SLV AI', '', callbacks)
      await provider.chat('local')
        .then(() => {
          throw new Error('expected stream error')
        })
        .catch((error) => assertEquals(error.message, 'local stream error'))
    },
  )
  assert(errorCancelled)

  clearAbort()
  await withFetch(
    (_input, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener('abort', () => {
            controller.error(new DOMException('aborted', 'AbortError'))
          }, { once: true })
        },
        cancel() {},
      })
      setTimeout(killActiveProcess, 0)
      return Promise.resolve(new Response(body, { status: 200 }))
    },
    async () => {
      const provider = new SLVProvider(auth, 'SLV AI', '', callbacks)
      await provider.chat('local')
    },
  )
  assertEquals(completions, 1)
  clearAbort()
})
