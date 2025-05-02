import { OpenAPIHono } from '@hono/zod-openapi'
import { swaggerUI } from '@hono/swagger-ui'
import { inventoryRouter } from '/src/server/api/route/inventory/index.ts'
import { ansibleRouter } from '/src/server/api/route/ansible/index.ts'

export type CustomContext = {}

export type Env = {
  NODE_ENV: string
}


export const app = new OpenAPIHono<{
  Variables: CustomContext
  Bindings: Env
}>()


app.use('*', async (c, next) => {
  try {
    c.header('Access-Control-Allow-Origin', '*')
    c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
    c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    c.header('Access-Control-Max-Age', '86400')
    if (c.req.method === 'OPTIONS') {
      return c.text('OK', 200)
    }
    await next()
  } catch (error) {
    console.error('Error in middleware:', error)
    return c.text('Internal Server Error', 500)
  }
})

// Return ok for /favicon.ico
app.get('/favicon.ico', (c) => {
  return c.json({ message: 'favicon' })
})
app.doc('/doc', {
  openapi: '3.1.0',
  info: {
    version: '1.0.0',
    title: 'SLV API',
    description: 'SLV API Documentation',
  },
})

app.get('/ui', swaggerUI({ url: '/doc' }))

app.route('/inventory', inventoryRouter)
app.route('/ansible', ansibleRouter)

export default app