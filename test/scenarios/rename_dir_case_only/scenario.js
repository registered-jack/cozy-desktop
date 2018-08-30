/* @flow */

/*:: import type { Scenario } from '..' */

module.exports = ({
  noremote: true,
  init: [
    {ino: 1, path: 'dir/'}
  ],
  actions: [
    {type: 'mv', src: 'dir', dst: 'DIR'}
  ],
  expected: {
    prepCalls: [
      {method: 'moveFolderAsync', src: 'dir', dst: 'DIR'}
    ],
    tree: [
      'DIR/'
    ],
    remoteTrash: []
  }
} /*: Scenario */)
