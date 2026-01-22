import { createRoute, type RouteHandler } from '@hono/zod-openapi'
import { successResponse, error500Response } from '@cmn/zod/http.ts'
import type { AppContext } from '@/index.ts'

export const initRoute = createRoute({
  method: 'get',
  path: '/init',
  description:
    'Initialize the Mainnet RPC.',
  tags: ['MainnetRPC'],
  responses: {
    200: {
      description: 'Response for Mainnet RPC initialization',
      content: {
        'application/json': {
          schema: successResponse,
        },
      },
    },
    500: error500Response,
  },
})

export const initHandler: RouteHandler<typeof initRoute, AppContext> = async (c) => {
  const response = {
    success: true,
    message: 'Mainnet RPC',
  }
  return c.json(response)
}
