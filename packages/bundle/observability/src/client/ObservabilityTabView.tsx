/**
 * dsh-observability — '观测' conversation tab: live session-ledger metrics
 * (the /metrics fold, structured) for the current host process. Polls the
 * same-origin /observability/summary endpoint; theme-aware via design tokens.
 */
import { useCallback, useEffect, useState } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import css from './Observability.module.css'

/** Structured snapshot served by the host /observability/summary endpoint. */
interface ObservabilitySummary {
  activeSessions: { preset: string; count: number }[]
  pendingTurns: number
  compactions: number
  llmCalls: { provider: string; model: string; reasoningEffort?: string; count: number }[]
  tokens: { kind: 'input' | 'output'; provider?: string; model?: string; tokens: number }[]
  toolCalls: { tool: string; count: number }[]
  events: { type: string; count: number }[]
  totalEvents: number
}

const POLL_MS = 5000

/** 千分位（与 locale 无关的紧凑格式）。 */
function fmt(n: number | undefined | null): string {
  if (n == null) return '—'
  return n >= 10000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

/** 单行条形占比（无标签重复渲染成本）。 */
function Bar({ value, max }: { value: number; max: number }): React.JSX.Element {
  const width = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0
  return <span className={css.barTrack}><span className={css.barFill} style={{ width: `${width}%` }} /></span>
}

/** 顶部汇总卡。 */
function StatCard({ label, value, accent }: { label: string; value: string; accent?: 'warn' | 'ok' }): React.JSX.Element {
  return (
    <div className={css.statCard}>
      <span className={`${css.statValue}${accent === 'warn' ? ` ${css.statWarn}` : ''}${accent === 'ok' ? ` ${css.statOk}` : ''}`}>{value}</span>
      <span className={css.statLabel}>{label}</span>
    </div>
  )
}

export function ObservabilityTabView(_props: ConvViewProps): React.JSX.Element {
  const [summary, setSummary] = useState<ObservabilitySummary | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const response = await fetch('/observability/summary', { signal: AbortSignal.timeout(5000) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      setSummary(await response.json() as ObservabilitySummary)
      setError(null)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setError(message)
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = setInterval(() => { void load() }, POLL_MS)
    return () => clearInterval(timer)
  }, [load])

  const totalCalls = summary?.llmCalls.reduce((sum, entry) => sum + entry.count, 0) ?? 0
  const totalTokens = summary?.tokens.reduce((sum, entry) => sum + entry.tokens, 0) ?? 0
  const totalTools = summary?.toolCalls.reduce((sum, entry) => sum + entry.count, 0) ?? 0
  const maxSessions = summary?.activeSessions[0]?.count ?? 0

  return (
    <div className={css.obs}>
      <div className={css.obsHeader}>
        <h3 className={css.obsTitle}>可观测性（本进程）</h3>
        <span className={css.obsMuted}>事件溯源派生 · {POLL_MS / 1000}s 刷新</span>
      </div>

      {error !== null && <p className={css.obsError}>加载失败：{error}</p>}

      {summary === null && error === null && <p className={css.obsMuted}>加载中…</p>}

      {summary !== null && (
        <>
          <div className={css.statGrid}>
            <StatCard label="活跃会话" value={fmt(summary.activeSessions.reduce((s, e) => s + e.count, 0))} />
            <StatCard label="等待续跑" value={fmt(summary.pendingTurns)} {...(summary.pendingTurns > 0 ? { accent: 'warn' as const } : {})} />
            <StatCard label="LLM 调用" value={fmt(totalCalls)} />
            <StatCard label="Token" value={fmt(totalTokens)} />
            <StatCard label="工具调用" value={fmt(totalTools)} />
            <StatCard label="压缩" value={fmt(summary.compactions)} />
          </div>

          <section className={css.obsCard}>
            <h4 className={css.obsTitle}>活跃会话 · 按预设</h4>
            {summary.activeSessions.length === 0 && <p className={css.obsMuted}>无</p>}
            {summary.activeSessions.map(({ preset, count }) => (
              <div className={css.obsRow} key={preset}>
                <span className={css.pill}>{preset}</span>
                <Bar value={count} max={maxSessions} />
                <span className={css.obsNum}>{count}</span>
              </div>
            ))}
          </section>

          <section className={css.obsCard}>
            <h4 className={css.obsTitle}>模型调用 · 按路由</h4>
            {summary.llmCalls.length === 0 && <p className={css.obsMuted}>本进程尚无模型请求</p>}
            {summary.llmCalls.map(({ provider, model, reasoningEffort, count }) => (
              <div className={css.obsRow} key={`${provider}\u0000${model}\u0000${reasoningEffort ?? ''}`}>
                <span className={css.pill}>{model}</span>
                {reasoningEffort !== undefined && <span className={css.pillSoft}>{reasoningEffort}</span>}
                <span className={css.obsMuted}>{provider}</span>
                <Bar value={count} max={totalCalls} />
                <span className={css.obsNum}>{count}</span>
              </div>
            ))}
          </section>

          <section className={css.obsCard}>
            <h4 className={css.obsTitle}>Token 用量 · 按路由</h4>
            {summary.tokens.length === 0 && <p className={css.obsMuted}>本进程尚无用量记录</p>}
            {summary.tokens.map(({ kind, model, provider, tokens }) => (
              <div className={css.obsRow} key={`${kind}\u0000${model ?? ''}\u0000${provider ?? ''}`}>
                <span className={kind === 'input' ? css.pillSoft : css.pillOk}>{(kind === 'input' ? '输入' : '输出')}</span>
                {model !== undefined && <span className={css.pill}>{model}</span>}
                {provider !== undefined && <span className={css.obsMuted}>{provider}</span>}
                <Bar value={tokens} max={totalTokens} />
                <span className={css.obsNum}>{fmt(tokens)}</span>
              </div>
            ))}
          </section>

          <section className={css.obsCard}>
            <h4 className={css.obsTitle}>工具调用 · 按工具</h4>
            {summary.toolCalls.length === 0 && <p className={css.obsMuted}>本进程尚无工具调用</p>}
            {summary.toolCalls.map(({ tool, count }) => (
              <div className={css.obsRow} key={tool}>
                <span className={css.pill}>{tool}</span>
                <Bar value={count} max={totalTools} />
                <span className={css.obsNum}>{count}</span>
              </div>
            ))}
          </section>

          <section className={css.obsCard}>
            <h4 className={css.obsTitle}>事件 · 类型分布</h4>
            {summary.events.length === 0 && <p className={css.obsMuted}>无</p>}
            {summary.events.map(({ type, count }) => (
              <div className={css.obsRow} key={type}>
                <span className={css.obsMuted}>{type}</span>
                <Bar value={count} max={summary.totalEvents} />
                <span className={css.obsNum}>{fmt(count)}</span>
              </div>
            ))}
          </section>
        </>
      )}
    </div>
  )
}
