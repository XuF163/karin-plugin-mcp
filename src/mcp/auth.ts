import type { Request } from 'express'

import { toStr } from './utils'

export const getReqApiKey = (req: Request): string => {
  const header = toStr(req.headers['x-api-key']).trim()
  if (header) return header

  const authorization = toStr(req.headers.authorization).trim()
  if (authorization.toLowerCase().startsWith('bearer ')) {
    return authorization.slice('bearer '.length).trim()
  }

  const queryKey = toStr((req.query as any)?.apiKey).trim()
  if (queryKey) return queryKey

  const bodyKey = toStr((req.body as any)?.apiKey).trim()
  if (bodyKey) return bodyKey

  return ''
}

export const isAuthorized = (req: Request, apiKey: string): boolean => {
  if (!apiKey) return true
  return getReqApiKey(req) === apiKey
}

