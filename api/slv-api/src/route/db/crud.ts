import {
  OpenAPIHono,
  createRoute,
  type RouteHandler,
  z,
} from '@hono/zod-openapi'
import { and, asc, eq, gt } from 'drizzle-orm'
import { error500Response, errorResponse } from '@cmn/zod/http.ts'
import type { AppContext } from '@/index.ts'

export type SearchFieldType = 'string' | 'number' | 'json'

type CrudConfig = {
  table: Record<string, unknown>
  name: string
  tags: string[]
  selectSchema: z.ZodTypeAny
  insertSchema: z.AnyZodObject
  searchFields: Record<string, SearchFieldType>
}

const baseSuccessSchema = z.object({
  success: z.boolean(),
})

const buildItemResponse = (schema: z.ZodTypeAny) => {
  return baseSuccessSchema.extend({
    data: schema,
  })
}

const buildListResponse = (schema: z.ZodTypeAny) => {
  return baseSuccessSchema.extend({
    items: z.array(schema),
    hasMore: z.boolean(),
    nextCursor: z.number().nullable(),
  })
}

const deleteResponse = baseSuccessSchema.extend({
  deleted: z.number(),
})

const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
})

const buildSearchSchema = (fields: Record<string, SearchFieldType>) => {
  const shape: Record<string, z.ZodTypeAny> = {
    cursor: z.coerce.number().int().nonnegative().optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  }
  for (const [key, type] of Object.entries(fields)) {
    if (type === 'number') {
      shape[key] = z.coerce.number().int().optional()
    } else {
      shape[key] = z.string().optional()
    }
  }
  return z.object(shape).passthrough()
}

const buildCreateSchema = (schema: z.AnyZodObject) => {
  return schema
    .omit({
      id: true,
      created_at: true,
      updated_at: true,
    })
    .strict()
}

const getInsertId = (result: unknown): number => {
  if (Array.isArray(result)) {
    const first = result[0] as { insertId?: number } | undefined
    return Number(first?.insertId ?? 0)
  }
  if (result && typeof result === 'object' && 'insertId' in result) {
    return Number((result as { insertId?: number }).insertId ?? 0)
  }
  return 0
}

const getAffectedRows = (result: unknown): number => {
  if (Array.isArray(result)) {
    const first = result[0] as { affectedRows?: number } | undefined
    return Number(first?.affectedRows ?? 0)
  }
  if (result && typeof result === 'object' && 'affectedRows' in result) {
    return Number((result as { affectedRows?: number }).affectedRows ?? 0)
  }
  return 0
}

const buildSearchConditions = (
  table: Record<string, unknown>,
  params: Record<string, unknown>,
  fields: Record<string, SearchFieldType>,
) => {
  const conditions = []
  for (const [key, type] of Object.entries(fields)) {
    if (!(key in params)) {
      continue
    }
    const value = params[key]
    if (value === undefined || value === null) {
      continue
    }
    if (typeof value === 'string' && value.trim().length === 0) {
      continue
    }
    const column = table[key]
    if (!column) {
      continue
    }
    if (type === 'json') {
      if (typeof value !== 'string') {
        return {
          errorMessage: `Invalid JSON for ${key}`,
          conditions: [],
        }
      }
      try {
        const parsed = JSON.parse(value)
        conditions.push(eq(column as never, parsed))
      } catch {
        return {
          errorMessage: `Invalid JSON for ${key}`,
          conditions: [],
        }
      }
    } else {
      conditions.push(eq(column as never, value))
    }
  }
  return { conditions }
}

