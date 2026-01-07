export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export const toStr = (val: unknown): string => (val === undefined || val === null ? '' : String(val))

export const toNum = (val: unknown, fallback: number): number => {
  const num = typeof val === 'number' ? val : Number(val)
  return Number.isFinite(num) ? num : fallback
}

export const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value))

