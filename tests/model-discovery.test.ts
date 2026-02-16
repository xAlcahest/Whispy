import assert from 'node:assert/strict'
import test from 'node:test'
import { deriveModelsEndpointFromBaseUrl, extractModelIdsFromPayload } from '../shared/model-discovery'

test('deriveModelsEndpointFromBaseUrl maps chat completion endpoint to models', () => {
  const endpoint = deriveModelsEndpointFromBaseUrl('https://api.example.com/v1/chat/completions')
  assert.equal(endpoint, 'https://api.example.com/v1/models')
})

test('deriveModelsEndpointFromBaseUrl returns null for invalid URLs', () => {
  const endpoint = deriveModelsEndpointFromBaseUrl('not-a-url')
  assert.equal(endpoint, null)
})

test('extractModelIdsFromPayload parses ids from nested response shape', () => {
  const ids = extractModelIdsFromPayload({
    data: [{ id: 'gpt-4.1-mini' }, { id: 'whisper-1' }],
    models: [{ model: 'llama-3.1-8b' }],
  })

  assert.deepEqual(ids, ['gpt-4.1-mini', 'whisper-1', 'llama-3.1-8b'])
})
