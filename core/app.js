/* @flow */

const autoBind = require('auto-bind')
const fs = require('fs-extra')
const _ = require('lodash')
const os = require('os')
const path = require('path')
const readdirp = require('readdirp')
const url = require('url')
const uuid = require('uuid/v4')
const https = require('https')
const {createGzip} = require('zlib')

require('./globals') // FIXME Use bluebird promises as long as we need asCallback
const pkg = require('../package.json')
const Config = require('./config')
const logger = require('./logger')
const sentry = require('./sentry')
const { LOG_FILE, LOG_FILENAME } = logger
const Pouch = require('./pouch')
const Ignore = require('./ignore')
const Merge = require('./merge')
const Prep = require('./prep')
const Local = require('./local')
const Remote = require('./remote')
const Sync = require('./sync')
const SyncState = require('./syncstate')
const Registration = require('./remote/registration')

/*::
import type EventEmitter from 'events'
import type stream from 'stream'
import type { Callback } from './utils/func'
import type { SyncMode } from './sync'
*/

const log = logger({
  component: 'App'
})

const SUPPORT_EMAIL = process.env.COZY_DESKTOP_SUPPORT_EMAIL || 'contact@cozycloud.cc'

// App is the entry point for the CLI and GUI.
// They both can do actions and be notified by events via an App instance.
class App {
  /*::
  lang: string
  basePath: string
  config: Config
  pouch: Pouch
  events: EventEmitter
  ignore: Ignore
  merge: Merge
  prep: Prep
  local: Local
  remote: Remote
  sync: Sync
  */

  // basePath is the directory where the config and pouch are saved
  constructor (basePath /*: string */) {
    log.info(this.clientInfo(), 'constructor')
    this.lang = 'fr'
    if (basePath == null) { basePath = os.homedir() }
    basePath = path.resolve(basePath)
    this.basePath = path.join(basePath, '.cozy-desktop')
    this.config = new Config(this.basePath)
    this.pouch = new Pouch(this.config)
    this.events = new SyncState()

    autoBind(this)
  }

  // Parse the URL
  parseCozyUrl (cozyUrl /*: string */) {
    if (cozyUrl.indexOf(':') === -1) {
      if (cozyUrl.indexOf('.') === -1) {
        cozyUrl += '.cozycloud.cc'
      }
      cozyUrl = `https://${cozyUrl}`
    }
    return url.parse(cozyUrl)
  }

