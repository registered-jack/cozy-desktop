/* @flow */
/* eslint-env mocha */

const Promise = require('bluebird')
const _ = require('lodash')
const should = require('should')

const logger = require('../../core/logger')

const { IntegrationTestHelpers } = require('../support/helpers/integration')
const configHelpers = require('../support/helpers/config')
const cozyHelpers = require('../support/helpers/cozy')
const pouchHelpers = require('../support/helpers/pouch')

const log = logger({component: 'mocha'})

describe('Replace file', () => {
  let cozy, helpers

  before(configHelpers.createConfig)
  before(configHelpers.registerClient)
  beforeEach(pouchHelpers.createDatabase)
  beforeEach(cozyHelpers.deleteAll)

  afterEach(pouchHelpers.cleanDatabase)
  after(configHelpers.cleanConfig)

  beforeEach(async function () {
    cozy = cozyHelpers.cozy
    helpers = new IntegrationTestHelpers(this.config, this.pouch, cozy)

    await helpers.local.setupTrash()
    await helpers.remote.ignorePreviousChanges()
  })

  describe('inode change', () => {
    it('does not need a remote sync', async () => {
      log.info('-------- initial file --------')
      const initialContent = 'Initial content'
      const remoteFile = await cozy.files.create(initialContent, {name: 'file'})
      await helpers.remote.pullChanges()
      await helpers.syncAll()
      const file = await helpers._pouch.byRemoteIdAsync(remoteFile._id)
      should(await helpers.local.tree()).deepEqual([
        file.path
      ])

      log.info('-------- file copy by third-party software --------')
      const copy = await helpers.local.syncDir.copyOutside(file)

      log.info('-------- start local watcher with buffer in idle mode --------')
      await helpers.local.startWatcherIdle()

      log.info('-------- file replacement --------')
      await helpers.local.syncDir.unlink(file)
      await Promise.delay(1000)
      await helpers.local.syncDir.move(copy, file)
      const { ino } = await helpers.local.syncDir.stat(file)
      should(ino).not.equal(file.ino)
      log.info({ino: {old: file.ino, new: ino}})

      log.info('-------- wait for events --------')
      await helpers.local.waitForEvents([
        'add',
        'unlink'
      ], 5000)

      log.info('-------- fake reversed events --------')
      const buffer = helpers.local.local.watcher.buffer
      buffer.events = _.chain(buffer.events).sortBy('type').reverse().value()

      log.info('-------- stop local watcher i.e. also flush buffer --------')
      await helpers.local.local.watcher.stop()

      log.info('-------- remote sync --------')
      await helpers.syncAll()

      should({
        localTree: await helpers.local.tree(),
        remoteTree: await helpers.remote.tree(),
        remoteFileContent: await helpers.remote.readFile('file').catch(err => {
          log.error(err)
          return `<Error ${JSON.stringify(err.message)}>`
        })
      }).deepEqual({
        localTree: [
          'file'
        ],
        remoteTree: [
          '.cozy_trash/',
          'file'
        ],
        remoteFileContent: initialContent
      })
    })
  })
})
