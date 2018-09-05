/* @flow */

const async = require('async')
const autoBind = require('auto-bind')
const fs = require('fs-extra')
const path = require('path')
const trash = require('trash')

const bluebird = require('bluebird')

const { TMP_DIR_NAME } = require('./constants')
const logger = require('../logger')
const { isUpToDate } = require('../metadata')
const { hideOnWindows } = require('../utils/fs')
const Watcher = require('./watcher')
const measureTime = require('../perftools')
const { withContentLength } = require('../file_stream_provider')

bluebird.promisifyAll(fs)

/*::
import type EventEmitter from 'events'
import type Config from '../config'
import type { FileStreamProvider, ReadableWithContentLength } from '../file_stream_provider'
import type { Metadata } from '../metadata'
import type Pouch from '../pouch'
import type Prep from '../prep'
import type { Side } from '../side' // eslint-disable-line
import type { Callback } from '../utils/func'
*/

const log = logger({
  component: 'LocalWriter'
})
// Local is the class that interfaces cozy-desktop with the local filesystem.
// It uses a watcher, based on chokidar, to listen for file and folder changes.
// It also applied changes from the remote cozy on the local filesystem.
module.exports = class Local /*:: implements Side */ {
  /*::
  prep: Prep
  pouch: Pouch
  events: EventEmitter
  syncPath: string
  tmpPath: string
  watcher: Watcher
  other: FileStreamProvider
  _trash: (Array<string>) => Promise<void>
  */

  constructor (config /*: Config */, prep /*: Prep */, pouch /*: Pouch */, events /*: EventEmitter */) {
    this.prep = prep
    this.pouch = pouch
    this.events = events
    this.syncPath = config.syncPath
    this.tmpPath = path.join(this.syncPath, TMP_DIR_NAME)
    this.watcher = new Watcher(this.syncPath, this.prep, this.pouch, events)
    // $FlowFixMe
    this.other = null
    this._trash = trash

    autoBind(this)
    bluebird.promisifyAll(this)
  }

  /*::
  addFileAsync: (Metadata) => Promise<*>
  addFolderAsync: (Metadata) => Promise<*>
  updateFileMetadataAsync: (Metadata, Metadata) => Promise<*>
  renameConflictingDocAsync: (doc: Metadata, newPath: string) => Promise<void>
  */

  // Start initial replication + watching changes in live
  start () {
    this.watcher.ensureDirSync()
    return this.watcher.start()
  }

  // Stop watching the file system
  stop () {
    return this.watcher.stop()
  }

  // Create a readable stream for the given doc
  // adds a contentLength property to be used
  async createReadStreamAsync (doc /*: Metadata */) /*: Promise<ReadableWithContentLength> */ {
    try {
      let filePath = path.resolve(this.syncPath, doc.path)
      let pStats = fs.statAsync(filePath)
      let pStream = new Promise((resolve, reject) => {
        let stream = fs.createReadStream(filePath)
        stream.on('open', () => resolve(stream))
        stream.on('error', err => reject(err))
      })
      const [
        stream /*: ReadableWithContentLength */,
        stat /*: fs.Stat */
      ] = await Promise.all([pStream, pStats])
      return withContentLength(stream, stat.size)
    } catch (err) {
      return Promise.reject(err)
    }
  }

  /* Helpers */

  // Return a function that will update last modification date
  // and does a chmod +x if the file is executable
  //
  // Note: UNIX has 3 timestamps for a file/folder:
  // - atime for last access
  // - ctime for change (metadata or content)
  // - utime for update (content only)
  // This function updates utime and ctime according to the last
  // modification date.
  metadataUpdater (doc /*: Metadata */) {
    return (callback /*: Callback */) => {
      this.updateMetadataAsync(doc)
        .then(() => { callback() })
        .catch(callback)
    }
  }

  async updateMetadataAsync (doc /*: Metadata */) /*: Promise<void> */ {
    let filePath = path.resolve(this.syncPath, doc.path)
    if (doc.executable) await fs.chmod(filePath, '755')
    if (doc.updated_at) {
      let updated = new Date(doc.updated_at)
      try {
        await fs.utimes(filePath, updated, updated)
      } catch (_) {
        // Ignore errors
      }
    }
  }

  inodeSetter (doc /*: Metadata */) {
    let abspath = path.resolve(this.syncPath, doc.path)
    return (callback /*: Callback */) => {
      fs.stat(abspath, (err, stats) => {
        if (err) {
          callback(err)
        } else {
          doc.ino = stats.ino
          callback(null)
        }
      })
    }
  }

  // Check if a file corresponding to given checksum already exists
  fileExistsLocally (checksum /*: string */, callback /*: Callback */) {
    this.pouch.byChecksum(checksum, (err, docs) => {
      if (err) {
        callback(err)
      } else if ((docs == null) || (docs.length === 0)) {
        callback(null, false)
      } else {
        let paths = Array.from(docs)
          .filter((doc) => isUpToDate('local', doc))
          .map((doc) => path.resolve(this.syncPath, doc.path))
        async.detect(paths,
            (filePath, next) => fs.exists(filePath, found => next(null, found)),
            callback)
      }
    })
  }

  /* Write operations */

  // Add a new file, or replace an existing one
  //
  // Steps to create a file:
  //   * Try to find a similar file based on his checksum
  //     (in that case, it just requires a local copy)
  //   * Or download the linked binary from remote
  //   * Write to a temporary file
  //   * Ensure parent folder exists
  //   * Move the temporay file to its final destination
  //   * Update creation and last modification dates
  //
  // Note: if no checksum was available for this file, we download the file
  // from the remote document. Later, chokidar will fire an event for this new
  // file. The checksum will then be computed and added to the document, and
  // then pushed to CouchDB.
  addFile (doc /*: Metadata */, callback /*: Callback */) /*: void */ {
    let tmpFile = path.resolve(this.tmpPath, `${path.basename(doc.path)}.tmp`)
    let filePath = path.resolve(this.syncPath, doc.path)
    let parent = path.resolve(this.syncPath, path.dirname(doc.path))
    const stopMeasure = measureTime('LocalWriter#addFile')

    log.info({path: doc.path}, 'Put file')

    async.waterfall([
      next => {
        if (doc.md5sum != null) {
          this.fileExistsLocally(doc.md5sum, next)
        } else {
          next(null, false)
        }
      },

      (existingFilePath, next) => {
        fs.ensureDir(this.tmpPath, () => {
          hideOnWindows(this.tmpPath)
          if (existingFilePath) {
            log.info({path: filePath}, `Recopy ${existingFilePath} -> ${filePath}`)
            this.events.emit('transfer-copy', doc)
            fs.copy(existingFilePath, tmpFile, next)
          } else {
            this.other.createReadStreamAsync(doc).then(
              (stream) => {
                // Don't use async callback here!
                // Async does some magic and the stream can throw an
                // 'error' event before the next async is called...
                let target = fs.createWriteStream(tmpFile)
                stream.pipe(target)
                target.on('finish', next)
                target.on('error', next)
              },
              (err) => { next(err) }
            )
          }
        })
      },

      next => {
        if (doc.md5sum != null) {
          // TODO: Share checksumer instead of chaining properties
          this.watcher.checksumer.push(tmpFile).asCallback(function (err, md5sum) {
            if (err) {
              next(err)
            } else if (md5sum === doc.md5sum) {
              next()
            } else {
              next(new Error('Invalid checksum'))
            }
          })
        } else {
          next()
        }
      },

      next => fs.ensureDir(parent, () => fs.rename(tmpFile, filePath, next)),

      this.inodeSetter(doc),
      this.metadataUpdater(doc)

    ], function (err) {
      stopMeasure()
      if (err) { log.warn({path: doc.path}, 'addFile failed:', err, doc) }
      fs.unlink(tmpFile, () => callback(err))
    })
  }

  // Create a new folder
  addFolder (doc /*: Metadata */, callback /*: Callback */) /*: void */ {
    let folderPath = path.join(this.syncPath, doc.path)
    log.info({path: doc.path}, 'Put folder')
    async.series([
      cb => fs.ensureDir(folderPath, cb),
      this.inodeSetter(doc),
      this.metadataUpdater(doc)
    ], callback)
  }

  // Overwrite a file
  async overwriteFileAsync (doc /*: Metadata */, old /*: ?Metadata */) /*: Promise<void> */ {
    await this.addFileAsync(doc)
  }

  // Update the metadata of a file
  updateFileMetadata (doc /*: Metadata */, old /*: Metadata */, callback /*: Callback */) /*: void */ {
    log.info({path: doc.path}, 'Updating file metadata...')
    this.metadataUpdater(doc)(callback)
  }

  // Update a folder
  async updateFolderAsync (doc /*: Metadata */, old /*: Metadata */) /*: Promise<void> */ {
    await this.addFolderAsync(doc)
  }

  async assignNewRev (doc /*: Metadata */) /*: Promise<void> */ {
    log.info({path: doc.path}, 'Local assignNewRev = noop')
  }

  // Move a file from one place to another
  async moveFileAsync (doc /*: Metadata */, old /*: Metadata */) /*: Promise<void> */ {
    log.info({path: doc.path, oldpath: old.path}, 'Moving file')
    await this._move(doc, old)
    if (doc.md5sum !== old.md5sum) {
      await this.overwriteFileAsync(doc)
    }
  }

  // Move a folder
  async moveFolderAsync (doc /*: Metadata */, old /*: Metadata */) /*: Promise<void> */ {
    log.info({path: doc.path, oldpath: old.path}, 'Moving folder')
    await this._move(doc, old)
  }

  async _move (doc /*: Metadata */, old /*: Metadata */) /*: Promise<void> */ {
    let oldPath = path.join(this.syncPath, old.path)
    let newPath = path.join(this.syncPath, doc.path)

    if (doc._id !== old._id) {
      await this._ensureNotExists(newPath)
    }

    await fs.rename(oldPath, newPath)
    await this.updateMetadataAsync(doc)
  }

  async _ensureNotExists (newPath /*: string */) /*: Promise<void> */ {
    try {
      const stats = await fs.stat(newPath)
      const err = new Error(`Move destination already exists: ${newPath}`)
      // $FlowFixMe
      err.stats = stats
      throw err
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
  }

  async trashAsync (doc /*: Metadata */) /*: Promise<void> */ {
    log.info({path: doc.path}, 'Moving to the OS trash...')
    this.events.emit('delete-file', doc)
    let fullpath = path.join(this.syncPath, doc.path)
    try {
      await this._trash([fullpath])
    } catch (err) {
      throw err
    }
  }

  async deleteFolderAsync (doc /*: Metadata */) /*: Promise<void> */ {
    if (doc.docType !== 'folder') throw new Error(`Not folder metadata: ${doc.path}`)
    const fullpath = path.join(this.syncPath, doc.path)

    try {
      log.info({path: doc.path}, 'Deleting empty folder...')
      await fs.rmdirAsync(fullpath)
      this.events.emit('delete-file', doc)
      return
    } catch (err) {
      if (err.code !== 'ENOTEMPTY') throw err
    }
    log.warn({path: doc.path}, 'Folder is not empty!')
    await this.trashAsync(doc)
  }

  // Rename a file/folder to resolve a conflict
  renameConflictingDoc (doc /*: Metadata */, newPath /*: string */, callback /*: Callback */) {
    log.info({path: doc.path}, `Resolve a conflict: ${doc.path} → ${newPath}`)
    let srcPath = path.join(this.syncPath, doc.path)
    let dstPath = path.join(this.syncPath, newPath)
    fs.rename(srcPath, dstPath, callback)
    // TODO: Don't fire an event for the deleted file?
  }
}
