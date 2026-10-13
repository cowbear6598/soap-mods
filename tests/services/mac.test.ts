import { expect, test } from 'claude-code/testing'

import { isShellSafe } from '../../hooks/services/mac'

test('isShellSafe lets plain commands through and stops anything sh would read differently', () => {
  expect(isShellSafe('npm run dev')).toBe(true)
  expect(isShellSafe('node /Users/me/專案/web/server.js --port=5173')).toBe(true)
  expect(isShellSafe('node server.js --banner $(whoami)')).toBe(false)
  expect(isShellSafe('sh -c vite; rm -rf x')).toBe(false)
  expect(isShellSafe('echo "hi"')).toBe(false)
  expect(isShellSafe('ls *')).toBe(false)
})
