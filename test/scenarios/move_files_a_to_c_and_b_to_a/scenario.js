/* @flow */

/*:: import type { Scenario } from '..' */

module.exports = ({
  init: [
    {ino: 1, path: 'a'},
    {ino: 2, path: 'b'}
  ],
  actions: [
    {type: 'mv', src: 'a', dst: 'c'},
    {type: 'wait', ms: 1500},
    {type: 'mv', src: 'b', dst: 'a'}
  ],
  expected: {
    prepCalls: [
      // FIXME: a -> c should be first
      {method: 'moveFileAsync', src: 'b', dst: 'a'},
      {method: 'moveFileAsync', src: 'a', dst: 'c'}
    ],
    tree: [
      'a',
      'c'
    ],
    remoteTrash: []
  }
} /*: Scenario */)
