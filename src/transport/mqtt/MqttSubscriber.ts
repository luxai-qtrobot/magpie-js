import { StreamReader } from '../StreamReader'
import { MsgpackSerializer } from '../../serializer/MsgpackSerializer'
import { BaseSerializer } from '../../serializer/BaseSerializer'
import { Logger } from '../../utils/logger'
import { MqttConnection } from './MqttConnection'

export class TimeoutError extends Error {
  constructor(message?: string) {
    super(message ?? 'read timeout')
    this.name = 'TimeoutError'
  }
}

interface Waiter {
  resolve: (value: [unknown, string]) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout> | null
}

/**
 * MQTT-based stream subscriber — implements StreamReader.
 * Supports wildcard topics (+ and #).
 *
 * Usage:
 *   const conn = new MqttConnection('mqtt://broker.example.com:1883')
 *   await conn.connect()
 *   const sub = new MqttSubscriber(conn, { topic: 'sensors/temperature' })
 *   const [data, topic] = await sub.read(5.0)
 *   sub.close()
 *   await conn.disconnect()
 */
export class MqttSubscriber extends StreamReader {
  private _connection: MqttConnection
  private _serializer: BaseSerializer
  private _topic: string
  private _qos?: 0 | 1 | 2
  private _queueSize: number
  private _queue: [unknown, string][] = []
  private _waiters: Waiter[] = []
  private _closed = false

  constructor(
    connection: MqttConnection,
    options: {
      topic: string
      serializer?: BaseSerializer
      qos?: 0 | 1 | 2
      queueSize?: number
    }
  ) {
    super()
    this._connection = connection
    this._topic = options.topic
    this._serializer = options.serializer ?? new MsgpackSerializer()
    this._qos = options.qos
    this._queueSize = options.queueSize ?? 10

    connection.addSubscription(this._topic, this._onMessage.bind(this), this._qos)
    Logger.debug(`MqttSubscriber: subscribed to '${this._topic}'`)
  }

  async read(timeout?: number): Promise<[unknown, string]> {
    if (this._closed) throw new Error('MqttSubscriber: already closed')

    if (this._queue.length > 0) {
      return this._queue.shift()!
    }

    return new Promise<[unknown, string]>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null

      const waiter: Waiter = { resolve, reject, timer: null }

      if (timeout !== undefined) {
        timer = setTimeout(() => {
          this._waiters = this._waiters.filter(w => w !== waiter)
          reject(new TimeoutError(`MqttSubscriber: read timeout after ${timeout}s`))
        }, timeout * 1000)
        waiter.timer = timer
      }

      this._waiters.push(waiter)
    })
  }

  close(): void {
    this._closed = true
    this._connection.removeSubscription(this._topic, this._onMessage.bind(this))
    // Reject all pending waiters
    for (const waiter of this._waiters) {
      if (waiter.timer) clearTimeout(waiter.timer)
      waiter.reject(new Error('MqttSubscriber: closed'))
    }
    this._waiters = []
    Logger.debug(`MqttSubscriber: closed ('${this._topic}')`)
  }

  // ----------------------------------------------------------------
  // Private
  // ----------------------------------------------------------------

  private _onMessage(payload: Uint8Array, topic: string): void {
    let data: unknown
    try {
      data = this._serializer.deserialize(payload)
    } catch (e) {
      Logger.warning(`MqttSubscriber: deserialization error for topic '${topic}': ${e}`)
      return
    }

    // If a waiter is pending, deliver immediately
    if (this._waiters.length > 0) {
      const waiter = this._waiters.shift()!
      if (waiter.timer) clearTimeout(waiter.timer)
      waiter.resolve([data, topic])
      return
    }

    // Otherwise buffer — drop oldest if full (latest-value semantics)
    if (this._queue.length >= this._queueSize) {
      this._queue.shift()
    }
    this._queue.push([data, topic])
  }
}
