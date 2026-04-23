import { GATEWAY_PROTOCOL_VERSION } from '/src/gateway/paths.ts'
import type { GatewayMode } from '/src/gateway/config.ts'
import { initI18n, t } from '/src/ai/i18n/index.ts'
import { VERSION } from '@cmn/constants/version.ts'

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
  // Strings used only in the server-rendered HTML; they never leave
  // this function so keep them out of the browser-visible JSON.
  const html = {
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
    attachTitle: t('Attach image'),
    dropHere: t('Drop images here to attach'),
  }
  // Strings the client JS needs at runtime (status labels, chat
  // message prefixes, the reconnect countdown template). Baked in
  // as JSON so the browser has no need for a t() round-trip.
  const clientI18n = {
    you: t('You'),
    assistant: t('Assistant'),
    thinking: t('Thinking…'),
    connecting: t('connecting…'),
    reconnecting: t('reconnecting…'),
    reconnectingIn: t('reconnecting in {secs}s…'),
    connected: t('connected'),
    connectionError: t('connection error'),
    tokenRequired: t('token required'),
    handshakeFailed: t('handshake failed'),
    authFailed: t('auth failed — check token'),
    aborted: t('⏸ aborted'),
    errorLabel: t('❌ error'),
    interrupted: t('[disconnected — reply interrupted]'),
    // Image-attach strings — consumed by JS validators and the
    // history placeholder that replaces stripped base64 on reload.
    removeImage: t('Remove image'),
    imgCount: t('📎 {n} image(s) attached'),
    errImageType: t('Only JPEG, PNG, GIF, or WebP images are accepted.'),
    errImageTooLarge: t(
      'Image "{name}" is too large ({mb} MB). Max per image: {max} MB raw.',
    ),
    errImageCount: t('Too many images — max {max} per message.'),
    errImageTotalSize: t(
      'Attached images total {mb} MB; max {max} MB combined.',
    ),
  }
  const i18nJson = JSON.stringify(clientI18n)
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
  header .badge.version { background: #1d2a38; color: #7a9abb; }
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
  /* Thinking indicator — styled as a pending assistant message so
     the user's eye goes to the slot where the reply will stream in.
     Same layout as a real reply, but the text body is replaced by
     a row of pulsing dots + a short caption that names the agent
     so the state reads unambiguously (e.g. "EL 考えています"). */
  .thinking {
    margin: 0 0 12px 0;
  }
  .thinking .who {
    font-size: 12px;
    font-weight: 600;
    color: var(--accent);
    margin-bottom: 3px;
  }
  .thinking .body {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    width: fit-content;
  }
  .thinking .dots {
    display: flex;
    gap: 5px;
  }
  .thinking .dot {
    width: 9px;
    height: 9px;
    background: var(--accent);
    border-radius: 50%;
    animation: pulse 1s infinite;
  }
  .thinking .dot:nth-child(2) { animation-delay: 0.15s; }
  .thinking .dot:nth-child(3) { animation-delay: 0.3s; }
  .thinking .caption {
    font-size: 13px;
    color: var(--muted);
  }
  @keyframes pulse {
    0%, 75%, 100% { opacity: 0.25; transform: scale(0.7); }
    35% { opacity: 1; transform: scale(1.15); }
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
  footer { flex-direction: column; align-items: stretch; gap: 6px; }
  .footer-row { display: flex; gap: 8px; align-items: flex-end; }
  #attach {
    background: transparent;
    color: var(--muted);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0;
    width: 40px;
    min-height: 40px;
    font-size: 18px;
    line-height: 1;
  }
  #attach:hover { color: var(--text); border-color: var(--muted); }
  .attach-previews {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 4px 0 0;
  }
  .attach-thumb {
    position: relative;
    width: 56px;
    height: 56px;
    border-radius: 6px;
    background-size: cover;
    background-position: center;
    background-color: var(--panel);
    border: 1px solid var(--border);
    flex: 0 0 auto;
  }
  .attach-thumb .remove {
    position: absolute;
    top: -6px;
    right: -6px;
    width: 20px;
    height: 20px;
    min-height: 20px;
    padding: 0;
    border-radius: 50%;
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--border);
    font-size: 12px;
    line-height: 1;
    cursor: pointer;
  }
  .attach-thumb .size {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    font: 9px var(--mono);
    color: var(--text);
    background: rgba(0, 0, 0, 0.55);
    text-align: center;
    border-radius: 0 0 5px 5px;
    padding: 1px 0;
  }
  /* Drag-and-drop: the overlay is a semi-transparent layer above
     the whole chat area that appears while the user is dragging
     files over the window. Pointer events are disabled on it so
     the drop lands on the main area beneath. */
  #drop-overlay {
    position: fixed;
    inset: 0;
    background: rgba(10, 14, 20, 0.85);
    border: 2px dashed var(--accent);
    display: none;
    align-items: center;
    justify-content: center;
    color: var(--accent);
    font-weight: 600;
    font-size: 16px;
    pointer-events: none;
    z-index: 10;
  }
  body.dragging #drop-overlay { display: flex; }
  .msg .img-strip {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 4px;
  }
  .msg .img-strip img {
    max-width: 180px;
    max-height: 180px;
    border-radius: 4px;
    border: 1px solid var(--border);
  }
  .msg .img-placeholder {
    font: 12px var(--mono);
    color: var(--muted);
    margin-top: 4px;
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
    #attach { width: 44px; min-height: 44px; }
    .attach-thumb { width: 48px; height: 48px; }
    .msg .img-strip img { max-width: 120px; max-height: 120px; }
  }
