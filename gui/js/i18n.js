/* @flow */

/*::
import type electron from 'electron'
*/

let app

module.exports.init = (appRef /*: electron.app */) => {
  app = appRef
  app.locale = 'en'
  app.translations = {}

  const locale = app.getLocale()
  if (locale === 'fr' || locale.match(/^fr_/i)) {
    app.locale = 'fr'
  } else {
    app.locale = 'en'
  }

  // $FlowFixMe
  app.translations = require(`../locales/${app.locale}.json`)
}

module.exports.translate = (key /*: string */) => app.translations[key] ||
  key.substr(key.indexOf(' ') + 1) // Key without prefix

module.exports.interpolate = (string /*: string */, ...args /*: * */) => {
  return string.replace(/{(\d+)}/g, (_, index) => args[parseInt(index)])
}

module.exports.platformName = () => {
  switch (process.platform) {
    case 'darwin': return 'macOS'
    case 'freebsd': return 'FreeBSD'
    case 'linux': return 'Linux'
    case 'sunos': return 'SunOS'
    case 'win32': return 'Windows'
    default: return process.platform
  }
}
