/* eslint-env mocha */
/* @flow */

const Promise = require('bluebird')
const fs = require('fs')
const fsextra = require('fs-extra')
const _ = require('lodash')
const tempy = require('tempy')
const should = require('should')

describe('FS timestamps', () => {
  const { platform } = process

  // Recent FS uses on workstation or CI should have at least 1ms resolution
  const delay = () => Promise.delay(2)

  describe('fs-extra.appendFile & fs-extra.chmod', () => {
    it('change respectively ctime+mtime+birthtime and ctime+birthtime on every platform', async () => {
      const file = tempy.file()

      await fsextra.writeFile(file, 'foo')

      const stats0 = await fsextra.stat(file)
      should(stats0.size).equal(3)
      should(stats0.mtimeMs).equal(stats0.ctimeMs)

      await delay()
      await fsextra.appendFile(file, 'bar')

      const stats1 = await fsextra.stat(file)
      should(stats1.size).equal(6)
      should(stats1.atimeMs).equal(stats0.atimeMs)
      should(stats1.ctimeMs).not.equal(stats0.ctimeMs)
      should(stats1.mtimeMs).not.equal(stats0.mtimeMs)
      if (platform === 'win32') should(stats1.birthtimeMs).equal(stats0.birthtimeMs)
      else should(stats1.birthtimeMs).not.equal(stats0.birthtimeMs)

      await delay()
      await fsextra.chmod(file, 0o777)

      const stats2 = await fsextra.stat(file)
      should(stats2.size).equal(stats1.size)
      should(stats2.atimeMs).equal(stats1.atimeMs)
      if (platform === 'win32') should(stats2.ctimeMs).equal(stats1.ctimeMs)
      else should(stats2.ctimeMs).not.equal(stats1.ctimeMs)
      should(stats2.mtimeMs).equal(stats1.mtimeMs)
      if (platform === 'win32') should(stats2.birthtimeMs).equal(stats1.birthtimeMs)
      else should(stats2.birthtimeMs).not.equal(stats1.birthtimeMs)
    })
  })

  describe('fs.appendFileSync & fs.chmodSync', () => {
    it('behave the same as fs-extra', async () => {
      const file = tempy.file()

      fs.writeFileSync(file, 'foo')

      const stats0 = fs.statSync(file)
      should(stats0.size).equal(3)
      should(stats0.mtimeMs).equal(stats0.ctimeMs)

      await delay()
      fs.appendFileSync(file, 'bar')

      const stats1 = fs.statSync(file)
      should(stats1.size).equal(6)
      should(stats1.atimeMs).equal(stats0.atimeMs)
      should(stats1.ctimeMs).not.equal(stats0.ctimeMs)
      should(stats1.mtimeMs).not.equal(stats0.mtimeMs)
      if (platform === 'win32') should(stats1.birthtimeMs).equal(stats0.birthtimeMs)
      else should(stats1.birthtimeMs).not.equal(stats0.birthtimeMs)

      await delay()
      fs.chmodSync(file, 0o777)

      const stats2 = fs.statSync(file)
      should(stats2.size).equal(stats1.size)
      should(stats2.atimeMs).equal(stats1.atimeMs)
      if (platform === 'win32') should(stats2.ctimeMs).equal(stats1.ctimeMs)
      else should(stats2.ctimeMs).not.equal(stats1.ctimeMs)
      should(stats2.mtimeMs).equal(stats1.mtimeMs)
      if (platform === 'win32') should(stats2.birthtimeMs).equal(stats1.birthtimeMs)
      else should(stats2.birthtimeMs).not.equal(stats1.birthtimeMs)
    })
  })

  describe('fs.writeSync', () => {
    it('behaves the same as fs and fs-extra', async () => {
      const file = tempy.file()

      {
        const fd = fs.openSync(file, 'wx')
        fs.writeSync(fd, 'foo')
        fs.closeSync(fd)
      }

      const stats0 = fs.statSync(file)
      should(stats0.size).equal(3)
      should(stats0.mtimeMs).equal(stats0.ctimeMs)

      await delay()
      {
        const fd = fs.openSync(file, 'a')
        fs.writeSync(fd, 'bar')
        fs.closeSync(fd)
      }

      const stats1 = fs.statSync(file)
      should(stats1.size).equal(6)
      should(stats1.atimeMs).equal(stats0.atimeMs)
      should(stats1.ctimeMs).not.equal(stats0.ctimeMs)
      should(stats1.mtimeMs).not.equal(stats0.mtimeMs)
      if (platform === 'win32') should(stats1.birthtimeMs).equal(stats0.birthtimeMs)
      else should(stats1.birthtimeMs).not.equal(stats0.birthtimeMs)
    })
  })
})
