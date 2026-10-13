import { expect, test } from 'claude-code/testing'

import { isPlanPath, parseYaml, readPlan, sortSpecs } from '../../hooks/spec/parse'

// soap-plan skill 寫出來的樣子：folded description、清單、[]、引號、選填的公司欄位。
const PLAN = `branch: "feature/PROJ-123-login"
issue-number: "PROJ-123"
description: >
  Users can't sign in with SSO,
  so support tickets pile up.

  Adding it removes the manual reset flow.
goals:
  - SSO button on the login page signs the user in
  - 'Failed sign-in shows the provider''s message'
constraints: []
related:
  - src/login.ts # the entry point
verify:
  - "npm test -- src/login.spec.ts"
`

test('readPlan reads every field of a valid plan and finds no problems', () => {
  const { plan, problems } = readPlan(PLAN)
  expect(problems).toEqual([])
  expect(plan).toEqual({
    branch: 'feature/PROJ-123-login',
    issueNumber: 'PROJ-123',
    description: "Users can't sign in with SSO, so support tickets pile up.\nAdding it removes the manual reset flow.",
    goals: ['SSO button on the login page signs the user in', "Failed sign-in shows the provider's message"],
    constraints: [],
    related: ['src/login.ts'],
    verify: ['npm test -- src/login.spec.ts'],
  })
})

test('parseYaml keeps | blocks as written, reads [a, b] lists and joins wrapped items and strings', () => {
  const { values, errors } = parseYaml(['a: |-', '  one', '    two', 'b: [x, "y, z"]', 'c:', '- first', '  continued', 'd: long', '  line', ''].join('\r\n'))
  expect(errors).toEqual([])
  expect(values.get('a')).toBe('one\n  two')
  expect(values.get('b')).toEqual(['x', 'y, z'])
  expect(values.get('c')).toEqual(['first continued'])
  expect(values.get('d')).toBe('long line')
})

test('readPlan names what is wrong: missing keys, wrong types, unknown keys, goal for goals, unreadable lines', () => {
  const { plan, problems } = readPlan(['description: ""', 'goal:', '  - x', 'related: src/a.ts', 'verify:', 'extra: 1', '  - oops: [', 'what is this'].join('\n'))
  expect(problems).toEqual([
    'line 8: expected "key: value", got "what is this"',
    'missing "goals"',
    'missing "constraints"',
    '"description" must be a non-empty string',
    '"related" must be a list (use [] when empty)',
    '"verify" must be a list (use [] when empty)',
    'use "goals", not "goal"',
    'unknown key "extra"',
  ])
  // 讀得到的照樣給：畫面上看得到哪些對、哪些不對。
  expect(plan.goals).toEqual([])
  expect(plan.related).toEqual([])
})

test('readPlan flags a repeated key and an empty list item', () => {
  const { problems } = readPlan(['description: x', 'description: y', 'goals:', '  -', 'constraints: []', 'related: []', 'verify: []'].join('\n'))
  expect(problems).toEqual(['line 2: "description" appears twice', '"goals" has an empty item'])
})

test('isPlanPath matches only <feature>/plan.yaml right under .soap/tasks, on any separator', () => {
  expect(isPlanPath('/repo/.soap/tasks/login/plan.yaml')).toBe(true)
  expect(isPlanPath('C:\\repo\\.soap\\tasks\\login\\plan.yaml')).toBe(true)
  expect(isPlanPath('/repo/.soap/tasks/plan.yaml')).toBe(false)
  expect(isPlanPath('/repo/.soap/tasks/login/assets/plan.yaml')).toBe(false)
  expect(isPlanPath('/repo/.soap/tasks/login/plan.yml')).toBe(false)
})

test('sortSpecs puts the newest plan first and folders without a plan last', () => {
  const sorted = sortSpecs([
    { name: 'empty', mtimeMs: 0, hasPlan: false },
    { name: 'old', mtimeMs: 1, hasPlan: true },
    { name: 'new', mtimeMs: 9, hasPlan: true },
  ])
  expect(sorted.map(s => s.name)).toEqual(['new', 'old', 'empty'])
})
