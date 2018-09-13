/* @flow */

const Raven = require('raven')
const logger = require('./logger')
const log = logger({
  component: 'Sentry'
})

const { omit } = require('lodash')

const DOMAIN_REGEXP = /^https?:\/\/([a-zA-Z0-9-.]+)(?::\d{2,5})?\/?$/
const SENTRY_REF = `ed6d0a175d504ead84851717b9bdb72e:324375dbe2ae4bbf8c212ae4eaf26289`
const SENTRY_DSN = `https://${SENTRY_REF}@sentry.cozycloud.cc/91`
const DOMAIN_TO_ENV = {
  'cozy.tools': 'development',
  'cozy.works': 'development',
  'cozy.rocks': 'production',
  'mycozy.cloud': 'production'
}

const toSentryContext = cozyUrl => {
  const urlParts = cozyUrl.match(DOMAIN_REGEXP)[1].split('.')
  const domain = urlParts.slice(-2).join('.')
  const instance = urlParts.slice(-3).join('.')
  const environment = DOMAIN_TO_ENV[domain] || 'selfhost'
  return { domain, instance, environment }
}

const fatalErrorHandler = (err, sendErr, eventId) => {
  if (sendErr) log.error({err, sendErr}, 'Fatal error, unable to send to sentry')
  else log.error({err, eventId}, 'Fatal error, sent to sentry')
  process.exit(1) // eslint-disable-line no-process-exit
}

const bunyanErrToSentry = (data) => {
  if (data instanceof Error) return data
  const error = new Error(data.message)
  error.name = data.name
  error.stack = data.stack
  error.code = data.code
  error.signal = data.signal
  return error
}

let isRavenConfigured = false

const setup = (clientInfos) => {
  try {
    const { appVersion, cozyUrl } = clientInfos
    const { domain, instance, environment } = toSentryContext(cozyUrl)
    Raven.config(SENTRY_DSN, {
      release: appVersion,
      environment,
      tags: { domain, instance }
    }).install(fatalErrorHandler)

    isRavenConfigured = true
    log.info('Raven configured !')
  } catch (err) {
    log.error({err}, 'Could not load Raven, errors will not be sent to Sentry')
  }
}

const handleBunyanMessage = (msg) => {
  const level = msg.level >= 50 ? 'error' : msg.level === 40 ? 'warning' : 'info'

  if (!isRavenConfigured) return

  // for now only logs marked explicitly for sentry get sent
  if (msg.sentry || (msg.err && msg.err.sentry)) {
    if (msg.err) {
      const extra = omit(msg, 'err', 'tags')
      Raven.captureException(bunyanErrToSentry(msg.err), { extra, level })
    } else {
      const extra = omit(msg, 'msg', 'tags')
      Raven.captureMessage(msg.msg, { extra, level })
    }
  } else { // keep it as breadcrumb
    Raven.captureBreadcrumb({
      msg: msg.msg,
      category: msg.component,
      data: omit(msg, ['component', 'pid', 'name', 'hostname', 'level', 'time', 'v', 'msg'])
    })
  }
}

function flag (err/*: Error */) {
  err.sentry = true
  return err
}

if (!process.env.DEBUG && !process.env.TESTDEBUG && !process.env.COZY_NO_SENTRY) {
  logger.defaultLogger.addStream({
    type: 'raw',
    stream: { write: handleBunyanMessage }
  })
}

module.exports = {
  setup,
  flag
}
