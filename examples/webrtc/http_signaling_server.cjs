/** Express demo for the copyable, MAGPIE-independent HTTP signaling relay.
 *
 * From the repository root: npm install --no-save express cors
 *                           node examples/webrtc/http_signaling_server.cjs
 */

const express = require('express')
const cors = require('cors')
const { InMemoryRelay, SignalingHTTP, createNodeHandler } = require('./http_signaling/relay.cjs')

const app = express()
const configuredOrigins = (process.env.MAGPIE_SIGNAL_ALLOWED_ORIGINS || '')
  .split(',').map(value => value.trim()).filter(Boolean)
const localOrigin = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/

app.use('/signal', cors({
  origin: (origin, done) => done(null, Boolean(origin && (
    configuredOrigins.length ? configuredOrigins.includes(origin) : localOrigin.test(origin)
  ))),
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  exposedHeaders: ['X-Magpie-Sequence'],
}))

app.use('/signal', (req, res, next) => {
  const token = process.env.MAGPIE_SIGNAL_TOKEN
  if (token && req.get('Authorization') !== `Bearer ${token}`) return res.sendStatus(401)
  next()
})

app.use('/signal', createNodeHandler(new SignalingHTTP(new InMemoryRelay())))

const host = process.env.MAGPIE_SIGNAL_HOST || '127.0.0.1'
const port = Number(process.env.MAGPIE_SIGNAL_PORT || 8000)
app.listen(port, host, () => console.log(`Signaling relay: http://${host}:${port}/signal`))
