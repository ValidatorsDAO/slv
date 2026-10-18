import type { IntentType } from '@/ai/console/intentClassifier.ts'
import { getMessageText, type MessageInput } from '@/ai/core/messageInput.ts'

export type ThinkingEffort = 'low' | 'medium' | 'high'

/** Exact small-talk forms only: mixed requests and approvals need context. */
export function isSmallTalk(message: string): boolean {
  const text = message.trim().toLowerCase().replace(
    /[!！?？.。,…👋😊\s]+$/gu,
    '',
  )
  return /^(?:hi|hello|hey|hey there|good morning|good evening|how are you|thanks|thank you|bye|goodbye|こんにちは|こんばんは|おはよう(?:ございます)?|ありがとう(?:ございます)?|どうも|元気ですか|お疲れさま(?:です)?|你好|您好|谢谢|再见|привет|здравствуйте|спасибо|xin chào|cảm ơn)$/u
    .test(text)
}

export function turnPolicy(
  input: MessageInput,
  intent?: IntentType,
  previous: ThinkingEffort = 'medium',
): { effort: ThinkingEffort; maxTokens: number; smallTalk: boolean } {
  const text = getMessageText(input)
  const smallTalk = (typeof input === 'string' || !input.images?.length) &&
    isSmallTalk(text)
  if (smallTalk) return { effort: 'low', maxTokens: 512, smallTalk: true }
  const operational = intent === 'validator_deploy' ||
    intent === 'validator_ops' ||
    intent === 'rpc_deploy' || intent === 'rpc_ops' ||
    intent === 'command_execution' ||
    /\b(?:deploy|migration|migrate|restart|firewall|nftables|wireguard|set:identity|set:unstaked|validator|double[- ]vot(?:e|ing))\b|デプロイ|移行|再起動|ファイアウォール|バリデータ|鍵の切替|二重投票/iu
      .test(text)
  if (operational) return { effort: 'high', maxTokens: 8192, smallTalk: false }
  const continuation = text.length <= 160 &&
    (/^(?:(?:yes|no|ok|okay|continue|go ahead)(?:$|[\s,.!?])|はい|いいえ|続けて|お願いします)/iu
      .test(text) ||
      /^\s*\d{1,3}[).、。!！\s]*$/u.test(text) ||
      /^(?:(?:the |that |this )?(?:first|second|third|last|next)(?: one| option)?|それ|そちら|そのまま|同じ|前の)/iu
        .test(text))
  if (continuation) {
    return { effort: previous, maxTokens: 8192, smallTalk: false }
  }
  if (intent === 'account_billing') {
    return { effort: 'low', maxTokens: 2048, smallTalk: false }
  }
  return {
    effort: intent === 'general_chat' && text.length < 300 ? 'low' : 'medium',
    maxTokens: intent === 'general_chat' ? 2048 : 8192,
    smallTalk: false,
  }
}
