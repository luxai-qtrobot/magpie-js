/**
 * Authentication options.
 * mTLS (client certificates) is NOT supported from browser JS —
 * use 'username_password' or 'token' (JWT/API key in the username field).
 * TLS itself is handled at the transport level via wss:// URIs.
 */
export interface MqttAuthOptions {
  mode: 'none' | 'username_password' | 'token'
  /** Username or token value */
  username?: string
  /** Password (only for 'username_password' mode) */
  password?: string
}

export interface MqttWillOptions {
  enabled: boolean
  topic: string
  payload: string
  qos?: 0 | 1 | 2
  retain?: boolean
}

export interface MqttSessionOptions {
  cleanStart?: boolean
  sessionExpiryInterval?: number
}

export interface MqttReconnectOptions {
  /** Minimum reconnect delay in seconds (default 1) */
  minDelaySec?: number
  /** Maximum reconnect delay in seconds (default 30) */
  maxDelaySec?: number
}

export interface MqttDefaultsOptions {
  publishQos?: 0 | 1 | 2
  subscribeQos?: 0 | 1 | 2
  publishRetain?: boolean
}

export interface MqttOptions {
  auth?: MqttAuthOptions
  will?: MqttWillOptions
  session?: MqttSessionOptions
  reconnect?: MqttReconnectOptions
  defaults?: MqttDefaultsOptions
}
