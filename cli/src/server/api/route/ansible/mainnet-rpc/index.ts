import { OpenAPIHono } from '@hono/zod-openapi'
import type { CustomContext } from '/src/server/api/index.ts'
import { initRouter } from '/src/server/api/route/ansible/mainnet-rpc/initRouter.ts'

const mainnetRPCRouter = new OpenAPIHono<{
  Variables: CustomContext
}>()

mainnetRPCRouter.openapi(initRouter, async (c) => { 
  const response = {
    success: true,
    message: 'Mainnet RPC',
  }
  return c.json(response)
})

export { mainnetRPCRouter }