</style>
</head>
<body data-slv-token="${inlineToken}" data-slv-protocol="${GATEWAY_PROTOCOL_VERSION}">
<header>
  <span class="title">🌐 SLV Chat</span>
  <span class="badge ${opts.mode}">${opts.mode}</span>
  <span class="badge version">v${VERSION}</span>
  <button id="clear" type="button" title="${html.clearTitle}">${html.clear}</button>
  <span id="status" class="status">${clientI18n.connecting}</span>
</header>
<main id="log"></main>
<div id="gate" class="token-gate" style="display:none">
  <h2>${html.gateHeading}</h2>
  <p>${html.gateBody}</p>
  <input id="token-input" type="password" autocomplete="off" placeholder="${html.placeholderToken}" />
  <button id="token-submit">${html.connect}</button>
</div>
<footer id="footer" style="display:none">
  <div id="attach-previews" class="attach-previews" style="display:none"></div>
  <div class="footer-row">
    <button id="attach" type="button" title="${html.attachTitle}">📎</button>
    <textarea id="input" rows="1" placeholder="${html.placeholderMessage}"></textarea>
    <button id="send">${html.send}</button>
    <button id="abort" class="abort" style="display:none">${html.stop}</button>
  </div>
  <input id="file-picker" type="file" accept="image/jpeg,image/png,image/gif,image/webp" multiple style="display:none" />
