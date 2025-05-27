import { z } from '@hono/zod-openapi'

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
      'https://example.com/image2.jpg',
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
