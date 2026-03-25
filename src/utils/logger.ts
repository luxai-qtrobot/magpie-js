function _timestamp(): string {
  const now = new Date()
  const y = now.getFullYear()
  const mo = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  const h = String(now.getHours()).padStart(2, '0')
  const mi = String(now.getMinutes()).padStart(2, '0')
  const s = String(now.getSeconds()).padStart(2, '0')
  const ms = String(now.getMilliseconds()).padStart(3, '0')
  return `${y}.${mo}.${d} ${h}:${mi}:${s}.${ms}`
}

export const Logger = {
  debug(msg: string): void {
    console.debug(`[DEBUG] [${_timestamp()}]: ${msg}`)
  },
  info(msg: string): void {
    console.info(`[INFO]  [${_timestamp()}]: ${msg}`)
  },
  warning(msg: string): void {
    console.warn(`[WARN]  [${_timestamp()}]: ${msg}`)
  },
  error(msg: string): void {
    console.error(`[ERROR] [${_timestamp()}]: ${msg}`)
  },
}
