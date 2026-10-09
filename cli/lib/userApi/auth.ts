/**
 * Auth value for every request the CLI sends to user-api. `kind` is a
 * discriminant so a future variant (for example a different kind of
 * token) only needs a new case in `userApiAuthHeader` below — no caller
 * changes.
 *
 * There is deliberately no variant that carries an API key: the API key
 * is for the RPC endpoints, and user-api is called with the account
 * access token (`slv.access_token` in `~/.slv/api.yml`) only.
 */
export type UserApiAuth = {
  kind: 'access-token'
  token: string
}

export const userApiAuthFromAccessToken = (token: string): UserApiAuth => ({
  kind: 'access-token',
  token,
})

/**
 * Turn an auth value into its `Authorization` header value. This is the
 * only place in the CLI that builds a user-api `Authorization` header;
 * every module that calls user-api goes through it, directly or through
 * `client.ts`'s `userApiRequest` / `userApiRequestRaw`.
 */
export const userApiAuthHeader = (auth: UserApiAuth): string => {
  switch (auth.kind) {
    case 'access-token':
      return `Bearer ${auth.token}`
  }
}
