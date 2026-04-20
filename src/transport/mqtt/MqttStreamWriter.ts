import { StreamWriter } from '../StreamWriter'
import { MsgpackSerializer } from '../../serializer/MsgpackSerializer'
import { BaseSerializer } from '../../serializer/BaseSerializer'
import { Logger } from '../../utils/logger'
import { MqttConnection } from './MqttConnection'

/**
 * MQTT-based stream publisher — implements StreamWriter.
 *
 * Usage:
 *   const conn = new MqttConnection('mqtt://broker.example.com:1883')
 *   await conn.connect()
 *   const pub = new MqttStreamWriter(conn)
 *   await pub.write({ sensor: 'temp', value: 22.5 }, 'sensors/temperature')
 *   pub.close()
 *   await conn.disconnect()
 */
export class MqttStreamWriter extends StreamWriter {
  private _connection: MqttConnection
  private _serializer: BaseSerializer
  private _qos?: 0 | 1 | 2
  private _retain?: boolean

  constructor(
    connection: MqttConnection,
    options?: {
      serializer?: BaseSerializer
      qos?: 0 | 1 | 2
      retain?: boolean
    }
  ) {
    super()
    this._connection = connection
    this._serializer = options?.serializer ?? new MsgpackSerializer()
    this._qos = options?.qos
    this._retain = options?.retain
    Logger.debug(`MqttStreamWriter: ready (broker=${connection.uri})`)
  }

  async write(data: unknown, topic: string): Promise<void> {
    if (!topic) {
      Logger.warning('MqttStreamWriter: write() called without a topic — message dropped.')
      return
    }
    try {
      const payload = this._serializer.serialize(data)
      await this._connection.publish(topic, payload, this._qos, this._retain)
    } catch (e) {
      Logger.warning(`MqttStreamWriter: write failed on topic '${topic}': ${e}`)
    }
  }

  close(): void {
    // Connection is shared; closing the publisher does NOT disconnect.
    Logger.debug('MqttStreamWriter: closed.')
  }
}
