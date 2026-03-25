import { monotonicFactory } from 'ulidx'

const _ulid = monotonicFactory()

/**
 * Returns a UTC timestamp as seconds since epoch (float).
 * Matches Python's: datetime.datetime.now(timezone.utc).timestamp()
 */
export function getUtcTimestamp(): number {
  return Date.now() / 1000
}

/**
 * Generates a unique identifier using ULID.
 * Matches Python's: str(ULID())
 */
export function getUniqueId(): string {
  return _ulid()
}
