import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'

export type DeploymentMode = 'local' | 'remote'
export type SpecialistAgent =
  | 'Cecil'
  | 'Tina'
  | 'Cid'
  | 'Setzer'
  | 'Figaro'
export type IntentToolName =
  | 'run_command'
  | 'read_file'
  | 'write_file'
  | 'list_files'
  | 'call_mcp'
  | 'send_notification'
  | 'delegate_to_agent'
export type ContextModuleName =
  | 'ssh_check'
  | 'delegation'
  | 'deploy'
  | 'validator'
  | 'cli_reference'
  | 'mcp_reference'
export type UserContextKind =
  | 'mcp_user_account'
  | 'inventory_testnet_validators'
  | 'inventory_mainnet_validators'
  | 'inventory_mainnet_rpcs'

export type IntentType =
  | 'general_chat'
  | 'server_availability'
  | 'server_procurement'
  | 'account_billing'
  | 'validator_deploy'
  | 'validator_ops'
  | 'rpc_deploy'
  | 'rpc_ops'
  | 'benchmark'
  | 'app_builder'
  | 'command_execution'
  | 'unknown'

export type IntentClassification = {
  intent: IntentType
  confidence: number
  language: string
  toolsToEnable: IntentToolName[]
  contextModulesToLoad: ContextModuleName[]
  userContextKindsToHydrate: UserContextKind[]
  delegateAgent: SpecialistAgent | null
  askClarify: string | null
}

type ClassifierConfig = {
  provider: 'openai' | 'anthropic' | 'slv'
  apiKey: string
  model: string
  slvApiKey?: string
}

type ClassifierInput = {
  message: string
  deploymentMode: DeploymentMode
  enabledSpecialists: string[]
  currentIntent?: IntentType | null
  currentSpecialist?: SpecialistAgent | null
}

const ALLOWED_INTENTS: IntentType[] = [
  'general_chat',
  'server_availability',
  'server_procurement',
  'account_billing',
  'validator_deploy',
  'validator_ops',
  'rpc_deploy',
  'rpc_ops',
  'benchmark',
  'app_builder',
  'command_execution',
  'unknown',
]

const ALLOWED_TOOLS: IntentToolName[] = [
  'run_command',
  'read_file',
  'write_file',
  'list_files',
  'call_mcp',
  'send_notification',
  'delegate_to_agent',
]

const ALLOWED_CONTEXT_MODULES: ContextModuleName[] = [
  'ssh_check',
  'delegation',
  'deploy',
  'validator',
  'cli_reference',
  'mcp_reference',
]

const ALLOWED_USER_CONTEXT_KINDS: UserContextKind[] = [
  'mcp_user_account',
  'inventory_testnet_validators',
  'inventory_mainnet_validators',
  'inventory_mainnet_rpcs',
]

const ALLOWED_SPECIALISTS: SpecialistAgent[] = [
  'Cecil',
  'Tina',
  'Cid',
  'Setzer',
  'Figaro',
]

function unique<T>(values: T[]): T[] {
  return values.filter((value, index) => values.indexOf(value) === index)
}

function clampConfidence(value: unknown, fallback = 0.5): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(0, Math.min(1, n))
}

function sanitizeArray<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T[] {
  if (!Array.isArray(value)) return []
  return unique(
    value
      .map((item) => String(item))
      .filter((item): item is T => allowed.includes(item as T)),
  )
}

function normalizeLanguage(value: unknown, fallbackMessage: string): string {
  const detected = detectLanguageFallback(fallbackMessage)
  const language = String(value || '').trim().toLowerCase()
  if (!language) return detected
  if (detected === 'en' && language !== 'en') return detected
  return language
}

function detectLanguageFallback(message: string): string {
  if (/[\u3040-\u30ff\u3400-\u9fff]/.test(message)) return 'ja'
  if (/[а-яёіїєґ]/i.test(message)) return 'cyrillic'
  if (/[áéíóúñü]/i.test(message)) return 'es-ish'
  return 'en'
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim()
  try {
    return JSON.parse(trimmed) as Record<string, unknown>
  } catch {
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1)) as Record<
          string,
          unknown
        >
      } catch {
        return null
      }
    }
    return null
  }
}

