/** `restartBanner` namespace dictionaries (the coordinated-restart banner copy). */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'banner.title': 'DSH 正在重启…',
  'banner.body': '等待正在进行的回合到达安全边界后退出；已等待 {elapsedSeconds} 秒，正在执行的写工具最多等待 {capSeconds} 秒。',
  'banner.aria': '主机协调重启进行中',
} satisfies Record<string, string>

/** The restart-banner namespace key union. */
export type RestartBannerKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'banner.title': 'DSH is restarting…',
  'banner.body': 'Waiting for live turns to settle at a safe boundary; {elapsedSeconds}s elapsed, in-flight write tools wait up to {capSeconds} seconds.',
  'banner.aria': 'Host coordinated restart in progress',
} satisfies Record<RestartBannerKey, string>
