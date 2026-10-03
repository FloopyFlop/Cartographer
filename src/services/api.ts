import type { Location, SearchJob, SearchRequest } from '@/types'

export interface ProviderBudget {
  limitUsd: number
  usedUsd: number
  reservedUsd: number
  remainingUsd: number
}

export interface BudgetUsage {
  google: ProviderBudget
  openai: ProviderBudget
  imageryProvider?: string
  model: string
  liveSearchAvailable: boolean
  blockedReason?: string | null
}

export class ApiError extends Error {
  readonly code: string
  readonly status: number
  readonly details?: unknown

  constructor(message: string, code: string, status = 0, details?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
    this.details = details
  }
}

const REQUEST_TIMEOUT_MS = 20_000
const statuses = new Set(['queued', 'running', 'completed', 'cancelled', 'failed'])
const modes = new Set(['demo', 'live', 'precomputed'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isPosition(value: unknown): boolean {
  return isRecord(value) && typeof value.longitude === 'number' && Number.isFinite(value.longitude)
    && value.longitude >= -180 && value.longitude <= 180
    && typeof value.latitude === 'number' && Number.isFinite(value.latitude)
    && value.latitude >= -90 && value.latitude <= 90
}

function isBounds(value: unknown): boolean {
  return isRecord(value) && ['west', 'south', 'east', 'north'].every(key =>
    typeof value[key] === 'number' && Number.isFinite(value[key]))
    && Number(value.west) >= -180 && Number(value.west) <= 180
    && Number(value.east) >= -180 && Number(value.east) <= 180
    && Number(value.south) >= -90 && Number(value.north) <= 90
    && Number(value.south) < Number(value.north) && value.west !== value.east
}

function isArea(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (value.kind === 'radius') return isPosition(value.center)
    && typeof value.radiusMeters === 'number' && Number.isFinite(value.radiusMeters) && value.radiusMeters > 0
  if (value.kind === 'region' || value.kind === 'viewport') return isBounds(value.bounds)
  if (value.kind === 'route') return Array.isArray(value.coordinates)
    && value.coordinates.length >= 2 && value.coordinates.every(isPosition)
    && typeof value.corridorMeters === 'number' && Number.isFinite(value.corridorMeters) && value.corridorMeters > 0
  return false
}

function isDetection(value: unknown): boolean {
  return isRecord(value) && typeof value.id === 'string' && isPosition(value.position)
    && typeof value.featureType === 'string' && typeof value.title === 'string'
    && typeof value.searchId === 'string' && typeof value.confidence === 'number'
    && Number.isFinite(value.confidence) && value.confidence >= 0 && value.confidence <= 1
    && isRecord(value.attributes) && isRecord(value.source)
    && typeof value.source.provider === 'string' && typeof value.source.attribution === 'string'
    && typeof value.detectedAt === 'string' && isRecord(value.model)
    && typeof value.model.name === 'string' && typeof value.model.version === 'string'
    && ['unverified', 'confirmed', 'rejected'].includes(String(value.verification))
}

function isFrame(value: unknown): boolean {
  return isRecord(value) && typeof value.id === 'string' && isPosition(value.position)
    && (value.heading === undefined || typeof value.heading === 'number' && Number.isFinite(value.heading)
      && value.heading >= 0 && value.heading < 360) && isRecord(value.source)
    && typeof value.source.provider === 'string' && typeof value.source.attribution === 'string'
    && typeof value.detectionsCount === 'number' && Number.isInteger(value.detectionsCount)
    && value.detectionsCount >= 0 && value.status === 'analyzed'
}

function parseJob(value: unknown, expectedId?: string): SearchJob {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id
    || (expectedId !== undefined && value.id !== expectedId)
    || typeof value.query !== 'string' || !statuses.has(String(value.status))
    || !modes.has(String(value.mode)) || !isArea(value.area)
    || !isRecord(value.progress) || typeof value.progress.completed !== 'number'
    || !Number.isFinite(value.progress.completed) || value.progress.completed < 0
    || typeof value.progress.total !== 'number' || !Number.isFinite(value.progress.total)
    || value.progress.total < 0 || typeof value.progress.stage !== 'string'
    || !Array.isArray(value.detections) || !value.detections.every(isDetection)
    || (value.frames !== undefined && (!Array.isArray(value.frames) || !value.frames.every(isFrame)))
    || typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string') {
    throw new ApiError('The server returned an incomplete search. Please try again.', 'INVALID_RESPONSE', 502)
  }
  return value as unknown as SearchJob
}

function parseLocations(value: unknown): Location[] {
  if (!isRecord(value) || !Array.isArray(value.locations)
    || !value.locations.every(location => isRecord(location)
      && typeof location.label === 'string' && isPosition(location.position)
      && (location.bounds === undefined || isBounds(location.bounds)))) {
    throw new ApiError('The server returned an invalid list of locations.', 'INVALID_RESPONSE', 502)
  }
  return value.locations as Location[]
}

function isBudget(value: unknown): boolean {
  return isRecord(value) && ['limitUsd', 'usedUsd', 'reservedUsd', 'remainingUsd'].every(key =>
    typeof value[key] === 'number' && Number.isFinite(value[key]) && Number(value[key]) >= 0)
}

async function request(path: string, options: RequestInit = {}, signal?: AbortSignal): Promise<unknown> {
  const controller = new AbortController()
  let timedOut = false
  const abort = () => controller.abort(signal?.reason)
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(`/api${path}`, {
      ...options,
      headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers, 'X-Cartographer-Request': '1' },
      signal: controller.signal,
    })
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      if (controller.signal.aborted) throw new DOMException('Request cancelled', 'AbortError')
      if (response.ok) throw new ApiError('The server returned an unreadable response.', 'INVALID_RESPONSE', response.status)
    }
    if (!response.ok) {
      const error = isRecord(payload) && isRecord(payload.error) ? payload.error : undefined
      throw new ApiError(
        error && typeof error.message === 'string' ? error.message : `The request could not be completed (${response.status}).`,
        error && typeof error.code === 'string' ? error.code : 'HTTP_ERROR',
        response.status,
        error?.details,
      )
    }
    return payload
  } catch (error) {
    if (timedOut) throw new ApiError('The server took too long to respond. Please try again.', 'TIMEOUT')
    if (signal?.aborted || controller.signal.aborted) throw new DOMException('Request cancelled', 'AbortError')
    if (error instanceof ApiError) throw error
    throw new ApiError('Cartographer could not reach the server. Check your connection and try again.', 'NETWORK_ERROR')
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
  }
}

