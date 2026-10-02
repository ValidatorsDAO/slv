/**
 * Auth value for the direct user-api client. `kind` is a
 * discriminant so a future `{ kind: 'management-token'; token }`
 * variant only needs a new case in `userApiAuthHeader` below — no
 * caller changes.
 */
export type UserApiAuth = {
  kind: 'api-key'
  token: string
}

export const userApiAuthFromApiKey = (token: string): UserApiAuth => ({
  kind: 'api-key',
  token,
})

/**
 * Turn an auth value into its `Authorization` header value. Only
 * `client.ts` calls this — every other module reaches the API
 * through `client.ts`'s `userApiRequest` / `userApiRequestRaw`
 * instead of touching headers directly.
 */
export const userApiAuthHeader = (auth: UserApiAuth): string => {
  switch (auth.kind) {
    case 'api-key':
      return `Bearer ${auth.token}`
  }
}
