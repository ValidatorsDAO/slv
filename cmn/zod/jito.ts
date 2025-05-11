import { z, extendZodWithOpenApi } from '@hono/zod-openapi'

extendZodWithOpenApi(z)

export const JITO_BLOCK_ENGINE_REGIONS = z
  .enum(['amsterdam', 'frankfurt', 'ny', 'salt_lake_city', 'tokyo'])
  .openapi({
    description: 'Jito Block Engine supported regions',
    example: 'amsterdam',
  })

export const SHREDSTREAM_ADDRESS = z
  .record(
    JITO_BLOCK_ENGINE_REGIONS,
    z.string().openapi({
      description: 'IP address and port for the shredstream server',
    }),
  )
  .openapi({
    description: 'Shredstream server addresses by region',
    example: {
      amsterdam: '74.118.140.240:1002',
      ny: '141.98.216.96:1002',
      frankfurt: '64.130.50.14:1002',
      tokyo: '202.8.9.160:1002',
      salt_lake_city: '64.130.53.8:1002',
    },
  })

export const RELAYER_URL = z
  .record(
    JITO_BLOCK_ENGINE_REGIONS,
    z.string().url().openapi({ description: 'Relayer URL by region' }),
  )
  .openapi({
    description: 'Relayer URLs by region',
    example: {
      amsterdam: 'http://amsterdam.mainnet.relayer.jito.wtf:8100',
      ny: 'http://ny.mainnet.relayer.jito.wtf:8100',
      frankfurt: 'http://frankfurt.mainnet.relayer.jito.wtf:8100',
      tokyo: 'http://tokyo.mainnet.relayer.jito.wtf:8100',
      salt_lake_city: 'http://slc.mainnet.relayer.jito.wtf:8100',
    },
  })
