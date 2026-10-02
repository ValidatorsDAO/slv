import { type UserApiAuth, userApiRequest } from '/lib/userApi/client.ts'

export type SupportTicketResult =
  | { ok: true; link: string; message: string }
  | { ok: false; status: number; error: string }

export const openSupportTicket = async (
  auth: UserApiAuth,
  body: { title: string; description: string },
): Promise<SupportTicketResult> => {
  const r = await userApiRequest<{
    success?: boolean
    message?: string
    link?: string
  }>(auth, 'POST', '/v3/user/support/ticket', body)
  if (r.ok) {
    return {
      ok: true,
      link: (r.data.link ?? '').trim(),
      message: r.data.message ?? '',
    }
  }
  return {
    ok: false,
    status: r.status,
    error: r.body?.message ?? r.raw,
  }
}
