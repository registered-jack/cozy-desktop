/* @flow */

const {
  after,
  afterEach,
  before,
  beforeEach,
  suite,
  test
} = require('mocha')
const should = require('should')

const configHelpers = require('../support/helpers/config')
const cozyHelpers = require('../support/helpers/cozy')
const pouchHelpers = require('../support/helpers/pouch')
const { IntegrationTestHelpers } = require('../support/helpers/integration')

const cozy = cozyHelpers.cozy

suite('Re-Upload files when the stack report them as broken', () => {
  let helpers

  before(configHelpers.createConfig)
  before(configHelpers.registerClient)
  beforeEach(pouchHelpers.createDatabase)
  beforeEach(cozyHelpers.deleteAll)

  afterEach(() => helpers.local.clean())
  afterEach(pouchHelpers.cleanDatabase)
  after(configHelpers.cleanConfig)

  beforeEach(function () {
    helpers = new IntegrationTestHelpers(this.config, this.pouch, cozy)
    helpers.local.setupTrash()
  })

  test('Handle corrupted files', async () => {
    await helpers.remote.ignorePreviousChanges()
    const stopCorrupting = await helpers.remote.startMockingCorruptDownloads()
    const file = await cozy.files.create('basecontent', {name: 'file'})
    await helpers.remote.pullChanges()

    // expect error
    await helpers.syncAll()
    should(await helpers.local.tree()).deepEqual([])
    const oldFile = await helpers._pouch.byRemoteIdMaybeAsync(file._id)
    should(oldFile.errors).eql(2)
    should(oldFile.sides.remote).eql(3) // ?

    // run fixer
    await helpers._sync.fixCorruptFiles()
    await stopCorrupting()

    await helpers.remote.pullChanges()
    await helpers.syncAll()
  })
})
