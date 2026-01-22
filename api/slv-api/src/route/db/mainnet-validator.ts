import { createCrudRouter } from '@/route/db/crud.ts'
import {
  MainnetValidator,
  MainnetValidatorInsertSchema,
  MainnetValidatorSelectSchema,
} from '@/db/schema/mainnetValidator.ts'
import {
  nodeSearchFields,
  validatorSearchFields,
} from '@/route/db/fields.ts'

export const mainnetValidatorRouter = createCrudRouter({
  table: MainnetValidator,
  name: 'MainnetValidator',
  tags: ['MainnetValidator'],
  selectSchema: MainnetValidatorSelectSchema,
  insertSchema: MainnetValidatorInsertSchema,
  searchFields: {
    ...nodeSearchFields,
    ...validatorSearchFields,
    staked_rpc_identity_account: 'string',
    staked_rpc_amount: 'number',
  },
})
