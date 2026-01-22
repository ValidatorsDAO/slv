import { OpenAPIHono } from '@hono/zod-openapi'
import type { AppContext } from '@/index.ts'
import {
  initHandler,
  initRoute,
} from '@/route/ansible/mainnet-rpc/initRouter.ts'

const mainnetRPCRouter = new OpenAPIHono<AppContext>()

mainnetRPCRouter.openapi(initRoute, initHandler)

export { mainnetRPCRouter }
