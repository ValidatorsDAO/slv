import { z } from '@hono/zod-openapi'

export const ServerStatusEnum = z.enum([
  'provisioning',
  'on',
  'off',
  'maintenance',
  'suspended',
])
export type ServerStatusEnumType = z.infer<typeof ServerStatusEnum>
export const ServerStatusArray = ServerStatusEnum.options
export type ServerStatus = z.infer<typeof ServerStatusEnum>

export const serverStatusEmojiMap: Record<ServerStatus, string> = {
  provisioning: '⚙️',
  on: '🟢',
  off: '🔴',
  maintenance: '🛠️',
  suspended: '⏸️',
}

export const PaymentLink = z.object({
  product: z.string().openapi({
    description: 'Product Name',
    example: 'gRPC Premium',
  }),
  description: z.string().openapi({
    description: 'Product Description',
    example: 'gRPC Premium',
  }),
  imageUrls: z.array(z.string()).openapi({
    description: 'Product Image URLs',
    example: [
      'https://example.com/image1.jpg',
    ],
  }),
  paymentLink: z.string().openapi({
    description: 'Payment link URL',
    example: 'https://buy.stripe.com/test_123456789',
  }),
  price: z.number().openapi({
    description: 'Price in EUR',
    example: 1000,
  }),
})

export const ListProductRes = z.object({
  success: z.boolean(),
  message: z.array(PaymentLink),
})

export type ListProductResType = z.infer<typeof ListProductRes>


export const BareMetalStatus = z.object({
  productName: z.string().openapi({
    description: 'Node Specs',
    example: 'AMD Ryzen 9 5950X',
  }),
  description: z.string().openapi({
    description: 'Product Description',
    example: 'Bare Metal Server with 16GB RAM and 500GB SSD',
  }),
  ip: z.string().openapi({
    description: 'IP address of the Bare Metal Server',
    example: '4.2.0.0',
  }),
  region: z.string().openapi({
    description: 'Region of the Bare Metal Server',
    example: 'AMS',
  }),
  status: z.string().openapi({
    description: 'Status of the Bare Metal Server',
    example: 'on',
    enum: ServerStatusArray,
  }),
  os: z.string().openapi({
    description: 'Operating System of the Bare Metal Server',
    example: 'Ubuntu 24.04',
  }),
  username: z.string().openapi({
    description: 'Username for the Bare Metal Server',
    example: 'root',
  }),
  password: z.string().openapi({
    description: 'Password for the Bare Metal Server',
    example: 'securepassword123',
  }),
  price: z.number().openapi({
    description: 'Price in EUR',
    example: 1000,
  }),
  tags: z.string().openapi({
    example: 'RPC+',
    description: 'Product tags. Comma separated',
  }),
  cpu: z
    .string()
    .openapi({
      example: 'AMD EPYC 9354P (3.8GHz, 32 Cores)',
      description: 'CPU',
    })
    .optional()
    .nullable(),
  ram: z
    .string()
    .openapi({
      example: '1152GB ECC DDR5',
      description: 'RAM',
    })
    .optional()
    .nullable(),
  disk: z
    .string()
    .openapi({
      example: '1TB x 2, 2TB x 2 NVMe',
      description: 'Disk size',
    })
    .optional()
    .nullable(),
  nic: z
    .string()
    .openapi({
      example: '3Gbps uplink',
      description: 'NIC speed',
    })
    .optional()
    .nullable(),
  bandwidth: z.string().openapi({
    example: '100TB / Month - Included',
    description: 'Bandwidth',
  }),
  startDate: z.string().openapi({
    description: 'Start date of the Bare Metal Server subscription',
    example: '2023-01-01T00:00:00Z',
  }),
  nextPaymentDate: z.string().openapi({
    description: 'Next payment date for the Bare Metal Server subscription',
    example: '2023-02-01T00:00:00Z',
  }),
})

export const BareMetalStatusRes = z.object({
  success: z.boolean(),
  message: z.array(BareMetalStatus),
})
