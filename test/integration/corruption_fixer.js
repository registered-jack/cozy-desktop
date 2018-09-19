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

    const file = await cozy.files.create('file-ok-content', {name: 'file-ok'})
    await helpers.remote.pullChanges()
    await helpers.syncAll()
    should(await helpers.local.tree()).deepEqual(['file-ok'])

    const stopCorrupting = await helpers.remote.startMockingCorruptDownloads()
    const file2 = await cozy.files.create('file-corrupted-content', {name: 'file-corrupted'})
    await cozy.files.updateById(file._id, 'file-ok-new-content')

    // expect error
    await helpers.remote.pullChanges()
    await helpers.syncAll()
    should(await helpers.local.tree()).deepEqual(['file-ok'])
    const oldFile = await helpers._pouch.byRemoteIdMaybeAsync(file2._id)
    should(oldFile.errors).eql(2)
    should(oldFile.sides.remote).eql(3) // ?

    // run fixer
    await helpers._sync.fixCorruptFiles()
    await stopCorrupting()

    await helpers.syncAll()
    should(await helpers.local.tree()).deepEqual(['file-ok'])
  })
})
