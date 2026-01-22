import { OpenAPIHono } from '@hono/zod-openapi'
import type { AppContext } from '@/index.ts'
import { mainnetRPCRouter } from '@/route/ansible/mainnet-rpc/index.ts'

const ansibleRouter = new OpenAPIHono<AppContext>()

ansibleRouter.route('/mainnet-rpc', mainnetRPCRouter)

export { ansibleRouter }
