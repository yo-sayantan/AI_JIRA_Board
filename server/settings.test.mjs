import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import { AI_LEVELS, normaliseBoardSettings } from './settings.mjs'
import { ollamaOn } from './ollama.mjs'

test('the levels are Low · Medium · High · Max (stored low/moderate/high/full)', () => {
  assert.deepEqual(AI_LEVELS, ['low', 'moderate', 'high', 'full'])
})

test('the retired "none" level reads as AI off at the default level', () => {
  const s = normaliseBoardSettings({ aiLevel: 'none', aiEnabled: true, jobsEnabled: true })
  assert.equal(s.aiEnabled, false)
  assert.equal(s.aiLevel, 'moderate')
  assert.equal(s.jobsEnabled, true)
})

test('a real level passes through untouched', () => {
  const s = { aiLevel: 'high', aiEnabled: true }
  assert.equal(normaliseBoardSettings(s), s)
})

test('the Ollama container follows the AI master switch', () => {
  assert.equal(ollamaOn({ ollamaEnabled: true }), true)
  assert.equal(ollamaOn({ ollamaEnabled: true, aiEnabled: true }), true)
  assert.equal(ollamaOn({ ollamaEnabled: true, aiEnabled: false }), false)
  assert.equal(ollamaOn({ ollamaEnabled: false, aiEnabled: true }), false)
})
