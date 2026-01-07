import { toStr } from './utils'

export const getLocalBaseUrl = (): string => {
  const port = toStr(process.env.HTTP_PORT || '7777').trim() || '7777'
  return `http://127.0.0.1:${port}`
}

