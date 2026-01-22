import { createCrudRouter } from '@/route/db/crud.ts'
import {
  MainnetRpc,
  MainnetRpcInsertSchema,
  MainnetRpcSelectSchema,
} from '@/db/schema/mainnetRpc.ts'
import { nodeSearchFields, rpcSearchFields } from '@/route/db/fields.ts'

export const mainnetRpcRouter = createCrudRouter({
  table: MainnetRpc,
  name: 'MainnetRpc',
  tags: ['MainnetRpc'],
  selectSchema: MainnetRpcSelectSchema,
  insertSchema: MainnetRpcInsertSchema,
  searchFields: {
    ...nodeSearchFields,
    ...rpcSearchFields,
  },
})
