import { createRoute } from '@hono/zod-openapi'
import { successResponse, error500Response } from '@cmn/zod/http.ts'

export const initRouter = createRoute({
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
