import type { Request } from 'express'

import { toStr } from './utils'

export type AuthorizeOptions = {
  /** Optional IP/CIDR allowlist. Empty means allow all. */
  ipAllowlist: string[]
}

export type AuthResult = {
  ok: boolean
  status: number
  error?: string
}

const normalizeIp = (ip: string): string => {
  const s = toStr(ip).trim()
  if (!s) return ''
  if (s.startsWith('::ffff:')) return s.slice('::ffff:'.length)
  return s
}

const ipv4ToInt = (ip: string): number | null => {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  const nums = parts.map((p) => Number(p))
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
  // eslint-disable-next-line no-bitwise
  return ((nums[0] << 24) >>> 0) + (nums[1] << 16) + (nums[2] << 8) + nums[3]
}

const cidrMatchV4 = (ip: string, cidr: string): boolean => {
  const [base, prefixRaw] = cidr.split('/')
  const prefix = Number(prefixRaw)
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false
  const ipInt = ipv4ToInt(ip)
  const baseInt = ipv4ToInt(base)
  if (ipInt === null || baseInt === null) return false
  // eslint-disable-next-line no-bitwise
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  // eslint-disable-next-line no-bitwise
  return (ipInt & mask) === (baseInt & mask)
}

export const isIpAllowed = (req: Request, allowlist: string[]): boolean => {
  if (!allowlist.length) return true

  const rawIp = normalizeIp(toStr((req as any).ip).trim())
  if (!rawIp) return false

  const candidates = new Set<string>([rawIp])
  if (rawIp === '::1') candidates.add('127.0.0.1')

  for (const entryRaw of allowlist) {
    const entry = toStr(entryRaw).trim()
    if (!entry) continue

    if (entry === 'localhost') {
      if (candidates.has('127.0.0.1')) return true
      continue
    }

    if (entry.includes('/')) {
      for (const ip of candidates) {
        if (cidrMatchV4(ip, entry)) return true
      }
      continue
    }

    if (candidates.has(normalizeIp(entry))) return true
  }

  return false
}

export const authorizeRequest = (req: Request, options: AuthorizeOptions): AuthResult => {
  const ipAllowlist = Array.isArray(options.ipAllowlist) ? options.ipAllowlist : []

  if (!isIpAllowed(req, ipAllowlist)) {
    return { ok: false, status: 403, error: 'IP not allowed' }
  }

  return { ok: true, status: 200 }
}

