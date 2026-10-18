import { ensureFreshAccessToken, isJwtShaped } from '/lib/userApi/session.ts'

export const ERPC_LOGIN_REJECTED_MESSAGE =
  'ERPC rejected this login. Run `slv login` to sign in again in your browser. An RPC API key cannot authenticate to user-api.'

/**
 * Auth value for every request the CLI sends to user-api.
 *
 * - `session`: the ERPC login saved in `<home>/.slv/api.yml` by
 *   `slv login`. Every header is built from an access token that is checked
 *   first and refreshed when it is about to expire, so a long AI console
 *   session or a large multipart upload keeps working past the token's
 *   lifetime.
 * - `access-token`: one access token as is — used to check a new login
 *   before anything is saved, and by code that already holds the api.yml
 *   lock (a refresh would wait for that same lock).
 *
 * There is deliberately no variant that carries an API key: the API key is
 * for the RPC endpoints only and is never sent to user-api.
 */
export type UserApiAuth =
  | { kind: 'session'; home: string }
  | { kind: 'access-token'; token: string }

export const userApiAuthFromSession = (home: string): UserApiAuth => ({
  kind: 'session',
  home,
})

/** Throws unless `token` has the shape of a JWT (an API key does not). */
export const userApiAuthFromAccessToken = (token: string): UserApiAuth => {
  if (!isJwtShaped(token)) {
    throw new Error('An ERPC access token has the shape of a JWT.')
  }
  return { kind: 'access-token', token }
}

/**
 * Turn an auth value into its `Authorization` header value. This is the
 * only place in the CLI that builds a user-api `Authorization` header;
 * every module that calls user-api goes through it, directly or through
 * `client.ts`'s `userApiRequest` / `userApiRequestRaw`. Call it right before
 * each request: for a session it may refresh the access token.
 */
export const userApiAuthHeader = async (auth: UserApiAuth): Promise<string> => {
  const token = auth.kind === 'session'
    ? await ensureFreshAccessToken(auth.home)
    : auth.token
  return `Bearer ${token}`
}
