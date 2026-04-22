import { GATEWAY_PROTOCOL_VERSION } from '/src/gateway/paths.ts'
import type { GatewayMode } from '/src/gateway/config.ts'

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
export const renderChatHtml = (opts: RenderOptions): string => {
  const inlineToken = opts.token ?? ''
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
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
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    height: 100%;
    background: var(--bg);
    color: var(--text);
    font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, sans-serif;
  }
  body { display: flex; flex-direction: column; }
  header {
    flex: 0 0 auto;
    padding: 10px 14px;
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
  }
  footer {
    flex: 0 0 auto;
    border-top: 1px solid var(--border);
    background: var(--panel);
    padding: 10px 14px;
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
    font: 14px var(--mono);
    resize: none;
    min-height: 36px;
    max-height: 180px;
  }
  #input:focus { outline: 2px solid var(--accent); }
  button {
    background: var(--accent);
    color: #001b10;
    border: 0;
    border-radius: 6px;
    padding: 0 14px;
    font-weight: 600;
    cursor: pointer;
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
    padding: 8px 10px;
    font: 13px var(--mono);
  }
  .token-gate input:focus { outline: 2px solid var(--accent); }
  .token-gate button { padding: 8px 14px; margin-top: 10px; }
  .token-gate code {
    font: 12px var(--mono);
    background: var(--bg);
    padding: 2px 5px;
    border-radius: 4px;
    color: var(--text);
  }
</style>
</head>
<body data-slv-token="${inlineToken}" data-slv-protocol="${GATEWAY_PROTOCOL_VERSION}">
<header>
  <span class="title">🌐 SLV Chat</span>
  <span class="badge ${opts.mode}">${opts.mode}</span>
  <span id="status" class="status">connecting…</span>
</header>
<main id="log"></main>
<div id="gate" class="token-gate" style="display:none">
  <h2>Paste your gateway token</h2>
  <p>This browser is reaching the SLV gateway from a different host. Paste the <code>token</code> value from <code>~/.slv/gateway/gateway.json</code> on the gateway host to continue. It's saved in your browser's localStorage.</p>
  <input id="token-input" type="password" autocomplete="off" placeholder="64 hex characters" />
  <div><button id="token-submit">Connect</button></div>
</div>
<footer id="footer" style="display:none">
  <textarea id="input" rows="1" placeholder="Type a message and press Enter"></textarea>
  <button id="send">Send</button>
  <button id="abort" class="abort" style="display:none">Stop</button>
</footer>
<script>
(function () {
  const log = document.getElementById('log')
  const input = document.getElementById('input')
  const sendBtn = document.getElementById('send')
  const abortBtn = document.getElementById('abort')
  const statusEl = document.getElementById('status')
  const footerEl = document.getElementById('footer')
  const gateEl = document.getElementById('gate')
  const tokenInput = document.getElementById('token-input')
  const tokenSubmit = document.getElementById('token-submit')

  const inlineToken = document.body.dataset.slvToken || ''
  const storageKey = 'slv.gateway.token.' + location.host

  let ws = null
  let nextId = 0
  const pending = new Map()
  let currentAssistantEl = null

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

  const addMsg = (who, whoLabel, text) => {
    const div = document.createElement('div')
    div.className = 'msg ' + who
    const label = document.createElement('div')
    label.className = 'who'
    label.textContent = whoLabel
    const pre = document.createElement('pre')
    pre.textContent = text
    div.appendChild(label)
    div.appendChild(pre)
    log.appendChild(div)
    log.scrollTop = log.scrollHeight
    return pre
  }

  const call = (method, params) => new Promise((resolve) => {
    const id = 'w' + (++nextId)
    pending.set(id, resolve)
    ws.send(JSON.stringify({ kind: 'req', id, method, params }))
  })

  const connect = (token) => {
    if (!token) {
      showGate()
      setStatus('token required', 'error')
      return
    }
    showChat()
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    ws = new WebSocket(proto + '//' + location.host + '/v1/session/ws')
    ws.onopen = async () => {
      const hello = await call('gateway.hello')
      if (!hello.ok) {
        setStatus('handshake failed', 'error')
        return
      }
      const auth = await call('gateway.auth', { token })
      if (!auth.ok) {
        setStatus('auth failed — check token', 'error')
        try { localStorage.removeItem(storageKey) } catch { /* ignore */ }
        showGate()
        return
      }
      setStatus('connected', 'connected')
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
      switch (p.type) {
        case 'text_delta':
          if (!currentAssistantEl) {
            currentAssistantEl = addMsg('assistant', 'Assistant', '')
          }
          currentAssistantEl.textContent += p.text
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
          currentAssistantEl = null
          sendBtn.disabled = false
          abortBtn.style.display = 'none'
          if (p.type === 'aborted') {
            addMsg('system', '⏸ aborted', p.reason || '')
          }
          break
        case 'error':
          addMsg('error', '❌ error', p.message || '')
          currentAssistantEl = null
          sendBtn.disabled = false
          abortBtn.style.display = 'none'
          break
      }
    }
    ws.onclose = () => setStatus('disconnected', 'error')
    ws.onerror = () => setStatus('connection error', 'error')
  }

  const sendMessage = async () => {
    const text = input.value.trim()
    if (!text || !ws || ws.readyState !== WebSocket.OPEN) return
    addMsg('user', 'You', text)
    input.value = ''
    input.style.height = 'auto'
    sendBtn.disabled = true
    abortBtn.style.display = 'inline-block'
    currentAssistantEl = null
    const res = await call('session.send', { text })
    if (!res.ok) {
      addMsg('error', '❌ error', res.error || 'session.send rejected')
      sendBtn.disabled = false
      abortBtn.style.display = 'none'
    }
  }

  sendBtn.addEventListener('click', sendMessage)
  abortBtn.addEventListener('click', () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ kind: 'req', id: 'a' + (++nextId), method: 'session.abort' }))
  })
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  })
  input.addEventListener('input', () => {
    input.style.height = 'auto'
    input.style.height = Math.min(input.scrollHeight, 180) + 'px'
  })

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