</footer>
<div id="drop-overlay">${html.dropHere}</div>
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
  const attachBtn = document.getElementById('attach')
  const filePicker = document.getElementById('file-picker')
  const previewsEl = document.getElementById('attach-previews')

  // Mirror the server-side caps from messageInput.ts. Keep in sync
  // if those change — the server validates authoritatively on send,
  // but the client checks early so users don't base64-encode a
  // 10 MB photo just to hear "too big" afterwards.
  const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
  const MAX_IMAGES = 5
  // Raw (decoded) bytes. base64 is 1.37x, so 3.75 MiB raw ≈ 5 MiB
  // base64, matching the per-image cap on the server.
  const MAX_IMAGE_RAW_BYTES = Math.floor(3.75 * 1024 * 1024)
  const MAX_TOTAL_BASE64_BYTES = 20 * 1024 * 1024

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

  // Pending image attachments for the NEXT outbound message. Each
  // entry: { mime, base64, dataUri, rawBytes, name, thumbEl }. The
  // dataUri is kept only to render the thumbnail preview cheaply —
  // only mime + base64 go over the wire.
  const pendingImages = []

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
      // Strip in-memory base64 thumbnails before persisting — a
      // handful of phone-camera images would blow through the
      // 5 MB localStorage quota per origin. The placeholder on
      // reload ("📎 3 image(s) attached") is enough to keep the
      // transcript sensible.
      const sanitized = history.map((e) => {
        if (!e.imageThumbs) return e
        const { imageThumbs: _drop, ...rest } = e
        return rest
      })
      localStorage.setItem(logKey, JSON.stringify(sanitized))
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
    // In-memory (current-session) image thumbs get rendered inline
    // so the user can see what they attached right above the reply.
    if (entry.imageThumbs && entry.imageThumbs.length > 0) {
      const strip = document.createElement('div')
      strip.className = 'img-strip'
      for (const src of entry.imageThumbs) {
        const im = document.createElement('img')
        im.src = src
        im.loading = 'lazy'
        strip.appendChild(im)
      }
      div.appendChild(strip)
    } else if (entry.imageCount && entry.imageCount > 0) {
      // Restored-from-localStorage case: we dropped the base64
      // payloads (too large for the 5 MB quota) so only a
      // placeholder is available. The user still sees they
      // attached N images on that turn.
      const ph = document.createElement('div')
      ph.className = 'img-placeholder'
      ph.textContent = I18N.imgCount.replace(
        '{n}',
        String(entry.imageCount),
      )
      div.appendChild(ph)
    }
    log.appendChild(div)
    return pre
  }

  const addMsg = (who, whoLabel, text, opts) => {
    const entry = { who, label: whoLabel, text: text || '' }
    if (opts && opts.imageThumbs && opts.imageThumbs.length > 0) {
      // Keep the thumbs on the entry only for this session — they
      // get stripped before saveHistory writes to localStorage.
      entry.imageThumbs = opts.imageThumbs
      entry.imageCount = opts.imageThumbs.length
    }
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
    pendingImages.length = 0
    renderAttachPreviews()
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
    // Named label that matches the assistant-message layout — the
    // user's eye naturally goes to the same spot where the streaming
    // reply will render, so the gap feels like "reply starting" not
    // "nothing happening".
    const who = document.createElement('div')
    who.className = 'who'
    who.textContent = assistantLabel
    const body = document.createElement('div')
    body.className = 'body'
    const dots = document.createElement('div')
    dots.className = 'dots'
    for (let i = 0; i < 3; i++) {
      const d = document.createElement('span')
      d.className = 'dot'
      dots.appendChild(d)
    }
    const caption = document.createElement('span')
    caption.className = 'caption'
    caption.textContent = I18N.thinking
    body.appendChild(dots)
    body.appendChild(caption)
    thinkingEl.appendChild(who)
    thinkingEl.appendChild(body)
    log.appendChild(thinkingEl)
    log.scrollTop = log.scrollHeight
  }

  const hideThinking = () => {
    if (!thinkingEl) return
    thinkingEl.remove()
    thinkingEl = null
  }

  const fmtMb = (bytes) => (bytes / (1024 * 1024)).toFixed(1)

  const renderAttachPreviews = () => {
    previewsEl.innerHTML = ''
    if (pendingImages.length === 0) {
      previewsEl.style.display = 'none'
      return
    }
    previewsEl.style.display = 'flex'
    for (const img of pendingImages) {
      const thumb = document.createElement('div')
      thumb.className = 'attach-thumb'
      thumb.style.backgroundImage = 'url("' + img.dataUri + '")'
      const size = document.createElement('div')
      size.className = 'size'
      size.textContent = fmtMb(img.rawBytes) + ' MB'
      thumb.appendChild(size)
      const rm = document.createElement('button')
      rm.className = 'remove'
      rm.type = 'button'
      rm.title = I18N.removeImage
      rm.textContent = '×'
      rm.addEventListener('click', () => {
        const idx = pendingImages.indexOf(img)
        if (idx >= 0) pendingImages.splice(idx, 1)
        renderAttachPreviews()
      })
      thumb.appendChild(rm)
      img.thumbEl = thumb
      previewsEl.appendChild(thumb)
    }
  }

  const readAsDataUri = (file) =>
    new Promise((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve(String(r.result || ''))
      r.onerror = () => reject(r.error || new Error('read failed'))
      r.readAsDataURL(file)
    })

  // Accept one browser File object and, if it passes the type/size/
  // count checks, push it onto pendingImages. Errors are surfaced
  // via the chat log (addMsg 'error') so the user doesn't have to
  // notice a toast that disappears.
  const attachFile = async (file) => {
    if (!file) return
    if (!ALLOWED_MIME.includes(file.type)) {
      addMsg('error', I18N.errorLabel, I18N.errImageType)
      return
    }
    if (file.size > MAX_IMAGE_RAW_BYTES) {
      addMsg('error', I18N.errorLabel, I18N.errImageTooLarge
        .replace('{name}', file.name || 'image')
        .replace('{mb}', fmtMb(file.size))
        .replace('{max}', fmtMb(MAX_IMAGE_RAW_BYTES)))
      return
    }
    if (pendingImages.length >= MAX_IMAGES) {
      addMsg('error', I18N.errorLabel,
        I18N.errImageCount.replace('{max}', String(MAX_IMAGES)))
      return
    }
    let dataUri
    try {
      dataUri = await readAsDataUri(file)
    } catch {
      addMsg('error', I18N.errorLabel, 'read failed')
      return
    }
    // Strip the "data:<mime>;base64," prefix — the server rejects
    // anything with the prefix attached, same as Anthropic itself.
    const comma = dataUri.indexOf(',')
    const base64 = comma >= 0 ? dataUri.slice(comma + 1) : ''
    if (!base64) {
      addMsg('error', I18N.errorLabel, 'empty image')
      return
    }
    // Enforce total-base64 cap BEFORE pushing, so one oversized
    // image doesn't land and then block all subsequent uploads.
    let totalSoFar = 0
    for (const p of pendingImages) totalSoFar += p.base64.length
    if (totalSoFar + base64.length > MAX_TOTAL_BASE64_BYTES) {
      addMsg('error', I18N.errorLabel, I18N.errImageTotalSize
        .replace('{mb}', fmtMb(totalSoFar + base64.length))
        .replace('{max}', fmtMb(MAX_TOTAL_BASE64_BYTES)))
      return
    }
    pendingImages.push({
      mime: file.type,
      base64: base64,
      dataUri: dataUri,
      rawBytes: file.size,
      name: file.name || 'image',
      thumbEl: null,
    })
    renderAttachPreviews()
  }

  const attachFileList = async (files) => {
    if (!files || files.length === 0) return
    for (const f of files) {
      await attachFile(f)
    }
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
      // Status events (running / idle) fire as soon as the server
      // accepts the turn — well before the LLM has produced
      // anything — so they MUST NOT dismiss the thinking
      // indicator. Any other event implies real content has
      // started arriving; dismiss then.
      if (p.type !== 'status') hideThinking()
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
    // Accept text-only, images-only, or text+images. An empty-empty
    // send still short-circuits because it would be indistinguishable
    // from an accidental Enter.
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    if (!text && pendingImages.length === 0) return

    const outboundImages = pendingImages.slice()
    const thumbs = outboundImages.map((p) => p.dataUri)
    addMsg('user', I18N.you, text, thumbs.length > 0 ? { imageThumbs: thumbs } : undefined)

    input.value = ''
    input.style.height = 'auto'
    // Clear pendingImages immediately so a second Send doesn't
    // double-attach. Previews get rebuilt from the now-empty array.
    pendingImages.length = 0
    renderAttachPreviews()

    sendBtn.disabled = true
    abortBtn.style.display = 'inline-block'
    currentAssistantEl = null
    currentAssistantEntry = null
    showThinking()
    const params = outboundImages.length > 0
      ? {
        text,
        images: outboundImages.map((p) => ({
          mime: p.mime,
          base64: p.base64,
        })),
      }
      : { text }
    const res = await call('session.send', params)
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

  // Attach button → open the hidden <input type="file">. Kept
  // separate from the native <label> pattern so we can reuse the
  // same attach pipeline for paste + drag-drop without duplication.
  attachBtn.addEventListener('click', () => filePicker.click())
  filePicker.addEventListener('change', async (e) => {
    const files = e.target.files
    await attachFileList(files)
    // Reset so the same file can be re-picked after removal.
    filePicker.value = ''
  })

  // Ctrl+V / Cmd+V in the textarea pastes an image straight onto
  // the pending list — the common case for "I just took a
  // screenshot and I want to ask about it".
  input.addEventListener('paste', async (e) => {
    const items = e.clipboardData && e.clipboardData.items
    if (!items) return
    const files = []
    for (const item of items) {
      if (item.kind === 'file' && item.type && item.type.startsWith('image/')) {
        const f = item.getAsFile()
        if (f) files.push(f)
      }
    }
    if (files.length === 0) return
    e.preventDefault()
    await attachFileList(files)
  })

  // Drag-drop: listen on document because the drop target in
  // practice is the whole page. dragenter / dragleave fires per
  // child element, so track a reference count to avoid flicker.
  let dragDepth = 0
  document.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer || !e.dataTransfer.types.includes('Files')) return
    dragDepth++
    document.body.classList.add('dragging')
  })
  document.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1)
    if (dragDepth === 0) document.body.classList.remove('dragging')
  })
  document.addEventListener('dragover', (e) => {
    // preventDefault on dragover is required — without it the drop
    // event never fires.
    if (e.dataTransfer && e.dataTransfer.types.includes('Files')) {
      e.preventDefault()
    }
  })
  document.addEventListener('drop', async (e) => {
    dragDepth = 0
    document.body.classList.remove('dragging')
    if (!e.dataTransfer || !e.dataTransfer.files) return
    if (e.dataTransfer.files.length === 0) return
    e.preventDefault()
    await attachFileList(e.dataTransfer.files)
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
