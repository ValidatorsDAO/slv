import { OpenAPIHono } from '@hono/zod-openapi'
import type { AppContext } from '@/index.ts'
import { devnetRpcRouter } from '@/route/db/devnet-rpc.ts'
import { mainnetRpcRouter } from '@/route/db/mainnet-rpc.ts'
import { mainnetValidatorRouter } from '@/route/db/mainnet-validator.ts'
import { testnetRpcRouter } from '@/route/db/testnet-rpc.ts'
import { testnetValidatorRouter } from '@/route/db/testnet-validator.ts'
import { versionRouter } from '@/route/db/version.ts'

const dbRouter = new OpenAPIHono<AppContext>()

dbRouter.route('/devnet-rpc', devnetRpcRouter)
dbRouter.route('/mainnet-rpc', mainnetRpcRouter)
dbRouter.route('/mainnet-validator', mainnetValidatorRouter)
dbRouter.route('/testnet-rpc', testnetRpcRouter)
dbRouter.route('/testnet-validator', testnetValidatorRouter)
dbRouter.route('/version', versionRouter)

export { dbRouter }
