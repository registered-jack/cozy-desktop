/* @flow */

const {BrowserWindow, ipcMain, shell} = require('electron')
const _ = require('lodash')
const path = require('path')
const electron = require('electron')

/*::
import type desktop from '../../core/app'
*/

const ELMSTARTUP = 400

const log = require('../../core/app').logger({
  component: 'windows'
})

module.exports = class WindowManager {
  /*::
  app: electron.app
  desktop: desktop.App
  log: *
  win: ?electron.BrowserWindow
  */
  constructor (app /*: electron.app */, desktop /*: desktop.App */) {
    this.win = null
    this.app = app
    this.desktop = desktop
    this.log = require('../../core/app').logger({
      component: 'GUI/' + this.windowOptions().title
    })

    let handlers = this.ipcEvents()
    Object.keys(handlers).forEach((name) => {
      if (!handlers[name]) {
        throw new Error('undefined handler for event ' + name)
      }
      ipcMain.on(name, handlers[name].bind(this))
    })
    ipcMain.on('renderer-error', (event, err) => {
      // Sender can be a WebContents instance not yet attached to this.win, so
      // we compare the title from browserWindowOptions:
      if (_.get(event, 'sender.browserWindowOptions.title') === this.windowOptions().title) {
        this.log.error({err}, err.message)
      }
    })
  }

  /* abtract */
  windowOptions () {
    throw new Error('extend WindowManager before using')
  }

  /* abtract */
  ipcEvents () {
    throw new Error('extend WindowManager before using')
  }

  makesAppVisible () {
    return true
  }

  show () {
    const win = this.win
    if (!win) return this.create()
    this.log.debug('show')
    win.show()
    // $FlowFixMe
    return Promise.resolve(win)
  }

  hide () {
    const win = this.win
    if (win) {
      this.log.debug('hide')
      win.close()
    }
    this.win = null
  }

  shown () {
    return this.win != null
  }

  focus () {
    return this.win && this.win.focus()
  }

  reload () {
    const win = this.win
    if (win) {
      this.log.debug('reload')
      win.reload()
    }
  }

  send (...args /*: * */) {
    this.win && this.win.webContents && this.win.webContents.send(...args)
  }

  hash () {
    return ''
  }

  centerOnScreen (wantedWidth /*: number */, wantedHeight /*: number */) {
    const win = this.win
    if (win == null) return
    try {
      const bounds = win.getBounds()
      // TODO : be smarter about which display to use ?
      const display = electron.screen.getDisplayMatching(bounds)
      const displaySize = display.workArea
      const actualWidth = Math.min(wantedWidth, Math.floor(0.9 * displaySize.width))
      const actualHeight = Math.min(wantedHeight, Math.floor(0.9 * displaySize.height))
      win.setBounds({
        x: Math.floor((displaySize.width - actualWidth) / 2),
        y: Math.floor((displaySize.height - actualHeight) / 2),
        width: actualWidth,
        height: actualHeight
      }, true /* animate on MacOS */)
    } catch (err) {
      log.error({err, wantedWidth, wantedHeight}, 'Fail to centerOnScreen')
    }
  }

  create () {
    this.log.debug('create')
    const opts = this.windowOptions()
    opts.show = false
    const win = this.win = new BrowserWindow(opts)
    win.on('unresponsive', () => { this.log.warn('Web page becomes unresponsive') })
    win.on('responsive', () => { this.log.warn('Web page becomes responsive again') })
    win.webContents.on('did-fail-load', (event, errorCode, errorDescription, url, isMainFrame) => {
      this.log.error({errorCode, url, isMainFrame}, errorDescription)
    })
    this.centerOnScreen(opts.width, opts.height)

    // openExternalLinks
    win.webContents.on('will-navigate', (event, url) => {
      if (url.startsWith('http') && !url.match('/auth/authorize')) {
        event.preventDefault()
        shell.openExternal(url)
      }
    })

    win.setVisibleOnAllWorkspaces(true)

    // noMenu
    win.setMenu(null)
    win.setAutoHideMenuBar(true)

    // Most windows (e.g. onboarding, help...) make the app visible in macOS
    // dock (and cmd+tab) by default. App is hidden when windows is closed to
    // allow per-window visibility.
    if (process.platform === 'darwin' && this.makesAppVisible()) {
      this.app.dock.show()
      win.on('closed', () => { this.app.dock.hide() })
    }

    // dont keep  hidden windows objects
    win.on('closed', () => { this.win = null })

    let resolveCreate = null
    let promiseReady = new Promise((resolve, reject) => {
      resolveCreate = resolve
    }).catch((err) => log.error(err))

    win.webContents.on('dom-ready', () => {
      setTimeout(() => {
        win.show()
        // $FlowFixMe
        resolveCreate(win)
      }, ELMSTARTUP)
    })

    let indexPath = path.resolve(__dirname, '..', 'index.html')
    win.loadURL(`file://${indexPath}${this.hash()}`)

    // devTools
    if (process.env.WATCH === 'true' || process.env.DEBUG === 'true') {
      win.webContents.openDevTools({mode: 'detach'})
    }

    return promiseReady
  }
}