export const searchService = {
  async create(search: SearchRequest, signal?: AbortSignal): Promise<SearchJob> {
    return parseJob(await request('/searches', { method: 'POST', body: JSON.stringify(search) }, signal))
  },
  async get(id: string, signal?: AbortSignal): Promise<SearchJob> {
    return parseJob(await request(`/searches/${encodeURIComponent(id)}`, {}, signal), id)
  },
  async cancel(id: string, signal?: AbortSignal): Promise<SearchJob> {
    return parseJob(await request(`/searches/${encodeURIComponent(id)}`, { method: 'DELETE' }, signal), id)
  },
  async imagery(id: string, frameId: string, signal?: AbortSignal): Promise<string> {
    const value = await request(`/searches/${encodeURIComponent(id)}/imagery/${encodeURIComponent(frameId)}`, { method: 'POST' }, signal)
    if (!isRecord(value) || typeof value.imageUrl !== 'string' || !/^\/api\/imagery\/google-[a-zA-Z0-9_-]+$/.test(value.imageUrl)) {
      throw new ApiError('The server returned an invalid photo preview.', 'INVALID_RESPONSE', 502)
    }
    return value.imageUrl
  },
  async locations(query: string, signal?: AbortSignal, remote = false): Promise<Location[]> {
    return parseLocations(await request(`/locations?q=${encodeURIComponent(query)}${remote ? '&remote=1' : ''}`, {}, signal))
  },
  async health(signal?: AbortSignal): Promise<{ status: string; provider: string; liveSearchAvailable: boolean }> {
    const value = await request('/health', {}, signal)
    if (!isRecord(value) || typeof value.status !== 'string' || typeof value.provider !== 'string'
      || typeof value.liveSearchAvailable !== 'boolean') {
      throw new ApiError('The server returned an invalid health response.', 'INVALID_RESPONSE', 502)
    }
    return value as { status: string; provider: string; liveSearchAvailable: boolean }
  },
  async usage(signal?: AbortSignal): Promise<BudgetUsage> {
    const value = await request('/usage', {}, signal)
    if (!isRecord(value) || !isBudget(value.google) || !isBudget(value.openai)
      || typeof value.model !== 'string' || typeof value.liveSearchAvailable !== 'boolean'
      || (value.imageryProvider !== undefined && typeof value.imageryProvider !== 'string')
      || (value.blockedReason !== undefined && value.blockedReason !== null && typeof value.blockedReason !== 'string')) {
      throw new ApiError('The server returned invalid budget information.', 'INVALID_RESPONSE', 502)
    }
    return value as unknown as BudgetUsage
  },
}
