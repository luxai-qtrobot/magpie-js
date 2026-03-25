const LEVELS = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 } as const
type Level = keyof typeof LEVELS

function _timestamp(): string {
  const now = new Date()
  const y  = now.getFullYear()
  const mo = String(now.getMonth() + 1).padStart(2, '0')
  const d  = String(now.getDate()).padStart(2, '0')
  const h  = String(now.getHours()).padStart(2, '0')
  const mi = String(now.getMinutes()).padStart(2, '0')
  const s  = String(now.getSeconds()).padStart(2, '0')
  const ms = String(now.getMilliseconds()).padStart(3, '0')
  return `${y}.${mo}.${d} ${h}:${mi}:${s}.${ms}`
}

const _isBrowser = typeof window !== 'undefined' && typeof window.document !== 'undefined'

let _level: Level = 'INFO'

function _log(
  fn: (...args: unknown[]) => void,
  label: string,
  ansiColor: string,
  cssColor: string,
  msg: string,
): void {
  const ts = _timestamp()
  if (_isBrowser) {
    fn(`%c[${label}] [${ts}]:%c ${msg}`, `color:${cssColor};font-weight:bold`, 'color:inherit')
  } else {
    fn(`${ansiColor}[${label}] [${ts}]:\x1b[0m ${msg}`)
  }
}

export const Logger = {
  setLevel(level: string): void {
    const up = level.toUpperCase() as Level
    if (up in LEVELS) _level = up
  },

  debug(msg: string): void {
    if (LEVELS.DEBUG < LEVELS[_level]) return
    _log(console.debug, 'DEBUG', '\x1b[90m', '#808080', msg)
  },

  info(msg: string): void {
    if (LEVELS.INFO < LEVELS[_level]) return
    _log(console.info, 'INFO ', '\x1b[32m', '#22a722', msg)
  },

  warning(msg: string): void {
    if (LEVELS.WARN < LEVELS[_level]) return
    _log(console.warn, 'WARN ', '\x1b[33m', '#e6a817', msg)
  },

  error(msg: string): void {
    if (LEVELS.ERROR < LEVELS[_level]) return
    _log(console.error, 'ERROR', '\x1b[31m', '#e03030', msg)
  },
}