  // Check that the cozyUrl is valid
  checkCozyUrl (cozyUrl /*: string */) {
    let parsed = this.parseCozyUrl(cozyUrl)
    cozyUrl = url.format(parsed)
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
      let err = new Error(`Your URL looks invalid: ${cozyUrl}`)
      log.warn(err)
      throw err
    }
    return cozyUrl
  }

  // Returns an object including the syncPath only when valid, or with an error
  // otherwise.
  checkSyncPath (syncPath /*: string */) {
    // We do not allow syncing the whole user home directory, the system users
    // directory or the whole system:
    // - It would probably to big regarding the current local events squashing
    //   implementation.
    // - It could conflict with another synchronization tool.
    // - Writing some third-party file with the corresponding app running could
    //   make it crash.
    // - Some files are device-specific and should not be synchronized anyway.
    //
    // We could exclude relevant files by default at some point, but it would
    // require many iterations to make it reliable.
    if ((os.homedir() + path.sep).startsWith(syncPath)) {
      return {syncPath, error: 'You cannot synchronize your whole system or personal folder'}
    }

    return {syncPath}
  }

  // Return a promise for registering a device on the remote cozy
  registerRemote (cozyUrl /*: string */, redirectURI /*: ?string */, onRegistered /*: ?Function */, deviceName /*: string */) {
    const registration = new Registration(cozyUrl, this.config)
    return registration.process(pkg, redirectURI, onRegistered, deviceName)
  }

  // Save the config with all the informations for synchonization
  saveConfig (cozyUrl /*: string */, syncPath /*: string */) {
    fs.ensureDirSync(syncPath)
    this.config.cozyUrl = cozyUrl
    this.config.syncPath = syncPath
    this.config.persist()
    log.info('The remote Cozy has properly been configured ' +
             'to work with current device.')
  }

  // Register current device to remote Cozy and then save related informations
  // to the config file (used by CLI, not GUI)
  async addRemote (cozyUrl /*: string */, syncPath /*: string */, deviceName /*: string */) {
    try {
      const registered = await this.registerRemote(cozyUrl, null, null, deviceName)
      log.info(`Device ${registered.deviceName} has been added to ${cozyUrl}`)
      this.saveConfig(cozyUrl, syncPath)
    } catch (err) {
      log.error('An error occured while registering your device.')
      let parsed /*: Object */ = this.parseCozyUrl(cozyUrl)
      if (err.code === 'ENOTFOUND') {
        log.warn(`The DNS resolution for ${parsed.hostname} failed.`)
        log.warn('Are you sure the domain is OK?')
      } else if (err === 'Bad credentials') {
        log.warn(err)
        log.warn('Are you sure there are no typo on the passphrase?')
      } else {
        log.error(err)
        if (parsed.protocol === 'http:') {
          log.warn('Did you try with an httpS URL?')
        }
      }
    }
  }

  // Unregister current device from remote Cozy and then remove remote from
  // the config file
  async removeRemote () {
    try {
      if (!this.remote) {
        this.instanciate()
      }
      await this.remote.unregister()
      await this.removeConfig()
      log.info('Current device properly removed from remote cozy.')
      return null
    } catch (err) {
      log.error('An error occured while unregistering your device.')
      log.error(err)
      return err
    }
  }

  async removeConfig () {
    await this.pouch.db.destroy()
    for (const name of await fs.readdir(this.basePath)) {
      if (name.startsWith(LOG_FILENAME)) continue
      await fs.remove(path.join(this.basePath, name))
    }
  }

  async uploadFileToSupport (incident /*: string */, name /*: string */, data /*: string|stream.Readable */) {
    return new Promise((resolve, reject) => {
      const req = https.request({
        method: 'PUT',
        protocol: 'https:',
        hostname: 'desktop-upload.cozycloud.cc',
        path: `/${incident}/${name}`,
        headers: {
          'Content-Type': 'text/plain'
        }
      }, (res) => {
        if (res.statusCode === 201) {
          resolve(null)
        } else {
          reject(new Error('Bad Status, expected 201, got ' + res.statusCode))
        }
      })
      req.on('error', reject)

      if (typeof data === 'string') {
        req.write(data)
        req.end()
      } else {
        data.pipe(req)
      }
    })
  }

  // Send an issue by mail to the support
  async sendMailToSupport (content /*: string */) {
    const incidentID = uuid()
    const zipper = createGzip({
      // TODO tweak this values, low resources for now.
      memLevel: 7,
      level: 3
    })
    const logs = fs.createReadStream(LOG_FILE)
    const pouchdbTree = await this.pouch.treeAsync()

    const logsSent = Promise.all([
      this.uploadFileToSupport(incidentID, 'logs.gz', logs.pipe(zipper)),
      this.uploadFileToSupport(incidentID, 'pouchdtree.json', JSON.stringify(pouchdbTree))
    ]).catch((err) => {
      log.error({err}, 'FAILED TO SEND LOGS')
    })

    content = content + '\r\n\r\n-------- debug info --------\r\n' +
      _.map(this.clientInfo(), (v, k) => `${k}: ${v}`).join('\r\n') +
    '\r\n\r\n-------- log status --------\r\n' +
    `incidentID: ${incidentID}`

    const args = {
      mode: 'from',
      to: [
        { name: 'Support', email: SUPPORT_EMAIL }
      ],
      subject: 'Ask support for cozy-desktop',
      parts: [
        { type: 'text/plain', body: content }
      ]
    }
    const mailSent = this.remote.sendMail(args)

    return Promise.all([mailSent, logsSent])
  }

  // Load ignore rules
  loadIgnore () {
    let ignored
    try {
      let syncPath = this.config.syncPath
      ignored = fs.readFileSync(path.join(syncPath, '.cozyignore'))
      ignored = ignored.toString().split('\n')
    } catch (error) {
      ignored = []
    }
    this.ignore = new Ignore(ignored).addDefaultRules()
  }

  // Instanciate some objects before sync
  instanciate () {
    this.loadIgnore()
    this.merge = new Merge(this.pouch)
    this.prep = new Prep(this.merge, this.ignore, this.config)
    this.local = this.merge.local = new Local(this.config, this.prep, this.pouch, this.events)
    this.remote = this.merge.remote = new Remote(this.config, this.prep, this.pouch, this.events)
    this.sync = new Sync(this.pouch, this.local, this.remote, this.ignore, this.events)
    this.sync.diskUsage = this.diskUsage
  }

  // Start the synchronization
  startSync (mode /*: SyncMode */) {
    this.config.saveMode(mode)
    log.info('Run first synchronisation...')
    return this.sync.start(mode)
  }

  // Stop the synchronisation
  stopSync () {
    if (!this.sync) {
      // $FlowFixMe
      return Promise.resolve()
    }
    return this.sync.stop()
  }

  // Start database sync process and setup file change watcher
  synchronize (mode /*: SyncMode */) {
    log.info(this.clientInfo(), 'synchronize')
    sentry.setup(this.clientInfo())
    if (!this.config.isValid()) {
      log.error('No configuration found, please run add-remote-cozy' +
                'command before running a synchronization.')
      throw new Error('No client configured')
    }
    this.instanciate()
    return this.startSync(mode)
  }

  // Display a list of watchers for debugging purpose
  debugWatchers () {
    if (this.local) {
      this.local.watcher.debug()
    }
  }

  clientInfo () {
    const config = this.config || {}

    return {
      appVersion: pkg.version,
      configPath: config.configPath,
      configVersion: config.version,
      cozyUrl: config.cozyUrl,
      deviceName: config.deviceName,
      osType: os.type(),
      osRelease: os.release(),
      osArch: os.arch(),
      permissions: config.permissions,
      syncPath: config.syncPath
    }
  }

  // Call the callback for each file
  walkFiles (args /*: {ignored?: any} */, callback /*: Callback */) {
    this.loadIgnore()
    let options = {
      root: this.config.syncPath,
      directoryFilter: '!.cozy-desktop',
      entryType: 'both'
    }
    readdirp(options)
      .on('warn', err => log.warn(err))
      .on('error', err => log.error(err))
      .on('data', data => {
        let doc = {
          _id: data.path,
          docType: data.stat.isFile() ? 'file' : 'folder'
        }
        if (this.ignore.isIgnored(doc) === (args.ignored != null)) {
          callback(data.path)
        }
      })
  }

  // Recreate the local pouch database
  resetDatabase () {
    log.info('Recreates the local database...')
    this.pouch.resetDatabase(function () {
      log.info('Database recreated')
    })
  }

  // Return the whole content of the database
  allDocs (callback /*: Callback */) {
    this.pouch.db.allDocs({include_docs: true}, callback)
  }

  // Return all docs for a given query
  query (query /*: any */, callback /*: Callback */) {
    this.pouch.db.query(query, {include_docs: true}, callback)
  }

  // Get disk space informations from the cozy
  diskUsage ()/*: Promise<*> */ {
    if (!this.remote) this.instanciate()
    return this.remote.diskUsage()
  }
}

module.exports = {
  App,
  logger
}
