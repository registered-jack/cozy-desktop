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

const Builders = require('../support/builders')
const configHelpers = require('../support/helpers/config')
const cozyHelpers = require('../support/helpers/cozy')
const pouchHelpers = require('../support/helpers/pouch')
const { IntegrationTestHelpers } = require('../support/helpers/integration')

suite('Handle Bad Remote', () => {
  if (process.env.APPVEYOR) {
    test('is unstable on AppVeyor')
    return
  }

  let cozy, helpers, pouch

  before(configHelpers.createConfig)
  before(configHelpers.registerClient)
  beforeEach(pouchHelpers.createDatabase)
  beforeEach(cozyHelpers.deleteAll)

  afterEach(() => helpers.local.clean())
  afterEach(pouchHelpers.cleanDatabase)
  after(configHelpers.cleanConfig)

  beforeEach(async function () {
    cozy = cozyHelpers.cozy
    helpers = new IntegrationTestHelpers(this.config, this.pouch, cozy)
    pouch = helpers._pouch

    await helpers.local.setupTrash()
    await helpers.remote.ignorePreviousChanges()
  })

  suite('file', () => {
    let file

    beforeEach(async () => {
      file = await cozy.files.create('foo', {name: 'file'})

      await helpers.remote.pullChanges()
      await helpers.syncAll()
      helpers.spyPouch()
    })

    test('pouch.put throws when trying to put bad doc', async () => {
      const oldFile = await pouch.byRemoteIdMaybeAsync(file._id)
      should(() => pouch.put(Object.assign(oldFile, {remote: null}))
        ).throw(/sides\.remote/)
    })
  })
})
