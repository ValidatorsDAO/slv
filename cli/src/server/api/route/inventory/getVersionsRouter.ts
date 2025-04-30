import { createRoute, z } from '@hono/zod-openapi'
import { CmnTypeSchema } from '@cmn/zod/config.ts'

export const getVersionsRouter = createRoute({
  method: 'get',
  path: '/versions',
  description:
    'Get the versions.yml file from the inventory directory',
  tags: ['Inventory'],
  responses: {
    200: {
      description: 'Contains the versions.yml file',
      content: {
        'application/json': {
          schema: z.object({
            success: z
              .boolean()
              .openapi({ description: 'Success status', example: true }),
            message: z
              .array(CmnTypeSchema)
              .openapi({ description: 'List of testnet validators' }),
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
