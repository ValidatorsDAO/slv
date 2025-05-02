import { z } from '@hono/zod-openapi'

export const successResponse = z.object({
  success: z
    .boolean()
    .openapi({ description: 'Success Status', example: true }),
  message: z
    .string()
    .openapi({ description: 'Message', example: 'success' }),
})

export const errorResponse = z.object({
  success: z
    .boolean()
    .openapi({ description: 'Success Status', example: false }),
  message: z
    .string()
    .openapi({ description: 'Error Message', example: 'error' }),
})

export const error500Response = {
  description: 'Internal Server Error',
  content: {
    'application/json': {
      schema: errorResponse,
    },
  },
}