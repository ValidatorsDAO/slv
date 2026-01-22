import { createCrudRouter } from '@/route/db/crud.ts'
import {
  TestnetValidator,
  TestnetValidatorInsertSchema,
  TestnetValidatorSelectSchema,
} from '@/db/schema/testnetValidator.ts'
import {
  nodeSearchFields,
  validatorSearchFields,
} from '@/route/db/fields.ts'

export const testnetValidatorRouter = createCrudRouter({
  table: TestnetValidator,
  name: 'TestnetValidator',
  tags: ['TestnetValidator'],
  selectSchema: TestnetValidatorSelectSchema,
  insertSchema: TestnetValidatorInsertSchema,
  searchFields: {
    ...nodeSearchFields,
    ...validatorSearchFields,
  },
})
