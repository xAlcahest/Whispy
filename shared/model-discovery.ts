export const deriveModelsEndpointFromBaseUrl = (baseUrl: string) => {
  const trimmedUrl = baseUrl.trim()
  if (!trimmedUrl) {
    return null
  }

  let parsedUrl: URL
  try {
    parsedUrl = new URL(trimmedUrl)
  } catch {
    return null
  }

  const rawPath = parsedUrl.pathname.replace(/\/+$/, '')
  const normalizedPath = rawPath.toLowerCase()

  let modelsPath = ''

  if (normalizedPath.endsWith('/v1/models') || normalizedPath.endsWith('/models')) {
    modelsPath = rawPath || '/models'
  } else if (normalizedPath.endsWith('/v1/audio/transcriptions')) {
    modelsPath = `${rawPath.slice(0, -'/v1/audio/transcriptions'.length)}/v1/models`
  } else if (normalizedPath.endsWith('/v1/transcriptions')) {
    modelsPath = `${rawPath.slice(0, -'/v1/transcriptions'.length)}/v1/models`
  } else if (normalizedPath.endsWith('/v1/chat/completions')) {
    modelsPath = `${rawPath.slice(0, -'/v1/chat/completions'.length)}/v1/models`
  } else if (normalizedPath.endsWith('/v1/completions')) {
    modelsPath = `${rawPath.slice(0, -'/v1/completions'.length)}/v1/models`
  } else if (normalizedPath.endsWith('/v1')) {
    modelsPath = `${rawPath}/models`
  } else if (rawPath) {
    modelsPath = `${rawPath}/models`
  } else {
    modelsPath = '/models'
  }

  parsedUrl.pathname = modelsPath.startsWith('/') ? modelsPath : `/${modelsPath}`
  parsedUrl.search = ''
  parsedUrl.hash = ''

  return parsedUrl.toString()
}

export const extractModelIdsFromPayload = (payload: unknown) => {
  const entries: unknown[] = []

  if (Array.isArray(payload)) {
    entries.push(...payload)
  }

  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>
    if (Array.isArray(record.data)) {
      entries.push(...record.data)
    }
    if (Array.isArray(record.models)) {
      entries.push(...record.models)
    }
    if (Array.isArray(record.results)) {
      entries.push(...record.results)
    }
  }

  const modelIds = entries
    .map((entry) => {
      if (typeof entry === 'string') {
        return entry
      }

      if (entry && typeof entry === 'object') {
        const record = entry as Record<string, unknown>
        if (typeof record.id === 'string') {
          return record.id
        }
        if (typeof record.model === 'string') {
          return record.model
        }
        if (typeof record.name === 'string') {
          return record.name
        }
      }

      return null
    })
    .filter((value): value is string => Boolean(value?.trim()))
    .map((value) => value.trim())

  return Array.from(new Set(modelIds))
}

export const CUSTOM_MODEL_FETCH_ERROR =
  'Unable to fetch models because the API used does not respond to this endpoint call, or the endpoint does not exist.'
