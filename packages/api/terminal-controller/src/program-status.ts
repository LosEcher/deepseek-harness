/** Host-side OSC 7501 (Program Status) parsing, limits, and aggregation. */

export interface ProgramStatus {
  state: 'idle' | 'working' | 'done' | 'blocked' | 'error'
  kind?: 'permission' | 'question' | 'auth'
  app?: string
  title?: string
  msg?: string
  progress?: number
  id?: string
  at?: number
}

export type ParsedOsc =
  | { kind: 'query' }
  | { kind: 'clear'; id: string }
  | { kind: 'report'; record: ProgramStatus }

const WHOLE_MAX = 4096
const KEY_MAX = 16
const MSG_ENC_MAX = 2732
const MSG_DEC_MAX = 2048
const TITLE_ENC_MAX = 256
const TITLE_DEC_MAX = 192
const ID_MAX = 128
const ID_LEVELS_MAX = 8
const RECORDS_MAX = 256

const STATES = new Set(['idle', 'working', 'done', 'blocked', 'error', 'clear'])
const KINDS = new Set(['permission', 'question', 'auth'])
const APP_RE = /^[A-Za-z0-9_.+-]{1,32}$/
const SEG_RE = /^[A-Za-z0-9_.+-]{1,32}$/
const VALUE_RE = /^[A-Za-z0-9_.,+/=-]*$/
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/
const BIDI_RE = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/

const FEATURE_REPLY = '\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\'

/** The only bytes a terminal writes back for this protocol. */
export function featureReply(): string { return FEATURE_REPLY }

function decodeText(value: string): string | undefined {
  try {
    const padded = value + '='.repeat((4 - (value.length % 4)) % 4)
    const binary = Buffer.from(padded, 'base64')
    const decoded = binary.toString('utf8')
    if (Buffer.from(decoded, 'utf8').equals(binary) === false) return undefined
    return decoded
  } catch { return undefined }
}

function textPair(raw: string, encodedMax: number, decodedMax: number): string | undefined {
  if (raw.length > encodedMax) return undefined
  const decoded = decodeText(raw)
  if (decoded === undefined || decoded.length > decodedMax) return undefined
  if (CONTROL_RE.test(decoded)) return undefined
  return decoded.replace(BIDI_RE, '')
}

function validId(id: string): boolean {
  if (id.length > ID_MAX) return false
  const segments = id.split('/')
  return segments.length <= ID_LEVELS_MAX && segments.every(segment => SEG_RE.test(segment))
}

/** Parse one OSC 7501 body; null means the report is discarded whole. */
export function parseOsc7501(body: string): ParsedOsc | null {
  if (body.length > WHOLE_MAX) return null
  if (body.trim() === '?') return { kind: 'query' }
  const fields = new Map<string, string>()
  for (const part of body.split(':')) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    const key = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (key.length === 0 || key.length > KEY_MAX) continue
    if (!VALUE_RE.test(value)) continue
    fields.set(key, value)
  }
  const state = fields.get('state')
  if (state === undefined || !STATES.has(state)) return null
  const id = fields.get('id') ?? ''
  if (id !== '' && !validId(id)) return null
  if (state === 'clear') return { kind: 'clear', id }
  const record: ProgramStatus = { state: state as ProgramStatus['state'], at: Date.now() }
  if (id !== '') record.id = id
  const kind = fields.get('kind')
  if (kind !== undefined && KINDS.has(kind)) record.kind = kind as NonNullable<ProgramStatus['kind']>
  const app = fields.get('app')
  if (app !== undefined && APP_RE.test(app)) record.app = app
  const progress = fields.get('progress')
  if (progress !== undefined && /^\d{1,3}$/.test(progress)) {
    const value = Number(progress)
    if (value >= 0 && value <= 100) record.progress = value
  }
  const title = fields.get('title')
  if (title !== undefined) {
    const text = textPair(title, TITLE_ENC_MAX, TITLE_DEC_MAX)
    if (text === undefined) return null
    record.title = text
  }
  const msg = fields.get('msg')
  if (msg !== undefined) {
    const text = textPair(msg, MSG_ENC_MAX, MSG_DEC_MAX)
    if (text === undefined) return null
    record.msg = text
  }
  return { kind: 'report', record }
}

const RANK: Record<string, number> = { blocked: 5, error: 4, working: 3, done: 2, idle: 1 }

/** Highest-priority record, or undefined when the terminal has none. */
export function aggregate(records: Map<string, ProgramStatus>): ProgramStatus | undefined {
  let best: ProgramStatus | undefined
  for (const record of records.values()) {
    if (best === undefined || (RANK[record.state] ?? 0) > (RANK[best.state] ?? 0)) best = record
  }
  return best
}

/** Apply a parsed report to a record map with the LRU cap. */
export function applyOsc(records: Map<string, ProgramStatus>, parsed: ParsedOsc): void {
  if (parsed.kind === 'query') return
  if (parsed.kind === 'clear') {
    if (parsed.id === '') records.clear()
    else {
      for (const key of [...records.keys()]) {
        if (key === parsed.id || key.startsWith(`${parsed.id}/`)) records.delete(key)
      }
    }
    return
  }
  const id = parsed.record.id ?? ''
  records.delete(id)
  records.set(id, parsed.record)
  while (records.size > RECORDS_MAX) {
    const oldest = records.keys().next().value
    if (oldest === undefined) break
    records.delete(oldest)
  }
}

/** Drop working/blocked/idle records when the process ends (spec lifetime). */
export function settleRecords(records: Map<string, ProgramStatus>): void {
  for (const [id, record] of [...records.entries()]) {
    if (record.state === 'working' || record.state === 'blocked' || record.state === 'idle') records.delete(id)
  }
}
