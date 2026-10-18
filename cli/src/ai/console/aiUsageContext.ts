import type { UserApiAuth } from '/lib/userApi/auth.ts'
import { callReadTool, isReadToolFailure } from '/lib/userApi/readTools.ts'

const guidance = `## Current SLV AI usage
Use this account data for the current SLV AI plan and remaining tokens.
AI entitlement and paid billing contracts are separate: an empty subscription
list does not establish that the user has no AI plan or usable tokens.
This snapshot precedes the current reply, which can consume more tokens.
`

const unavailable =
  'Current SLV AI usage could not be verified. Say it is unavailable; do not infer a free/inactive plan or zero balance from billing records or memory.'

/** Refresh only on an account question, including later turns in the session. */
export async function loadAiUsageContext(auth: UserApiAuth): Promise<string> {
  try {
    const result = await callReadTool(auth, 'get_ai_usage', { boost: 1 })
    if (isReadToolFailure(result)) {
      return `${guidance}\n${unavailable}\n${result}`
    }
    const body = JSON.parse(result)
    const usage = body?.message ?? body
    const plan = usage?.ai_plan ?? usage?.plan_name
    if (
      body?.success === false || typeof plan !== 'string' || !plan.trim() ||
      typeof usage?.remaining_tokens !== 'number' ||
      !Number.isFinite(usage.remaining_tokens)
    ) return `${guidance}\n${unavailable}`

    return `${guidance}\n${JSON.stringify(usage)}`
  } catch {
    return `${guidance}\n${unavailable}`
  }
}