export const createCrudRouter = (config: CrudConfig) => {
  const router = new OpenAPIHono<AppContext>()
  const createSchema = buildCreateSchema(config.insertSchema)
  const updateSchema = createSchema.partial().strict()
  const searchSchema = buildSearchSchema(config.searchFields)

  const createItemRoute = createRoute({
    method: 'post',
    path: '/create',
    tags: config.tags,
    request: {
      body: {
        content: {
          'application/json': {
            schema: createSchema,
          },
        },
      },
    },
    responses: {
      200: {
        description: `${config.name} created`,
        content: {
          'application/json': {
            schema: buildItemResponse(config.selectSchema),
          },
        },
      },
      500: error500Response,
    },
  })

  const createItemHandler: RouteHandler<typeof createItemRoute, AppContext> =
    async (c) => {
      const payload = c.req.valid('json')
      const result = await c.get('db').insert(config.table as never).values(
        payload as never,
      )
      const insertId = getInsertId(result)
      if (!insertId) {
        return c.json({ success: false, message: 'Insert failed' }, 500)
      }
      const rows = await c.get('db')
        .select()
        .from(config.table as never)
        .where(eq((config.table as { id: unknown }).id as never, insertId))
        .limit(1)
      return c.json({ success: true, data: rows[0] })
    }

  router.openapi(createItemRoute, createItemHandler)

  const getItemRoute = createRoute({
    method: 'get',
    path: '/get/:id',
    tags: config.tags,
    request: {
      params: idParamSchema,
    },
    responses: {
      200: {
        description: `${config.name} detail`,
        content: {
          'application/json': {
            schema: buildItemResponse(config.selectSchema),
          },
        },
      },
      404: {
        description: 'Not Found',
        content: {
          'application/json': {
            schema: errorResponse,
          },
        },
      },
      500: error500Response,
    },
  })

  const getItemHandler: RouteHandler<typeof getItemRoute, AppContext> = async (
    c,
  ) => {
    const { id } = c.req.valid('param')
    const rows = await c.get('db')
      .select()
      .from(config.table as never)
      .where(eq((config.table as { id: unknown }).id as never, id))
      .limit(1)
    if (!rows[0]) {
      return c.json({ success: false, message: 'Not found' }, 404)
    }
    return c.json({ success: true, data: rows[0] })
  }

  router.openapi(getItemRoute, getItemHandler)

  const searchRoute = createRoute({
    method: 'get',
    path: '/search',
    tags: config.tags,
    request: {
      query: searchSchema,
    },
    responses: {
      200: {
        description: `${config.name} search results`,
        content: {
          'application/json': {
            schema: buildListResponse(config.selectSchema),
          },
        },
      },
      400: {
        description: 'Invalid search parameters',
        content: {
          'application/json': {
            schema: errorResponse,
          },
        },
      },
      500: error500Response,
    },
  })

  const searchHandler: RouteHandler<typeof searchRoute, AppContext> = async (
    c,
  ) => {
    const params = c.req.valid('query')
    const cursor = params.cursor as number | undefined
    const limit = params.limit as number | undefined
    const safeLimit = Math.min(limit ?? 50, 200)
    const idColumn = (config.table as { id: unknown }).id
    const conditions = []
    if (cursor !== undefined) {
      conditions.push(gt(idColumn as never, cursor))
    }
    const built = buildSearchConditions(
      config.table,
      params,
      config.searchFields,
    )
    if ('errorMessage' in built) {
      return c.json({ success: false, message: built.errorMessage }, 400)
    }
    conditions.push(...built.conditions)

    let query = c.get('db').select().from(config.table as never)
    if (conditions.length > 0) {
      query = query.where(and(...conditions))
    }
    const rows = await query
      .orderBy(asc(idColumn as never))
      .limit(safeLimit + 1)

    const hasMore = rows.length > safeLimit
    const items = hasMore ? rows.slice(0, safeLimit) : rows
    const nextCursor = hasMore && items.length > 0
      ? (items[items.length - 1] as { id: number }).id
      : null

    return c.json({
      success: true,
      items,
      hasMore,
      nextCursor,
    })
  }

  router.openapi(searchRoute, searchHandler)

  const updateRoute = createRoute({
    method: 'put',
    path: '/update/:id',
    tags: config.tags,
    request: {
      params: idParamSchema,
      body: {
        content: {
          'application/json': {
            schema: updateSchema,
          },
        },
      },
    },
    responses: {
      200: {
        description: `${config.name} updated`,
        content: {
          'application/json': {
            schema: buildItemResponse(config.selectSchema),
          },
        },
      },
      400: {
        description: 'Invalid update payload',
        content: {
          'application/json': {
            schema: errorResponse,
          },
        },
      },
      404: {
        description: 'Not Found',
        content: {
          'application/json': {
            schema: errorResponse,
          },
        },
      },
      500: error500Response,
    },
  })

  const updateHandler: RouteHandler<typeof updateRoute, AppContext> = async (
    c,
  ) => {
    const { id } = c.req.valid('param')
    const payload = c.req.valid('json') as Record<string, unknown>
    if (Object.keys(payload).length === 0) {
      return c.json({ success: false, message: 'No fields to update' }, 400)
    }
    await c.get('db')
      .update(config.table as never)
      .set(payload as never)
      .where(eq((config.table as { id: unknown }).id as never, id))
    const rows = await c.get('db')
      .select()
      .from(config.table as never)
      .where(eq((config.table as { id: unknown }).id as never, id))
      .limit(1)
    if (!rows[0]) {
      return c.json({ success: false, message: 'Not found' }, 404)
    }
    return c.json({ success: true, data: rows[0] })
  }

  router.openapi(updateRoute, updateHandler)

  const deleteRoute = createRoute({
    method: 'delete',
    path: '/delete/:id',
    tags: config.tags,
    request: {
      params: idParamSchema,
    },
    responses: {
      200: {
        description: `${config.name} deleted`,
        content: {
          'application/json': {
            schema: deleteResponse,
          },
        },
      },
      404: {
        description: 'Not Found',
        content: {
          'application/json': {
            schema: errorResponse,
          },
        },
      },
      500: error500Response,
    },
  })

  const deleteHandler: RouteHandler<typeof deleteRoute, AppContext> = async (
    c,
  ) => {
    const { id } = c.req.valid('param')
    const result = await c.get('db')
      .delete(config.table as never)
      .where(eq((config.table as { id: unknown }).id as never, id))
    const deleted = getAffectedRows(result)
    if (deleted === 0) {
      return c.json({ success: false, message: 'Not found' }, 404)
    }
    return c.json({ success: true, deleted })
  }

  router.openapi(deleteRoute, deleteHandler)

  return router
}
