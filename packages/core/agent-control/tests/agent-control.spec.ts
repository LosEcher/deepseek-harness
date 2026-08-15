import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  admitAgentWorkerFrame,
  AgentControlError,
  assertCanAcquire,
  lastOwnership,
} from '@deepseek-ai/dsh-agent-control'
import type { BridgeMessage } from '@deepseek-ai/dsh-bridge-protocol'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'

const contracts = join(dirname(fileURLToPath(import.meta.url)), '../../agent/contracts')

function loadJson(name: string): unknown {
  return JSON.parse(readFileSync(join(contracts, name), 'utf8'))
}

function digest(name: string): string {
  const source = readFileSync(join(contracts, name))
  return `sha256:${createHash('sha256').update(source).digest('hex')}`
}

describe('agent-worker fixtures', () => {
  it('keeps the manifest digest aligned with the source', () => {
    const manifest = loadJson('agent-worker-manifest.json') as { source_digest: string }
    expect(manifest.source_digest).toBe(digest('agent-worker-manifest-source.json'))
    const positive = loadJson('agent-worker-positive.json') as { source_digest: string }
    const negative = loadJson('agent-worker-negative.json') as { source_digest: string }
    expect(positive.source_digest).toBe(manifest.source_digest)
    expect(negative.source_digest).toBe(manifest.source_digest)
  })

  it('admits every positive frame against generation 1', () => {
    const positive = loadJson('agent-worker-positive.json') as {
      cases: { name: string; frame: BridgeMessage }[]
    }
    for (const testCase of positive.cases) {
      expect(() => admitAgentWorkerFrame(testCase.frame, 1), testCase.name).not.toThrow()
    }
  })

  it('rejects every negative frame with the recorded phrase', () => {
    const negative = loadJson('agent-worker-negative.json') as {
      cases: { name: string; expected_error: string; frame: BridgeMessage }[]
    }
    for (const testCase of negative.cases) {
      expect(() => admitAgentWorkerFrame(testCase.frame, 1), testCase.name).toThrow(testCase.expected_error)
    }
  })
})

describe('ownership', () => {
  it('refuses a second acquirer while another generation holds the lease', () => {
    const session = Session.create(SessionId('own-1'))
    session.append('session/ownership', {
      generation: 1,
      action: 'acquire',
      backend: 'local-ts',
      owner: 'host',
    })
    expect(lastOwnership(session.events)?.generation).toBe(1)
    expect(() => assertCanAcquire(session.events, 2)).toThrow(AgentControlError)
    session.append('session/ownership', {
      generation: 1,
      action: 'release',
      backend: 'local-ts',
      owner: 'host',
    })
    expect(() => assertCanAcquire(session.events, 2)).not.toThrow()
  })
})

describe('busy admission', () => {
  it('rejects a non-cancel command when the queue is full', () => {
    const frame: BridgeMessage = {
      kind: 'call',
      payload: {
        generation: 1,
        id: 'cmd-busy',
        service: 'agent',
        method: 'followup',
        args: {},
      },
    }
    expect(() => admitAgentWorkerFrame(frame, 1, 32, 32)).toThrow('busy')
    expect(() => admitAgentWorkerFrame({
      kind: 'call',
      payload: { generation: 1, id: 'cmd-c', service: 'agent', method: 'cancel', args: {} },
    }, 1, 32, 32)).not.toThrow()
  })
})

void (0 as unknown as SessionEvent)
