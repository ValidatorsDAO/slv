import { createCrudRouter } from '@/route/db/crud.ts'
import {
  Version,
  VersionInsertSchema,
  VersionSelectSchema,
} from '@/db/schema/version.ts'

export const versionRouter = createCrudRouter({
  table: Version,
  name: 'Version',
  tags: ['Version'],
  selectSchema: VersionSelectSchema,
  insertSchema: VersionInsertSchema,
  searchFields: {
    inventory_type: 'string',
    version_agave: 'string',
    version_firedancer: 'string',
    version_jito: 'string',
    version_jito_bam: 'string',
    geyser_version: 'string',
    richat_version: 'string',
    allowed_ssh_ips: 'json',
    allowed_ips: 'json',
  },
})
