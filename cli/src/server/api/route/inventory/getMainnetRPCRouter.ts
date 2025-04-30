import { createRoute, z } from '@hono/zod-openapi'
import { MainnetRPCInventorySchema } from '@cmn/zod/config.ts'

export const getMainnetRPCRouter = createRoute({
  method: 'get',
  path: '/mainnet-rpcs',
  description:
    'Get the list of mainnet rpcs from the inventory file',
  tags: ['Inventory'],
  responses: {
    200: {
      description: 'List of mainnet rpcs',
      content: {
        'application/json': {
          schema: z.object({
            success: z
              .boolean()
              .openapi({ description: 'Success status', example: true }),
            message: z
              .array(MainnetRPCInventorySchema)
              .openapi({ description: 'List of mainnet rpcs' }),
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
