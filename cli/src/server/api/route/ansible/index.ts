import { OpenAPIHono } from '@hono/zod-openapi'
import type { CustomContext } from '/src/server/api/index.ts'
import { mainnetRPCRouter } from '/src/server/api/route/ansible/mainnet-rpc/index.ts'

const ansibleRouter = new OpenAPIHono<{
  Variables: CustomContext
}>()

ansibleRouter.route('/mainnet-rpc', mainnetRPCRouter)

export { ansibleRouter }