function buildClassifierSystemPrompt(): string {
  return `You are a tiny intent classifier for the SLV CLI.
Return JSON only. No markdown. No prose outside JSON.

Your job is to classify the user's request before any heavy tools or context are enabled.
You must stay lightweight.

Rules:
- Use only the provided inputs.
- Do not assume hidden context.
- Prefer coarse intent classification over overfitting to keywords.
- This must work across languages.
- If ambiguous, use intent="unknown" and set askClarify.
- Only emit tools/context that are justified for the next staged step.
- Do not enable side-effect tools unless the request clearly needs them.
- Server availability, bare metal inventory, server procurement, and validator hardware recommendation/sizing should route to Figaro.
- RPC, gRPC, geyser, and cloud node work should route to Tina.
- Benchmark or connectivity test work should route to Cid only.
- If currentSpecialist/currentIntent are present and the new message is a short follow-up that clearly continues the same topic, prefer keeping that specialist and intent family unless the user materially changes topic.
- The language field must reflect the user's current message only. Do not inherit a previous turn's language.

Return this exact shape:
{
  "intent": "one of the allowed taxonomy values",
  "confidence": 0.0,
  "language": "short language tag or label",
  "toolsToEnable": ["allowed tool names only"],
  "contextModulesToLoad": ["allowed context modules only"],
  "userContextKindsToHydrate": ["allowed user context kinds only"],
  "delegateAgent": "specialist name or null",
  "askClarify": "short clarifying question or null"
}`
}

function buildClassifierUserPrompt(input: ClassifierInput): string {
  return JSON.stringify({
    message: input.message,
    deploymentMode: input.deploymentMode,
    enabledSpecialists: input.enabledSpecialists,
    currentIntent: input.currentIntent ?? null,
    currentSpecialist: input.currentSpecialist ?? null,
    allowedIntentTaxonomy: ALLOWED_INTENTS,
    allowedTools: ALLOWED_TOOLS,
    allowedContextModules: ALLOWED_CONTEXT_MODULES,
    allowedUserContextKinds: ALLOWED_USER_CONTEXT_KINDS,
    allowedSpecialists: ALLOWED_SPECIALISTS,
  })
}

async function callOpenAiClassifier(
  config: ClassifierConfig,
  input: ClassifierInput,
): Promise<Record<string, unknown> | null> {
  const client = new OpenAI({ apiKey: config.apiKey })
  const response = await client.chat.completions.create({
    model: config.model,
    temperature: 0,
    max_tokens: 250,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: buildClassifierSystemPrompt() },
      { role: 'user', content: buildClassifierUserPrompt(input) },
    ],
  })
  const raw = response.choices[0]?.message?.content || '{}'
  return parseJsonObject(raw)
}

async function callAnthropicClassifier(
  config: ClassifierConfig,
  input: ClassifierInput,
): Promise<Record<string, unknown> | null> {
  const client = new Anthropic({ apiKey: config.apiKey })
  const response = await client.messages.create({
    model: config.model,
    max_tokens: 250,
    temperature: 0,
    system: buildClassifierSystemPrompt(),
    messages: [{ role: 'user', content: buildClassifierUserPrompt(input) }],
  })
  const raw = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
  return parseJsonObject(raw)
}

async function callSlvClassifier(
  config: ClassifierConfig,
  input: ClassifierInput,
): Promise<Record<string, unknown> | null> {
  const apiKey = config.slvApiKey || config.apiKey
  if (!apiKey) return null
  const response = await fetch('https://user-api.erpc.global/v3/ai/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: config.model === 'SLV AI' ? 'slv-ai-default' : config.model,
      max_tokens: 250,
      system: buildClassifierSystemPrompt(),
      messages: [{ role: 'user', content: buildClassifierUserPrompt(input) }],
      tools: [],
    }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) return null
  const data = await response.json()
  const raw = Array.isArray(data?.content)
    ? data.content
      .filter((block: { type?: string }) => block?.type === 'text')
      .map((block: { text?: string }) => block.text || '')
      .join('')
    : ''
  return parseJsonObject(raw)
}

