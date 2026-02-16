import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_SETTINGS, createDefaultModelState, normalizeSettings } from '../shared/defaults'

test('normalizeSettings forces autoPaste and validates backend', () => {
  const settings = normalizeSettings({
    autoPaste: false,
    autoPasteBackend: 'invalid-backend' as never,
  })

  assert.equal(settings.autoPaste, true)
  assert.equal(settings.autoPasteBackend, DEFAULT_SETTINGS.autoPasteBackend)
})

test('normalizeSettings migrates legacy agent name', () => {
  const settings = normalizeSettings({
    agentName: 'ActionAgent',
  })

  assert.equal(settings.agentName, 'Agent')
})

test('createDefaultModelState marks only small model as downloaded', () => {
  const models = createDefaultModelState()
  const downloadedIds = models.filter((model) => model.downloaded).map((model) => model.id)

  assert.deepEqual(downloadedIds, ['small'])
})
