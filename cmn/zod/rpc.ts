import { z } from '@hono/zod-openapi'
import { RpcTypeArray } from '@cmn/zod/config.ts'
import { JITO_BLOCK_ENGINE_REGIONS } from '@cmn/zod/jito.ts'
import { SolanaNodeTypes } from '@cmn/constants/config.ts'

export const InitRPCParams = z.object({
  name: z
    .string()
    .openapi({ description: 'Name of the RPC', example: 'slv_rpc_fra_01' }),
  ansible_host: z
    .string()
    .openapi({ description: 'Ansible host', example: '1.1.1.1' }),
  ansible_user: z
    .string()
    .openapi({ description: 'Ansible user', example: 'ubuntu' }),
  ansible_ssh_private_key_file: z.string().openapi({
    description: 'Ansible SSH private key file',
    example: '/home/ubuntu/.ssh/id_rsa',
  }),
  identity_account: z.string().openapi({
    description: 'Identity account',
    example: '4k3Dyjzvzp8e9g6f5c5f5f5f5f5f5f5f5f5f5f5f5f5',
  }),
  network: z.string().openapi({
    description: 'Network type',
    example: 'mainnet',
    enum: ['mainnet', 'testnet'],
  }),
  rpc_type: z
    .enum(RpcTypeArray)
    .openapi({ description: 'RPC type', example: 'Geyser gRPC' }),
  solana_cli: z
    .enum(SolanaNodeTypes)
    .openapi({
      description: 'Solana CLI version',
      example: 'jito',
      enum: [...SolanaNodeTypes],
    }),
  block_engine_region: JITO_BLOCK_ENGINE_REGIONS,
  port_rpc: z
    .number()
    .openapi({ description: 'RPC port', example: 8899, default: 8899 })
    .optional(),
  port_grpc: z
    .number()
    .openapi({ description: 'gRPC port', example: 10000, default: 10000 })
    .optional(),
  x_token: z
    .string()
    .openapi({ description: 'X token for authentication', example: 'xToken' })
    .optional(),
})