function fallbackFromRegex(input: ClassifierInput): IntentClassification {
  const text = input.message.toLowerCase()
  const has = (...tokens: string[]) =>
    tokens.some((token) => text.includes(token))
  const specialistSet = new Set(input.enabledSpecialists)
  const canDelegate = (agent: SpecialistAgent) => specialistSet.has(agent)

  const mentionsServerDomain = has(
    'server',
    'servers',
    'bare metal',
    'inventory',
    'availability',
    'pricing',
    'purchase',
    'buy',
    'hardware',
    'spec',
    'specs',
    'ram',
    'cpu',
    'storage',
    'validator hardware',
    'validator server',
    'validator servers',
    'validator spec',
    'validator specs',
    'validator machine',
    'shinobi',
    'performance pool',
    'stake pool',
    'サーバ',
    '在庫',
    '購入',
    '価格',
    '見積',
    '調達',
    'ハードウェア',
    'スペック',
    'メタル',
    '物理',
    'shinobi pool',
  )
  const mentionsProcurement = has(
    'buy',
    'purchase',
    'pricing',
    'quote',
    'recommend',
    'recommendation',
    'which one',
    'best server',
    'need to buy',
    '購入',
    '価格',
    '見積',
    '注文',
    '調達',
    'おすすめ',
    'どれがいい',
  )

  if (mentionsServerDomain) {
    return buildPlan({
      intent: mentionsProcurement ? 'server_procurement' : 'server_availability',
      confidence: 0.48,
      language: detectLanguageFallback(input.message),
      toolsToEnable: [],
      contextModulesToLoad: [],
      userContextKindsToHydrate: [],
      delegateAgent: canDelegate('Figaro') ? 'Figaro' : null,
      askClarify: null,
    }, input)
  }

  if (has('rpc', 'geyser', 'grpc', 'index', 'cloud', 'ジーザー', 'インデックス')) {
    return buildPlan({
      intent: has(
          'deploy',
          'init',
          'setup',
          'provision',
          'デプロイ',
          '構築',
          'セットアップ',
        )
        ? 'rpc_deploy'
        : 'rpc_ops',
      confidence: 0.45,
      language: detectLanguageFallback(input.message),
      toolsToEnable: [],
      contextModulesToLoad: [],
      userContextKindsToHydrate: [],
      delegateAgent: canDelegate('Tina') ? 'Tina' : null,
      askClarify: null,
    }, input)
  }

  if (has('benchmark', 'latency', 'throughput', 'grpc_test', 'geyserbench', 'shreds_test', 'ベンチ', '速度計測')) {
    return buildPlan({
      intent: 'benchmark',
      confidence: 0.45,
      language: detectLanguageFallback(input.message),
      toolsToEnable: [],
      contextModulesToLoad: [],
      userContextKindsToHydrate: [],
      delegateAgent: canDelegate('Cid') ? 'Cid' : null,
      askClarify: null,
    }, input)
  }

  if (
    has(
      'validator',
      'vote',
      'identity',
      'バリデータ',
      '投票',
      'アイデンティティ',
    )
  ) {
    return buildPlan({
      intent: has(
          'deploy',
          'init',
          'setup',
          'provision',
          'デプロイ',
          '構築',
          'セットアップ',
        )
        ? 'validator_deploy'
        : 'validator_ops',
      confidence: 0.45,
      language: detectLanguageFallback(input.message),
      toolsToEnable: [],
      contextModulesToLoad: [],
      userContextKindsToHydrate: [],
      delegateAgent: canDelegate('Cecil') ? 'Cecil' : null,
      askClarify: null,
    }, input)
  }

  const continuationPrefix = /^(it|that|this|those|these|then|and|also|what about|how about|which|so)/i
  if (
    input.currentIntent &&
    input.currentSpecialist &&
    (input.message.trim().length <= 80 || continuationPrefix.test(input.message.trim()))
  ) {
    return buildPlan({
      intent: input.currentIntent,
      confidence: 0.34,
      language: detectLanguageFallback(input.message),
      toolsToEnable: [],
      contextModulesToLoad: [],
      userContextKindsToHydrate: [],
      delegateAgent: canDelegate(input.currentSpecialist) ? input.currentSpecialist : null,
      askClarify: null,
    }, input)
  }

  return {
    intent: 'unknown',
    confidence: 0.2,
    language: detectLanguageFallback(input.message),
    toolsToEnable: [],
    contextModulesToLoad: [],
    userContextKindsToHydrate: [],
    delegateAgent: null,
    askClarify: null,
  }
}

