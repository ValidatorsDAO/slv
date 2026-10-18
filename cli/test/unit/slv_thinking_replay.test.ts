import { assertEquals, assertFalse } from '@std/assert'
import { SLVProvider } from '@/ai/console/providers/slv.ts'
import { clearAbort, resetActiveTools } from '@/ai/console/tools.ts'
import { userApiAuthFromAccessToken } from '/lib/userApi/auth.ts'
import { ACCESS_TOKEN, withFetch } from '/test/unit/_credentialFixtures.ts'

function stream(events: Record<string, unknown>[]): Response {
  const bytes = new TextEncoder().encode(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
  )
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        // Split JSON, UTF-8, signatures and SSE delimiters across reads.
        for (let i = 0; i < bytes.length; i += 7) {
          controller.enqueue(bytes.slice(i, i + 7))
        }
        controller.close()
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

const start = (index: number, content_block: Record<string, unknown>) => ({
  type: 'content_block_start',
  index,
  content_block,
})
const delta = (index: number, delta: Record<string, unknown>) => ({
  type: 'content_block_delta',
  index,
  delta,
})
const stop = (index: number) => ({ type: 'content_block_stop', index })

Deno.test('SLV preserves signed and redacted thinking across tool results and later user turns', async () => {
  clearAbort()
  resetActiveTools()
  const rendered: string[] = []
  const tools: string[] = []
  let completed = 0
  const provider = new SLVProvider(
    userApiAuthFromAccessToken(ACCESS_TOKEN),
    'SLV AI',
    'test system',
    {
      onStream: (text) => rendered.push(text),
      onToolCall: (name) => tools.push(name),
      onComplete: () => completed++,
    },
  )
  let count = 0
  try {
    await withFetch(() => {
      count++
      if (count === 1) {
        return stream([
          start(0, { type: 'thinking', thinking: '', signature: '' }),
          delta(0, { type: 'thinking_delta', thinking: '考察' }),
          delta(0, { type: 'thinking_delta', thinking: '。' }),
          delta(0, { type: 'signature_delta', signature: 'test-signature-' }),
          delta(0, { type: 'signature_delta', signature: 'one' }),
          stop(0),
          start(1, { type: 'thinking', thinking: '', signature: '' }),
          delta(1, {
            type: 'signature_delta',
            signature: 'test-empty-signature',
          }),
          stop(1),
          start(2, { type: 'redacted_thinking', data: 'test-redacted-data' }),
          stop(2),
          start(3, {
            type: 'tool_use',
            id: 'test-call',
            name: 'enable_tools',
            input: {},
          }),
          delta(3, {
            type: 'input_json_delta',
            partial_json: '{"tools":["read_file"]}',
          }),
          stop(3),
          { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
          { type: 'message_stop' },
        ])
      }
      return stream([
        start(0, {
          type: 'thinking',
          thinking: '',
          signature: 'test-initial-signature',
        }),
        stop(0),
        start(1, { type: 'text', text: '' }),
        delta(1, { type: 'text_delta', text: 'Ready.' }),
        stop(1),
        { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
        { type: 'message_stop' },
      ])
    }, async (requests) => {
      await provider.chat('prepare')
      assertEquals(requests.length, 2)
      const toolContinuation = JSON.parse(requests[1].body!)
      const expected = [
        {
          type: 'thinking',
          thinking: '考察。',
          signature: 'test-signature-one',
        },
        { type: 'thinking', thinking: '', signature: 'test-empty-signature' },
        { type: 'redacted_thinking', data: 'test-redacted-data' },
        {
          type: 'tool_use',
          id: 'test-call',
          name: 'enable_tools',
          input: { tools: ['read_file'] },
        },
      ]
      assertEquals(toolContinuation.messages[1], {
        role: 'assistant',
        content: expected,
      })
      assertFalse(
        JSON.parse(requests[0].body!).tools.some(
          (tool: { name: string }) => tool.name === 'read_file',
        ),
      )
      assertEquals(
        toolContinuation.tools.some(
          (tool: { name: string }) => tool.name === 'read_file',
        ),
        true,
      )
      assertEquals(toolContinuation.messages[2].content[0].type, 'tool_result')
      assertEquals(
        toolContinuation.messages[2].content[0].tool_use_id,
        'test-call',
      )
      assertEquals(tools, ['enable_tools'])
      assertEquals(rendered, ['Ready.'])
      assertEquals(completed, 1)

      await provider.chat('continue')
      assertEquals(requests.length, 3)
      const nextTurn = JSON.parse(requests[2].body!)
      assertEquals(nextTurn.messages[1].content, expected)
      assertEquals(nextTurn.messages[3], {
        role: 'assistant',
        content: [
          {
            type: 'thinking',
            thinking: '',
            signature: 'test-initial-signature',
          },
          { type: 'text', text: 'Ready.' },
        ],
      })
      assertEquals(nextTurn.messages[4], { role: 'user', content: 'continue' })
      assertEquals(completed, 2)
      assertFalse(rendered.join('').includes('signature'))
      assertFalse(rendered.join('').includes('考察'))
      assertFalse(rendered.join('').includes('redacted'))
    })
  } finally {
    resetActiveTools()
    clearAbort()
  }
})
