import { createRoute, z } from '@hono/zod-openapi'
import { ValidatorTestnetInventorySchema } from '@cmn/zod/config.ts'

export const getTestnetValidatorRouter = createRoute({
  method: 'get',
  path: '/testnet-validators',
  description:
    'Get the list of testnet validators from the inventory file',
  tags: ['Inventory'],
  responses: {
    200: {
      description: 'List of testnet validators',
      content: {
        'application/json': {
          schema: z.object({
            success: z
              .boolean()
              .openapi({ description: 'Success status', example: true }),
            message: z
              .array(ValidatorTestnetInventorySchema)
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