function buildPlan(
  partial: Partial<IntentClassification>,
  input: ClassifierInput,
): IntentClassification {
  const enabledSpecialists = new Set(input.enabledSpecialists)
  const addTool = (list: IntentToolName[], tool: IntentToolName) => {
    if (!list.includes(tool)) list.push(tool)
  }
  const addModule = (list: ContextModuleName[], module: ContextModuleName) => {
    if (!list.includes(module)) list.push(module)
  }
  const addContextKind = (list: UserContextKind[], kind: UserContextKind) => {
    if (!list.includes(kind)) list.push(kind)
  }

  const intent = ALLOWED_INTENTS.includes(partial.intent as IntentType)
    ? partial.intent as IntentType
    : 'unknown'
  const tools = sanitizeArray(partial.toolsToEnable, ALLOWED_TOOLS)
  const modules = sanitizeArray(
    partial.contextModulesToLoad,
    ALLOWED_CONTEXT_MODULES,
  )
  const contextKinds = sanitizeArray(
    partial.userContextKindsToHydrate,
    ALLOWED_USER_CONTEXT_KINDS,
  )
  const candidateDelegate = String(partial.delegateAgent || '')
  const delegateAgent = enabledSpecialists.has(candidateDelegate)
    ? candidateDelegate as SpecialistAgent
    : null

  switch (intent) {
    case 'server_availability':
      addTool(tools, 'call_mcp')
      addModule(modules, 'mcp_reference')
      addContextKind(contextKinds, 'mcp_user_account')
      break
    case 'server_procurement':
      addTool(tools, 'call_mcp')
      addModule(modules, 'mcp_reference')
      addContextKind(contextKinds, 'mcp_user_account')
      if (enabledSpecialists.has('Figaro')) addTool(tools, 'delegate_to_agent')
      break
    case 'account_billing':
      addTool(tools, 'call_mcp')
      addModule(modules, 'mcp_reference')
      addContextKind(contextKinds, 'mcp_user_account')
      break
    case 'validator_deploy':
      addTool(tools, 'run_command')
      addTool(tools, 'read_file')
      addTool(tools, 'list_files')
      addModule(modules, 'delegation')
      addModule(modules, 'deploy')
      addModule(modules, 'validator')
      if (input.deploymentMode === 'remote') addModule(modules, 'ssh_check')
      if (enabledSpecialists.has('Cecil')) addTool(tools, 'delegate_to_agent')
      break
    case 'validator_ops':
      addTool(tools, 'run_command')
      addTool(tools, 'read_file')
      addTool(tools, 'list_files')
      addModule(modules, 'validator')
      addContextKind(contextKinds, 'inventory_testnet_validators')
      addContextKind(contextKinds, 'inventory_mainnet_validators')
      if (enabledSpecialists.has('Cecil')) addTool(tools, 'delegate_to_agent')
      break
    case 'rpc_deploy':
      addTool(tools, 'run_command')
      addTool(tools, 'read_file')
      addTool(tools, 'list_files')
      addModule(modules, 'delegation')
      addModule(modules, 'deploy')
      if (input.deploymentMode === 'remote') addModule(modules, 'ssh_check')
      if (enabledSpecialists.has('Tina')) addTool(tools, 'delegate_to_agent')
      break
    case 'rpc_ops':
      addTool(tools, 'run_command')
      addTool(tools, 'read_file')
      addTool(tools, 'list_files')
      addContextKind(contextKinds, 'inventory_mainnet_rpcs')
      if (enabledSpecialists.has('Tina')) addTool(tools, 'delegate_to_agent')
      break
    case 'benchmark':
      addTool(tools, 'run_command')
      addTool(tools, 'read_file')
      addModule(modules, 'delegation')
      if (enabledSpecialists.has('Cid')) addTool(tools, 'delegate_to_agent')
      break
    case 'app_builder':
      addTool(tools, 'run_command')
      addTool(tools, 'read_file')
      addTool(tools, 'write_file')
      addTool(tools, 'list_files')
      addModule(modules, 'delegation')
      addModule(modules, 'cli_reference')
      if (enabledSpecialists.has('Setzer')) addTool(tools, 'delegate_to_agent')
      break
    case 'command_execution':
      addTool(tools, 'run_command')
      addTool(tools, 'read_file')
      addTool(tools, 'list_files')
      addModule(modules, 'cli_reference')
      break
    case 'general_chat':
    case 'unknown':
      break
  }

  const preferredDelegateByIntent: Partial<Record<IntentType, SpecialistAgent>> = {
    server_availability: 'Figaro',
    server_procurement: 'Figaro',
    validator_deploy: 'Cecil',
    validator_ops: 'Cecil',
    rpc_deploy: 'Tina',
    rpc_ops: 'Tina',
    benchmark: 'Cid',
    app_builder: 'Setzer',
  }
  const preferredDelegate = preferredDelegateByIntent[intent]
  const resolvedDelegateAgent = preferredDelegate && enabledSpecialists.has(preferredDelegate)
    ? preferredDelegate
    : delegateAgent

  const plan: IntentClassification = {
    intent,
    confidence: clampConfidence(
      partial.confidence,
      intent === 'unknown' ? 0.25 : 0.65,
    ),
    language: normalizeLanguage(partial.language, input.message),
    toolsToEnable: tools,
    contextModulesToLoad: modules,
    userContextKindsToHydrate: contextKinds,
    delegateAgent: resolvedDelegateAgent,
    askClarify:
      typeof partial.askClarify === 'string' && partial.askClarify.trim()
        ? partial.askClarify.trim()
        : null,
  }

  if (!plan.askClarify && plan.intent === 'unknown' && plan.confidence < 0.45) {
    plan.askClarify =
      'Could you tell me whether this is about servers, validator/RPC operations, billing, or a general question?'
  }

  return plan
}

