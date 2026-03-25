import mqtt, { MqttClient, IClientOptions } from 'mqtt'
import { Logger } from '../../utils/logger'
import { getUniqueId } from '../../utils/common'
import { MqttOptions } from './MqttOptions'

type MessageCallback = (payload: Uint8Array, topic: string) => void

/**
 * Shared MQTT broker connection.
 *
 * One MqttConnection per broker — share it across MqttPublisher,
 * MqttSubscriber, MqttRpcRequester, MqttRpcResponder instances.
 *
 * Supported URI schemes: mqtt://, mqtts://, ws://, wss://
 * TLS is handled at the transport level (wss:// or mqtts://);
 * no certificate file options are needed from JS.
 */
export class MqttConnection {
  readonly uri: string
  readonly clientId: string
  readonly options: MqttOptions

  private _client: MqttClient | null = null
  private _subscriptions = new Map<string, Set<MessageCallback>>()

  constructor(uri: string, options?: MqttOptions & { clientId?: string }) {
    this.uri = uri
    this.clientId = options?.clientId ?? `magpie-${getUniqueId()}`
    this.options = options ?? {}
  }

  get isConnected(): boolean {
    return this._client?.connected ?? false
  }

  /**
   * Connect to the broker.
   * @param timeout  Max milliseconds to wait for the initial connection (default 10 000).
   */
  connect(timeout = 10_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const mqttOpts: IClientOptions = {
        clientId: this.clientId,
        clean: this.options.session?.cleanStart ?? true,
        reconnectPeriod: (this.options.reconnect?.minDelaySec ?? 1) * 1000,
        connectTimeout: timeout,
      }

      const auth = this.options.auth
      if (auth && auth.mode !== 'none') {
        mqttOpts.username = auth.username
        if (auth.mode === 'username_password') {
          mqttOpts.password = auth.password
        }
      }

      const will = this.options.will
      if (will?.enabled) {
        mqttOpts.will = {
          topic: will.topic,
          payload: will.payload,
          qos: will.qos ?? 0,
          retain: will.retain ?? false,
        }
      }

      let settled = false
      const settle = (fn: () => void) => {
        if (!settled) { settled = true; fn() }
      }

      const timer = setTimeout(() => {
        settle(() => reject(new Error(`MqttConnection(${this.clientId}): connect timeout after ${timeout}ms`)))
      }, timeout)

      try {
        this._client = mqtt.connect(this.uri, mqttOpts)
      } catch (err) {
        clearTimeout(timer)
        settle(() => reject(err))
        return
      }

      this._client.on('connect', () => {
        clearTimeout(timer)
        Logger.info(`MqttConnection(${this.clientId}): connected to ${this.uri}`)
        this._resubscribeAll()
        settle(() => resolve())
      })

      this._client.on('reconnect', () => {
        Logger.info(`MqttConnection(${this.clientId}): reconnecting...`)
        this._resubscribeAll()
      })

      this._client.on('error', (err: Error) => {
        Logger.error(`MqttConnection(${this.clientId}): connect error: ${err.message}`)
        clearTimeout(timer)
        settle(() => reject(err))
      })

      this._client.on('message', (topic: string, payload: Buffer) => {
        this._dispatch(topic, new Uint8Array(payload))
      })

      this._client.on('disconnect', () => {
        Logger.info(`MqttConnection(${this.clientId}): disconnected`)
      })
    })
  }

  disconnect(): Promise<void> {
    return new Promise((resolve) => {
      if (!this._client) { resolve(); return }
      this._client.end(false, {}, () => {
        Logger.info(`MqttConnection(${this.clientId}): closed`)
        resolve()
      })
    })
  }

  async publish(topic: string, payload: Uint8Array, qos?: 0 | 1 | 2, retain?: boolean): Promise<void> {
    if (!this._client) throw new Error('MqttConnection: not connected')
    const q = qos ?? this.options.defaults?.publishQos ?? 0
    const r = retain ?? this.options.defaults?.publishRetain ?? false
    await this._client.publishAsync(topic, payload as unknown as Buffer, { qos: q, retain: r })
  }

  addSubscription(topic: string, callback: MessageCallback, qos?: 0 | 1 | 2): void {
    if (!this._subscriptions.has(topic)) {
      this._subscriptions.set(topic, new Set())
    }
    this._subscriptions.get(topic)!.add(callback)

    if (this._client?.connected) {
      const q = qos ?? this.options.defaults?.subscribeQos ?? 0
      this._client.subscribe(topic, { qos: q }, (err) => {
        if (err) Logger.warning(`MqttConnection: subscribe error on '${topic}': ${err.message}`)
        else Logger.debug(`MqttConnection: subscribed to '${topic}'`)
      })
    }
  }

  removeSubscription(topic: string, callback: MessageCallback): void {
    const callbacks = this._subscriptions.get(topic)
    if (!callbacks) return
    callbacks.delete(callback)
    if (callbacks.size === 0) {
      this._subscriptions.delete(topic)
      this._client?.unsubscribe(topic)
    }
  }

  // ----------------------------------------------------------------
  // Private
  // ----------------------------------------------------------------

  private _resubscribeAll(): void {
    for (const [topic] of this._subscriptions) {
      const q = this.options.defaults?.subscribeQos ?? 0
      this._client?.subscribe(topic, { qos: q })
    }
  }

  private _dispatch(receivedTopic: string, payload: Uint8Array): void {
    for (const [pattern, callbacks] of this._subscriptions) {
      if (_mqttTopicMatches(pattern, receivedTopic)) {
        for (const cb of callbacks) {
          try { cb(payload, receivedTopic) } catch (e) {
            Logger.warning(`MqttConnection: callback error on '${receivedTopic}': ${e}`)
          }
        }
      }
    }
  }
}

/** MQTT topic pattern matching — handles + (single level) and # (multi level). */
function _mqttTopicMatches(pattern: string, topic: string): boolean {
  const pp = pattern.split('/')
  const tp = topic.split('/')
  for (let i = 0; i < pp.length; i++) {
    if (pp[i] === '#') return true
    if (i >= tp.length) return false
    if (pp[i] !== '+' && pp[i] !== tp[i]) return false
  }
  return pp.length === tp.length
}
