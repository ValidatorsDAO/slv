import { GATEWAY_PROTOCOL_VERSION } from '/src/gateway/paths.ts'
import type { GatewayMode } from '/src/gateway/config.ts'
import { initI18n, t } from '/src/ai/i18n/index.ts'

export type RenderOptions = {
  /**
   * The gateway token. Non-null when the request came from loopback
   * (same-machine access via 127.0.0.1 / localhost) — safe to inline
   * in HTML because only the local user can read it. NULL when the
   * request came from a non-loopback IP (lan mode access); the
   * client-side JS falls back to localStorage or prompts the user.
   */
  token: string | null
  mode: GatewayMode
}

/**
 * Render the browser chat UI. Token inlining policy is decided by
 * the caller — see RenderOptions above. The HTML itself is identical
 * either way; only the bootstrap path differs.
 *
 * Security model:
 *   - `local` mode: gateway binds 127.0.0.1; only same-machine
 *     requests can reach /ui/; token inlined for zero-friction.
 *   - `lan` mode: gateway binds 0.0.0.0; requests from any IP reach
 *     /ui/; token NOT inlined — user pastes it once and we persist
 *     in localStorage keyed on origin.
 */
export const renderChatHtml = async (opts: RenderOptions): Promise<string> => {
  await initI18n()
  const inlineToken = opts.token ?? ''
  // The client JS needs localized status/label strings too; bake
  // them into a JSON object rather than round-tripping through t()
  // on the browser (the browser has no access to the i18n dict).
  const i18n = {
    send: t('Send'),
    stop: t('Stop'),
    clear: t('clear'),
    clearTitle: t('Clear chat history'),
    connect: t('Connect'),
    placeholderMessage: t('Type a message and press Enter'),
    placeholderToken: t('64 hex characters'),
    gateHeading: t('Paste your gateway token'),
    gateBody: t(
      "This browser is reaching the SLV gateway from a different host. Paste the gateway token value (found in ~/.slv/gateway/gateway.json on the gateway host) to continue. It's saved in your browser's localStorage.",
    ),
    you: t('You'),
    assistant: t('Assistant'),
    thinking: t('Thinking…'),
    connecting: t('connecting…'),
    reconnecting: t('reconnecting…'),
    reconnectingIn: t('reconnecting in {secs}s…'),
    connected: t('connected'),
    disconnected: t('disconnected'),
    connectionError: t('connection error'),
    tokenRequired: t('token required'),
    handshakeFailed: t('handshake failed'),
    authFailed: t('auth failed — check token'),
    aborted: t('⏸ aborted'),
    errorLabel: t('❌ error'),
    interrupted: t('[disconnected — reply interrupted]'),
  }
  const i18nJson = JSON.stringify(i18n)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
<meta name="theme-color" content="#0b0f14" />
<title>SLV Chat</title>
<style>
  :root {
    --bg: #0b0f14;
    --panel: #12181f;
    --border: #1f2933;
    --text: #e6edf3;
    --muted: #8b949e;
    --accent: #14f195;
    --user: #58a6ff;
    --tool: #d29922;
    --error: #f85149;
    --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    --safe-bottom: env(safe-area-inset-bottom, 0px);
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    height: 100%;
    background: var(--bg);
    color: var(--text);
    font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, sans-serif;
    -webkit-text-size-adjust: 100%;
  }
  body { display: flex; flex-direction: column; }
  header {
    flex: 0 0 auto;
    padding: 10px 14px;
    padding-top: calc(10px + env(safe-area-inset-top, 0px));
    border-bottom: 1px solid var(--border);
    background: var(--panel);
    display: flex;
    align-items: center;
    gap: 10px;
  }
  header .title { font-weight: 600; }
  header .badge {
    font: 11px var(--mono);
    background: #22303e;
    color: var(--muted);
    padding: 2px 6px;
    border-radius: 4px;
  }
  header .badge.lan { background: #3d3218; color: #ffdf7a; }
  header #clear {
    background: transparent;
    color: var(--muted);
    border: 1px solid var(--border);
    padding: 4px 10px;
    font-weight: 400;
    font-size: 12px;
    min-height: 0;
  }
  header #clear:hover { color: var(--text); border-color: var(--muted); }
  header .status {
    margin-left: auto;
    font: 12px var(--mono);
    color: var(--muted);
  }
  header .status.connected { color: var(--accent); }
  header .status.error     { color: var(--error); }
  main {
    flex: 1 1 auto;
    overflow-y: auto;
    padding: 12px 14px;
    -webkit-overflow-scrolling: touch;
  }
  footer {
    flex: 0 0 auto;
    border-top: 1px solid var(--border);
    background: var(--panel);
    padding: 10px 14px;
    padding-bottom: calc(10px + var(--safe-bottom));
    display: flex;
    gap: 8px;
  }
  #input {
    flex: 1 1 auto;
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 8px 10px;
    font: 16px var(--mono);
    resize: none;
    min-height: 40px;
    max-height: 180px;
  }
  #input:focus { outline: 2px solid var(--accent); }
  button {
    background: var(--accent);
    color: #001b10;
    border: 0;
    border-radius: 6px;
    padding: 0 14px;
    min-height: 40px;
    font-weight: 600;
    font-size: 14px;
    cursor: pointer;
    touch-action: manipulation;
  }
  button:disabled { opacity: 0.5; cursor: default; }
  button.abort { background: var(--error); color: white; }
  .msg { margin: 0 0 12px 0; }
  .msg .who {
    font-size: 12px;
    font-weight: 600;
    margin-bottom: 3px;
  }
  .msg.user .who      { color: var(--user); }
  .msg.assistant .who { color: var(--accent); }
  .msg.tool .who      { color: var(--tool); }
  .msg.system .who    { color: var(--muted); }
  .msg.error .who     { color: var(--error); }
  .msg pre {
    margin: 0;
    padding: 6px 10px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 4px;
    font: 13px var(--mono);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .msg.assistant pre { background: transparent; border: 0; padding: 4px 0; }
  .thinking {
    margin: 0 0 12px 0;
    padding: 6px 0;
    color: var(--muted);
    font-style: italic;
    font-size: 13px;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .thinking .dot {
    width: 6px;
    height: 6px;
    background: var(--accent);
    border-radius: 50%;
    animation: pulse 1.2s infinite;
  }
  .thinking .dot:nth-child(2) { animation-delay: 0.2s; }
  .thinking .dot:nth-child(3) { animation-delay: 0.4s; }
  @keyframes pulse {
    0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
    40% { opacity: 1; transform: scale(1); }
  }
  .token-gate {
    max-width: 520px;
    margin: 60px auto;
    padding: 20px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  .token-gate h2 { margin: 0 0 10px; font-size: 16px; }
  .token-gate p  { margin: 0 0 14px; color: var(--muted); font-size: 13px; }
  .token-gate input {
    width: 100%;
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 10px;
    font: 16px var(--mono);
  }
  .token-gate input:focus { outline: 2px solid var(--accent); }
  .token-gate button { padding: 10px 14px; margin-top: 10px; min-height: 44px; }
  .token-gate code {
    font: 12px var(--mono);
    background: var(--bg);
    padding: 2px 5px;
    border-radius: 4px;
    color: var(--text);
  }
  @media (max-width: 640px) {
    header { padding: 8px 10px; padding-top: calc(8px + env(safe-area-inset-top, 0px)); gap: 6px; }
    header .title { font-size: 13px; }
    header .badge { font-size: 10px; }
    header #clear { padding: 4px 8px; font-size: 11px; }
    header .status { font-size: 11px; }
    main { padding: 10px; }
    footer { padding: 8px 10px; padding-bottom: calc(8px + var(--safe-bottom)); }
    .token-gate { margin: 16px 10px; padding: 16px; }
    button { padding: 0 12px; min-height: 44px; }
    #input { min-height: 44px; }
  }
</style>
</head>
<body data-slv-token="${inlineToken}" data-slv-protocol="${GATEWAY_PROTOCOL_VERSION}">
<header>
  <span class="title">🌐 SLV Chat</span>
  <span class="badge ${opts.mode}">${opts.mode}</span>
  <button id="clear" type="button" title="${i18n.clearTitle}">${i18n.clear}</button>
  <span id="status" class="status">${i18n.connecting}</span>
</header>
<main id="log"></main>
<div id="gate" class="token-gate" style="display:none">
  <h2>${i18n.gateHeading}</h2>
  <p>${i18n.gateBody}</p>
  <input id="token-input" type="password" autocomplete="off" placeholder="${i18n.placeholderToken}" />
  <div><button id="token-submit">${i18n.connect}</button></div>
</div>
<footer id="footer" style="display:none">
  <textarea id="input" rows="1" placeholder="${i18n.placeholderMessage}"></textarea>
  <button id="send">${i18n.send}</button>
  <button id="abort" class="abort" style="display:none">${i18n.stop}</button>
</footer>
<script>
(function () {
  const I18N = ${i18nJson}

  const log = document.getElementById('log')
  const input = document.getElementById('input')
  const sendBtn = document.getElementById('send')
  const abortBtn = document.getElementById('abort')
  const clearBtn = document.getElementById('clear')
  const statusEl = document.getElementById('status')
  const footerEl = document.getElementById('footer')
  const gateEl = document.getElementById('gate')
  const tokenInput = document.getElementById('token-input')
  const tokenSubmit = document.getElementById('token-submit')

  const inlineToken = document.body.dataset.slvToken || ''
  const storageKey = 'slv.gateway.token.' + location.host
  const logKey     = 'slv.gateway.log.'   + location.host

  // Client-side message history. Kept in memory and mirrored to
  // localStorage so a reload rehydrates the visible transcript.
  // Cap entries to keep localStorage under the ~5MB per-origin
  // quota — a noisy session can otherwise run away.
  const HISTORY_MAX = 500
  let history = []
  let ws = null
  let nextId = 0
  const pending = new Map()
  let currentAssistantEl = null
  let currentAssistantEntry = null
  let thinkingEl = null
  let assistantLabel = I18N.assistant

  // Reconnect state: survives across connection lifetimes.
  // reconnectAttempt resets on a successful auth; backoff is
  // 1s → 2s → 4s → 8s → 16s → 30s (capped) with ±250ms jitter so
  // a flaky network doesn't produce synchronized reconnect storms.
  let currentToken = ''
  let reconnectAttempt = 0
  let reconnectTimer = null

  const getToken = () => {
    if (inlineToken) return inlineToken
    try {
      const stored = localStorage.getItem(storageKey) || ''
      return stored.trim()
    } catch {
      return ''
    }
  }

  const setStatus = (text, cls) => {
    statusEl.textContent = text
    statusEl.className = 'status ' + (cls || '')
  }

  const showGate = () => {
    gateEl.style.display = 'block'
    footerEl.style.display = 'none'
    tokenInput.focus()
  }

  const showChat = () => {
    gateEl.style.display = 'none'
    footerEl.style.display = 'flex'
    input.focus()
  }

  tokenSubmit.addEventListener('click', () => {
    const t = (tokenInput.value || '').trim()
    if (!t) return
    try {
      localStorage.setItem(storageKey, t)
    } catch {
      // Ignore storage errors; the in-memory token still works.
    }
    connect(t)
  })
  tokenInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') tokenSubmit.click()
  })

  const saveHistory = () => {
    try {
      localStorage.setItem(logKey, JSON.stringify(history))
    } catch {
      // Over quota or disabled — history still lives in memory.
    }
  }

  const renderMsg = (entry) => {
    const div = document.createElement('div')
    div.className = 'msg ' + entry.who
    const label = document.createElement('div')
    label.className = 'who'
    label.textContent = entry.label
    const pre = document.createElement('pre')
    pre.textContent = entry.text
    div.appendChild(label)
    div.appendChild(pre)
    log.appendChild(div)
    return pre
  }

  const addMsg = (who, whoLabel, text) => {
    const entry = { who, label: whoLabel, text: text || '' }
    history.push(entry)
    if (history.length > HISTORY_MAX) {
      const excess = history.length - HISTORY_MAX
      history.splice(0, excess)
      // Drop the corresponding leading DOM nodes. Only trims if we
      // actually exceeded the cap, so the normal path is O(1).
      for (let i = 0; i < excess && log.firstChild; i++) {
        log.removeChild(log.firstChild)
      }
    }
    const pre = renderMsg(entry)
    log.scrollTop = log.scrollHeight
    saveHistory()
    return { pre, entry }
  }

  const restoreHistory = () => {
    let raw
    try {
      raw = localStorage.getItem(logKey)
    } catch {
      return
    }
    if (!raw) return
    try {
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) return
      history = parsed.slice(-HISTORY_MAX)
      for (const entry of history) renderMsg(entry)
      log.scrollTop = log.scrollHeight
    } catch {
      // Corrupt JSON — drop it rather than wedge on every reload.
      try { localStorage.removeItem(logKey) } catch { /* ignore */ }
    }
  }

  clearBtn.addEventListener('click', () => {
    history = []
    log.innerHTML = ''
    try { localStorage.removeItem(logKey) } catch { /* ignore */ }
  })

  const rejectPending = (reason) => {
    for (const resolve of pending.values()) {
      resolve({ ok: false, error: reason })
    }
    pending.clear()
  }

  const showThinking = () => {
    if (thinkingEl) return
    thinkingEl = document.createElement('div')
    thinkingEl.className = 'thinking'
    const label = document.createElement('span')
    label.textContent = I18N.thinking
    thinkingEl.appendChild(label)
    for (let i = 0; i < 3; i++) {
      const d = document.createElement('span')
      d.className = 'dot'
      thinkingEl.appendChild(d)
    }
    log.appendChild(thinkingEl)
    log.scrollTop = log.scrollHeight
  }

  const hideThinking = () => {
    if (!thinkingEl) return
    thinkingEl.remove()
    thinkingEl = null
  }

  const scheduleReconnect = () => {
    if (!currentToken) return
    if (reconnectTimer !== null) return
    const base = Math.min(30000, 1000 * Math.pow(2, reconnectAttempt))
    const delay = base + Math.random() * 250
    const secs = Math.max(1, Math.round(delay / 1000))
    setStatus(I18N.reconnectingIn.replace('{secs}', String(secs)), 'error')
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      reconnectAttempt++
      connect(currentToken)
    }, delay)
  }

  const call = (method, params) => new Promise((resolve) => {
    const id = 'w' + (++nextId)
    pending.set(id, resolve)
    ws.send(JSON.stringify({ kind: 'req', id, method, params }))
  })

  const connect = (token) => {
    if (!token) {
      showGate()
      setStatus(I18N.tokenRequired, 'error')
      return
    }
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    currentToken = token
    showChat()
    setStatus(reconnectAttempt > 0 ? I18N.reconnecting : I18N.connecting, '')
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    ws = new WebSocket(proto + '//' + location.host + '/v1/session/ws')
    ws.onopen = async () => {
      const hello = await call('gateway.hello')
      if (!hello.ok) {
        setStatus(I18N.handshakeFailed, 'error')
        return
      }
      const auth = await call('gateway.auth', { token })
      if (!auth.ok) {
        // Distinguish a real server rejection ("invalid token")
        // from a mid-auth disconnect: onclose nulls ws and
        // resolves the pending promise with a local sentinel, so
        // a null ws here means the socket died during auth. In
        // that case the token is still probably valid — let the
        // reconnect loop retry instead of wiping localStorage.
        if (ws === null) return
        currentToken = ''
        if (reconnectTimer !== null) {
          clearTimeout(reconnectTimer)
          reconnectTimer = null
        }
        setStatus(I18N.authFailed, 'error')
        try { localStorage.removeItem(storageKey) } catch { /* ignore */ }
        showGate()
        return
      }
      reconnectAttempt = 0
      setStatus(I18N.connected, 'connected')
      // Surface the configured agent's display name. session.info is
      // cheap (cached AgentContext) so the round-trip is noise-free.
      try {
        const info = await call('session.info')
        if (info.ok && info.payload && typeof info.payload.agentName === 'string') {
          assistantLabel = info.payload.agentName
        }
      } catch { /* fall back to default label */ }
      input.focus()
    }
    ws.onmessage = (ev) => {
      const f = JSON.parse(ev.data)
      if (f.kind === 'res') {
        const r = pending.get(f.id)
        if (r) { pending.delete(f.id); r(f) }
        return
      }
      if (f.kind !== 'event') return
      const p = f.payload || {}
      // Any incoming event means the model is responding — drop the
      // thinking indicator. Keeping it through text_delta would show
      // dots next to the actual reply, which is noisy.
      hideThinking()
      switch (p.type) {
        case 'text_delta':
          if (!currentAssistantEl) {
            const added = addMsg('assistant', assistantLabel, '')
            currentAssistantEl = added.pre
            currentAssistantEntry = added.entry
          }
          currentAssistantEl.textContent += p.text
          if (currentAssistantEntry) {
            currentAssistantEntry.text = currentAssistantEl.textContent
          }
          log.scrollTop = log.scrollHeight
          break
        case 'tool_use_start':
          addMsg('tool', '⚡ ' + (p.name || 'tool'), typeof p.args === 'string' ? p.args : JSON.stringify(p.args || {}, null, 2))
          break
        case 'tool_stdout':
          addMsg('tool', '   stdout', p.text || '')
          break
        case 'tool_progress':
          addMsg('tool', '   ' + (p.label || 'progress'), '')
          break
        case 'complete':
        case 'aborted':
          saveHistory()
          currentAssistantEl = null
          currentAssistantEntry = null
          sendBtn.disabled = false
          abortBtn.style.display = 'none'
          if (p.type === 'aborted') {
            addMsg('system', I18N.aborted, p.reason || '')
          }
          break
        case 'error':
          addMsg('error', I18N.errorLabel, p.message || '')
          currentAssistantEl = null
          currentAssistantEntry = null
          sendBtn.disabled = false
          abortBtn.style.display = 'none'
          break
      }
    }
    ws.onclose = () => {
      ws = null
      hideThinking()
      // Any outstanding req/res awaits would otherwise hang forever;
      // resolve them with a sentinel so callers return cleanly.
      rejectPending('disconnected')
      // An in-flight assistant reply is lost on disconnect — mark it
      // in both the visible DOM and the persisted history so the
      // user knows to retry.
      if (currentAssistantEntry) {
        const note = '\\n\\n' + I18N.interrupted
        currentAssistantEntry.text += note
        if (currentAssistantEl) currentAssistantEl.textContent += note
      }
      currentAssistantEl = null
      currentAssistantEntry = null
      sendBtn.disabled = false
      abortBtn.style.display = 'none'
      saveHistory()
      scheduleReconnect()
    }
    ws.onerror = () => {
      // onerror always runs right before onclose, so leave the
      // real recovery logic (pending rejection, reconnect schedule)
      // in onclose to avoid double-trigger.
      setStatus(I18N.connectionError, 'error')
    }
  }

  const sendMessage = async () => {
    const text = input.value.trim()
    if (!text || !ws || ws.readyState !== WebSocket.OPEN) return
    addMsg('user', I18N.you, text)
    input.value = ''
    input.style.height = 'auto'
    sendBtn.disabled = true
    abortBtn.style.display = 'inline-block'
    currentAssistantEl = null
    currentAssistantEntry = null
    showThinking()
    const res = await call('session.send', { text })
    if (!res.ok) {
      hideThinking()
      addMsg('error', I18N.errorLabel, res.error || 'session.send rejected')
      sendBtn.disabled = false
      abortBtn.style.display = 'none'
    }
  }

  sendBtn.addEventListener('click', sendMessage)
  abortBtn.addEventListener('click', () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ kind: 'req', id: 'a' + (++nextId), method: 'session.abort' }))
  })
  // Guard against IME composition: Japanese / Chinese / Korean input
  // methods use Enter to commit the composition, which would
  // otherwise send a half-typed message and leave the composition
  // buffer stuck in the textarea. keyCode 229 is the legacy signal
  // some mobile browsers still rely on; isComposing is the modern
  // one. Check both.
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault()
      sendMessage()
    }
  })
  input.addEventListener('input', () => {
    input.style.height = 'auto'
    input.style.height = Math.min(input.scrollHeight, 180) + 'px'
  })

  restoreHistory()

  const initial = getToken()
  if (initial) {
    connect(initial)
  } else {
    showGate()
    setStatus('token required', 'error')
  }
})()
</script>
</body>
</html>
`
}