export function describeIntent(intent: IntentType): string {
  const labels: Record<IntentType, string> = {
    general_chat: 'general conversation',
    server_availability: 'server availability',
    server_procurement: 'server procurement',
    account_billing: 'account or billing',
    validator_deploy: 'validator deployment',
    validator_ops: 'validator operations',
    rpc_deploy: 'RPC deployment',
    rpc_ops: 'RPC operations',
    benchmark: 'benchmark or connectivity testing',
    app_builder: 'app or bot development',
    command_execution: 'CLI or file operation',
    unknown: 'needs clarification',
  }
  return labels[intent]
}

export function describeUserContextKind(kind: UserContextKind): string {
  const labels: Record<UserContextKind, string> = {
    mcp_user_account: 'account availability',
    inventory_testnet_validators: 'testnet validator inventory',
    inventory_mainnet_validators: 'mainnet validator inventory',
    inventory_mainnet_rpcs: 'mainnet RPC inventory',
  }
  return labels[kind]
}

export async function classifyIntent(
  config: ClassifierConfig,
  input: ClassifierInput,
): Promise<IntentClassification> {
  let raw: Record<string, unknown> | null = null

  try {
    if (config.provider === 'openai') {
      raw = await callOpenAiClassifier(config, input)
    } else if (config.provider === 'slv') {
      raw = await callSlvClassifier(config, input)
    } else {
      raw = await callAnthropicClassifier(config, input)
    }
  } catch {
    raw = null
  }

  if (!raw) return fallbackFromRegex(input)
  return buildPlan(raw as Partial<IntentClassification>, input)
}
