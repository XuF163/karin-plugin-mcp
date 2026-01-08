import type { AsyncLocalStorage } from 'node:async_hooks'

import { AdapterBase, createRawMessage } from 'node-karin'

export interface McpTraceStore {
  traceId: string
}

export interface TraceEntry {
  createdAt: number
  request: unknown
  responses: unknown[]
}

export interface McpAdapterRuntime {
  traceStorage: AsyncLocalStorage<McpTraceStore>
  traces: Map<string, TraceEntry>
  inbox: unknown[]
  outbox: unknown[]
  maxHistory: number
}

export class McpAdapter extends AdapterBase {
  private impl: McpAdapterRuntime

  constructor (impl: McpAdapterRuntime) {
    super()
    this.impl = impl

    const now = Date.now()
    ;(this.adapter as any).name = 'karin-mcp'
    ;(this.adapter as any).communication = 'other'
    ;(this.adapter as any).platform = 'other'
    ;(this.adapter as any).standard = 'other'
    ;(this.adapter as any).protocol = 'other'
    ;(this.adapter as any).version = String(process.env.KARIN_VERSION || 'unknown')
    ;(this.adapter as any).address = 'internal://karin-mcp'
    ;(this.adapter as any).connectTime = now
    ;(this.adapter as any).secret = null

    ;(this.account as any).name = 'mcp'
    ;(this.account as any).uid = 'mcp'
    ;(this.account as any).uin = 'mcp'
    ;(this.account as any).selfId = 'mcp'
    ;(this.account as any).avatar = 'https://p.qlogo.cn/gh/967068507/967068507/0'
  }

  get selfId () {
    return (this.account as any).selfId
  }

  async sendMsg (contact: unknown, elements: unknown[]) {
    const time = Date.now()
    const messageId = `${time}_${Math.random().toString(36).slice(2)}`
    const traceId = this.impl.traceStorage.getStore()?.traceId ?? null

    const { raw, msg } = createRawMessage(elements as any)
    const record = {
      direction: 'out',
      traceId,
      time,
      messageId,
      contact,
      elements,
      raw,
      msg,
    }

    this.impl.outbox.unshift(record)
    if (this.impl.outbox.length > this.impl.maxHistory) this.impl.outbox.length = this.impl.maxHistory

    if (traceId && this.impl.traces.has(traceId)) {
      this.impl.traces.get(traceId)!.responses.push(record)
    }

    return {
      message_id: messageId,
      messageId,
      time,
      messageTime: time,
      rawData: record,
    }
  }

  async sendForwardMsg (contact: unknown, elements: unknown[], options: unknown) {
    const time = Date.now()
    const messageId = `${time}_${Math.random().toString(36).slice(2)}`
    const traceId = this.impl.traceStorage.getStore()?.traceId ?? null

    const record = {
      direction: 'out',
      kind: 'forward',
      traceId,
      time,
      messageId,
      contact,
      elements,
      options,
    }

    this.impl.outbox.unshift(record)
    if (this.impl.outbox.length > this.impl.maxHistory) this.impl.outbox.length = this.impl.maxHistory

    if (traceId && this.impl.traces.has(traceId)) {
      this.impl.traces.get(traceId)!.responses.push(record)
    }

    return { messageId, forwardId: messageId }
  }

  async getAvatarUrl () {
    return (this.account as any).avatar
  }

  async getGroupAvatarUrl () {
    return (this.account as any).avatar
  }

  async recallMsg () {
    return
  }
}

