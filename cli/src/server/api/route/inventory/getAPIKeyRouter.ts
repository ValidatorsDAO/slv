import { createRoute, z } from '@hono/zod-openapi'

export const getAPIKeyRouter = createRoute({
  method: 'get',
  path: '/api-key',
  description:
    'Get API key from the inventory file. This is used to access the API.',
  tags: ['Inventory'],
  responses: {
    200: {
      description: 'Contains the API key',
      content: {
        'application/json': {
          schema: z.object({
            success: z
              .boolean()
              .openapi({ description: 'Success status', example: true }),
            message: z
              .string()
              .openapi({ description: 'API key', example: 'your_api_key_here' }),
          }),
        },
      },
    },
    500: {
      description: 'Internal Server Error',
      content: {
        'application/json': {
          schema: z.object({
            success: z
              .boolean()
              .openapi({ description: 'Success status', example: false }),
            message: z.string(),
          }),
        },
      },
    },
  },
})
