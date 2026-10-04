const TZ = 'America/Mexico_City'

const timeFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: '2-digit', minute: '2-digit' })
const dateFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const rtf = new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' })

export const formatTime = (iso: string | number) => timeFmt.format(new Date(iso))
export const formatDate = (iso: string) => dateFmt.format(new Date(iso))

export function formatRelative(iso: string, now = Date.now()) {
  const diffMin = Math.round((new Date(iso).getTime() - now) / 60_000)
  if (Math.abs(diffMin) < 60) return rtf.format(diffMin, 'minute')
  const diffH = Math.round(diffMin / 60)
  if (Math.abs(diffH) < 48) return rtf.format(diffH, 'hour')
  return rtf.format(Math.round(diffH / 24), 'day')
}
