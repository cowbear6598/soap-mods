import { expect, test } from 'claude-code/testing'

import { parseDiffRows, wordDiff } from '../../hooks/git/wordDiff'

test('wordDiff marks only the words that changed', () => {
  expect(wordDiff('const timeout = 3000', 'const timeout = 5000')).toEqual({
    before: [
      { text: 'const timeout = ', isChanged: false },
      { text: '3000', isChanged: true },
    ],
    after: [
      { text: 'const timeout = ', isChanged: false },
      { text: '5000', isChanged: true },
    ],
  })

  // 整行重寫：不標字詞，免得整行反白。
  expect(wordDiff('alpha beta', 'gamma delta')).toEqual({
    before: [{ text: 'alpha beta', isChanged: false }],
    after: [{ text: 'gamma delta', isChanged: false }],
  })
})

test('parseDiffRows numbers lines and pairs removed lines with the added ones after them', () => {
  const rows = parseDiffRows(['@@ -10,3 +10,4 @@ fn', ' keep', '-let a = 1', '+let a = 2', '+added line', '\\ No newline at end of file'].join('\n'))
  expect(rows).toEqual([
    { kind: 'hunk', text: '@@ -10,3 +10,4 @@ fn' },
    { kind: 'same', line: 10, segs: [{ text: 'keep', isChanged: false }] },
    {
      kind: 'remove',
      line: 11,
      segs: [
        { text: 'let a = ', isChanged: false },
        { text: '1', isChanged: true },
      ],
    },
    {
      kind: 'add',
      line: 11,
      segs: [
        { text: 'let a = ', isChanged: false },
        { text: '2', isChanged: true },
      ],
    },
    { kind: 'add', line: 12, segs: [{ text: 'added line', isChanged: false }] },
  ])
})
