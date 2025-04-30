import { createRoute, z } from '@hono/zod-openapi'
import { ValidatorMainnetInventorySchema } from '@cmn/zod/config.ts'

export const getMainnetValidatorRouter = createRoute({
  method: 'get',
  path: '/mainnet-validators',
  description:
    'Get the list of mainnet validators from the inventory file',
  tags: ['Inventory'],
  responses: {
    200: {
      description: 'List of mainnet validators',
      content: {
        'application/json': {
          schema: z.object({
            success: z
              .boolean()
              .openapi({ description: 'Success status', example: true }),
            message: z
              .array(ValidatorMainnetInventorySchema)
              .openapi({ description: 'List of mainnet validators' }),
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
