/**
 * POST a message to a Discord webhook. Fire-and-forget: network
 * failures, timeouts, or HTTP errors never throw — notifications are
 * strictly advisory and must not fail whatever flow dispatched them.
 *
 * Callers that want to surface success/failure to the user (e.g.
 * onboard's "✔ Sent browser UI link to your Discord webhook") should
 * wire `onResult` to react on the returned `kind`.
 */
export type WebhookResult =
  | { kind: 'ok' }
  | { kind: 'http_error'; status: number }
  | { kind: 'network_error'; message: string }
  | { kind: 'skipped_empty_url' }

export type NotifyOptions = {
  /**
   * Per-call timeout in milliseconds. Discord webhooks are usually
   * < 500ms but slow networks can exceed 5s — default 10s strikes a
   * friendly balance without hanging a user flow for a minute.
   */
  timeoutMs?: number
}

export const notifyDiscordWebhook = async (
  webhookUrl: string,
  content: string,
  opts: NotifyOptions = {},
): Promise<WebhookResult> => {
  if (!webhookUrl || webhookUrl.trim().length === 0) {
    return { kind: 'skipped_empty_url' }
  }
  const timeoutMs = opts.timeoutMs ?? 10_000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
      signal: controller.signal,
    })
    if (!res.ok) return { kind: 'http_error', status: res.status }
    return { kind: 'ok' }
  } catch (err) {
    return {
      kind: 'network_error',
      message: err instanceof Error ? err.message : String(err),
    }
  } finally {
    clearTimeout(timer)
  }
}
