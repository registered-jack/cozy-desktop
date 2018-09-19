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
const sinon = require('sinon')
const Builders = require('../support/builders')

const configHelpers = require('../support/helpers/config')
const cozyHelpers = require('../support/helpers/cozy')
const pouchHelpers = require('../support/helpers/pouch')
const { IntegrationTestHelpers } = require('../support/helpers/integration')

const { Transform } = require('stream')
const { withContentLength } = require('../../core/file_stream_provider')

const cozy = cozyHelpers.cozy

const startMockingCorruptDownloads = (remote /*: Remote */, corruptedDocs /*: RemoteFileCorruption[] */) => {
  if (remote.remoteCozy._corruptedDocs) throw new Error('Already corrupting')
  const normalCreateStream = remote.createReadStreamAsync
  const normalFetchCorruptions = remote.remoteCozy.fetchFileCorruptions
  remote.remoteCozy._corruptedDocs = corruptedDocs

  // $FlowFixMe flow dislike monkey patch
  remote.createReadStreamAsync = async (doc /*: Metadata */) /*: Promise<ReadableWithContentLength> */ => {
    const normalStream = (await normalCreateStream.call(remote, doc))
    console.log('THERE', corruptedDocs, 'VS', doc)
    if (!corruptedDocs.find(x => x.path.slice(1) === doc.path)) return normalStream

    const corruptedStream = normalStream.pipe(new Transform({
      transform: function (chunk, encoding, callback) {
        this.push(chunk.slice(3)) // Drop 3 bytes
        callback()
      }
    }))
    return withContentLength(corruptedStream, doc.size)
  }

  // $FlowFixMe flow dislike monkey patch
  remote.remoteCozy.fetchFileCorruptions = async () /*: Promise<RemoteFileCorruption[]> */ => corruptedDocs

  const stopCorruptDownloads = () => {
    delete remote.remoteCozy._corruptedDocs
    // $FlowFixMe flow dislike monkey patch
    remote.createReadStreamAsync = normalCreateStream
    // $FlowFixMe flow dislike monkey patch
    remote.remoteCozy.fetchFileCorruptions = normalFetchCorruptions
  }

  return stopCorruptDownloads
}

suite('Re-Upload files when the stack report them as broken', () => {
  let helpers, builders

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
    builders = new Builders(cozy, this.pouch)
  })

  // A corrupt file has the correct checksum, but is not correct when
  // downloading.

  test('Corrupted file should never be synced', async () => {
    const remoteFile = await builders.remote.file()
                        .named('file-corrupted')
                        .data('file-corrupted-content')
                        .create()

    const restoreMock = startMockingCorruptDownloads(helpers.remote.remote, [{
      path: remoteFile.path,
      md5sum: remoteFile.md5sum,
      _id: remoteFile._id,
      _rev: remoteFile._rev
    }])
    await helpers.remote.pullChanges()
    await helpers.syncAll()

    const file = await helpers._pouch.byRemoteIdMaybeAsync(remoteFile._id)
    should(file).have.property('errors', 2)
    should(file.sides.remote).eql(3) // ?
    should(await helpers.local.tree()).deepEqual([])
    restoreMock()
  })

  test('Ideal case', async() => {
    await helpers.local.syncDir.outputFile('file', 'valid-content')
    await helpers.local.scan()
    await helpers.syncAll()

    const doc = await helpers.docByPath('file')
    // I have the correct version of the file
    should(await helpers.remote.treeWithoutTrash()).deepEqual(['file'])
    // But it's corrupted on the cozy
    const restoreMock = startMockingCorruptDownloads(helpers.remote.remote, [{
      path: doc.path,
      md5sum: doc.md5sum,
      _id: doc.remote._id,
      _rev: doc.remote._rev
    }])

    const overwriteFileAsync = sinon.spy(helpers.remote.remote, 'overwriteFileAsync')
    await helpers._sync.fixCorruptFiles()
    should(overwriteFileAsync).have.been.calledOnce()
    restoreMock()
    overwriteFileAsync.restore()

    await helpers.local.scan()
    await helpers.pullAndSyncAll()
  })

  test('No infinite fixing', async () => {
    // Good metadata in pouchdb ()
    // Bad metadata in pouchdb (already merge, sync failed)
    // make sure to only uploads once
  })

  test(' with two clients', async() => {
    // I have an old version
    // I cant download corrupted
    // another client fixed it
    // The file is still reported as corrupted
    // I succeed in downloading new
    // I dont try to upload my version or the new one
  })

  test('Race', async () => {
    // File is modified between shouldReuploadCorruptFile
    // and overwriteFileAsync
  })

  // old version of the test
  test.skip('Handle corrupted files', async () => {
    await helpers.remote.ignorePreviousChanges()

    const file = await cozy.files.create('file-ok-content', {name: 'file-ok'})
    await helpers.remote.pullChanges()
    await helpers.syncAll()
    should(await helpers.local.tree()).deepEqual(['file-ok'])

    const stopCorrupting = await startMockingCorruptDownloads(helpers.remote, [{path: '/file-corrupted'}])
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
