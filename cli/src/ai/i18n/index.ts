import { messages as en } from '@/ai/i18n/messages/en.ts'
import { messages as ja } from '@/ai/i18n/messages/ja.ts'
import { messages as zh } from '@/ai/i18n/messages/zh.ts'
import { messages as ru } from '@/ai/i18n/messages/ru.ts'
import { messages as vi } from '@/ai/i18n/messages/vi.ts'
import { readLang } from '@/ai/config.ts'
import { dirname } from '@std/path'
import { parse } from '@std/yaml'

export const BUILTIN_LANGS: Record<string, Record<string, string>> = {
  en,
  ja,
  zh,
  ru,
  vi,
}

let loaded: Record<string, string> = en
let currentLang = 'en'
let initialized = false
// Cache the in-flight init promise, not just the post-init bool.
// Without this, concurrent callers during first startup (e.g. the
// gateway's /ui/ handler serving several requests while
// `translateViaSlvAi` is still running for a custom language) would
// each fall through to the init path and race on global state.
let initPromise: Promise<void> | null = null

const cachePath = (lang: string): string => {
  const home = Deno.env.get('HOME') || ''
  return `${home}/.slv/i18n/${lang}.json`
}

const loadCache = async (lang: string): Promise<Record<string, string> | null> => {
  try {
    const raw = await Deno.readTextFile(cachePath(lang))
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, string>
    }
  } catch { /* no cache */ }
  return null
}

const saveCache = async (
  lang: string,
  dict: Record<string, string>,
): Promise<void> => {
  const path = cachePath(lang)
  await Deno.mkdir(dirname(path), { recursive: true })
  await Deno.writeTextFile(path, JSON.stringify(dict, null, 2))
}

const getSlvApiKey = async (): Promise<string | null> => {
  const home = Deno.env.get('HOME')
  if (!home) return null
  try {
    const raw = await Deno.readTextFile(`${home}/.slv/api.yml`)
    const yml = parse(raw) as { slv?: { api_key?: string } } | null
    const key = yml?.slv?.api_key
    return typeof key === 'string' && key.trim().length > 0 ? key.trim() : null
  } catch {
    return null
  }
}

// Batch-translate the English dictionary to `lang` via SLV AI.
// Returns null if no API key or the call fails (caller falls back to English).
const translateViaSlvAi = async (
  lang: string,
  dict: Record<string, string>,
): Promise<Record<string, string> | null> => {
  const apiKey = await getSlvApiKey()
  if (!apiKey) return null

  const sourceEntries = Object.entries(dict)
  const sourceObj: Record<string, string> = {}
  for (const [k, v] of sourceEntries) sourceObj[k] = v

  const system =
    `You are a professional translator. Translate the VALUES of the given JSON object from English to the target language. Keep the KEYS exactly unchanged. Preserve markdown, punctuation, emojis, backticks, URLs, and placeholders. Respond with ONLY the translated JSON object, no prose, no code fences.`
  const user =
    `Target language: ${lang}\n\nJSON:\n${JSON.stringify(sourceObj)}`

  try {
    const response = await fetch('https://user-api.erpc.global/v3/ai/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'slv-ai-default',
        max_tokens: 8192,
        system,
        messages: [{ role: 'user', content: user }],
      }),
      signal: AbortSignal.timeout(120_000),
    })
    if (!response.ok) return null
    const data = await response.json()
    if (!data || !Array.isArray(data.content)) return null
    let text = ''
    for (const block of data.content) {
      if (block?.type === 'text') text += block.text
    }
    text = text.trim()
    // Strip accidental code fences just in case.
    if (text.startsWith('```')) {
      text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
    }
    const parsed = JSON.parse(text) as Record<string, string>
    if (!parsed || typeof parsed !== 'object') return null
    // Fill any missing keys from the English source.
    const merged: Record<string, string> = { ...dict }
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string' && v.trim().length > 0) merged[k] = v
    }
    return merged
  } catch {
    return null
  }
}

export const initI18n = (): Promise<void> => {
  if (initPromise) return initPromise
  initPromise = (async () => {
    currentLang = await readLang()
    if (BUILTIN_LANGS[currentLang]) {
      loaded = BUILTIN_LANGS[currentLang]
      initialized = true
      return
    }
    // Non-builtin: try cache, then AI translation, else fall back to English.
    const cached = await loadCache(currentLang)
    if (cached) {
      loaded = { ...en, ...cached }
      initialized = true
      return
    }
    const translated = await translateViaSlvAi(currentLang, en)
    if (translated) {
      await saveCache(currentLang, translated).catch(() => {})
      loaded = translated
      initialized = true
      return
    }
    // Fallback: English.
    loaded = en
    initialized = true
  })()
  return initPromise
}

export const t = (key: string): string => {
  if (!initialized) return key
  return loaded[key] ?? key
}

export const getCurrentLang = (): string => currentLang

// Language options shown in the onboard Select prompt.
export const LANG_OPTIONS = [
  { name: 'English', value: 'en' },
  { name: '日本語 (Japanese)', value: 'ja' },
  { name: '中文 (Chinese)', value: 'zh' },
  { name: 'Русский (Russian)', value: 'ru' },
  { name: 'Tiếng Việt (Vietnamese)', value: 'vi' },
  { name: 'Other (type your language)', value: '__other__' },
]
