import { createCrudRouter } from '@/route/db/crud.ts'
import {
  TestnetRpc,
  TestnetRpcInsertSchema,
  TestnetRpcSelectSchema,
} from '@/db/schema/testnetRpc.ts'
import { nodeSearchFields, rpcSearchFields } from '@/route/db/fields.ts'

export const testnetRpcRouter = createCrudRouter({
  table: TestnetRpc,
  name: 'TestnetRpc',
  tags: ['TestnetRpc'],
  selectSchema: TestnetRpcSelectSchema,
  insertSchema: TestnetRpcInsertSchema,
  searchFields: {
    ...nodeSearchFields,
    ...rpcSearchFields,
  },
})
