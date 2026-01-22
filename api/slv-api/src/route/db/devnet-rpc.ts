import { createCrudRouter } from '@/route/db/crud.ts'
import {
  DevnetRpc,
  DevnetRpcInsertSchema,
  DevnetRpcSelectSchema,
} from '@/db/schema/devnetRpc.ts'
import { nodeSearchFields, rpcSearchFields } from '@/route/db/fields.ts'

export const devnetRpcRouter = createCrudRouter({
  table: DevnetRpc,
  name: 'DevnetRpc',
  tags: ['DevnetRpc'],
  selectSchema: DevnetRpcSelectSchema,
  insertSchema: DevnetRpcInsertSchema,
  searchFields: {
    ...nodeSearchFields,
    ...rpcSearchFields,
  },
})
