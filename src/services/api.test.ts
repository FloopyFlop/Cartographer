import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, searchService } from './api'
import type { SearchJob, SearchRequest } from '@/types'

const search: SearchRequest = {
  query: 'Find benches', mode: 'auto',
  area: { kind: 'radius', center: { longitude: -76.4831, latitude: 42.4474 }, radiusMeters: 650 },
}
const job: SearchJob = {
  id: 'search-1', query: search.query, mode: 'demo', status: 'running', area: search.area,
  createdAt: '2026-10-03T12:00:00Z', updatedAt: '2026-10-03T12:00:01Z',
  progress: { completed: 1, total: 10, stage: 'Analyzing imagery' },
  detections: [{
    id: 'bench-1', searchId: 'search-1', featureType: 'bench', title: 'Bench', confidence: 0.92,
    position: { longitude: -76.483, latitude: 42.447 }, attributes: { covered: false },
    source: { provider: 'demo', attribution: 'Demonstration data' },
    detectedAt: '2026-10-03T12:00:01Z', model: { name: 'demo', version: '1' }, verification: 'unverified',
  }],
}
const mockResponse = (payload: unknown, status = 200) => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), {
    status, headers: { 'Content-Type': 'application/json' },
  }))
  vi.stubGlobal('fetch', fetch)
  return fetch
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('search API boundary', () => {
  it('sends the structured search and preserves detection metadata', async () => {
    const fetch = mockResponse(job, 201)
    expect(await searchService.create(search)).toEqual(job)
    expect(fetch).toHaveBeenCalledWith('/api/searches', expect.objectContaining({
      method: 'POST', body: JSON.stringify(search),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Cartographer-Request': '1' },
    }))
  })

  it('sends an explicit image limit and accepts analyzed photos without detections', async () => {
    const frames = [{ id: 'frame-1', position: search.area.kind === 'radius' ? search.area.center : {}, heading: 90, source: { provider: 'google', attribution: 'Google', imageUrl: '/api/imagery/frame-1' }, detectionsCount: 0, status: 'analyzed' }]
    const fetch = mockResponse({ ...job, mode: 'live', frames, detections: [] })
    const request = { ...search, configuration: { maxImages: 16 } }
    expect((await searchService.create(request)).frames).toEqual(frames)
    expect(fetch).toHaveBeenCalledWith('/api/searches', expect.objectContaining({ body: JSON.stringify(request) }))
  })

  it('keeps paid location lookup explicit', async () => {
    const fetch = mockResponse({ locations: [] })
    await searchService.locations('Duffield Hall', undefined, true)
    expect(fetch).toHaveBeenCalledWith('/api/locations?q=Duffield%20Hall&remote=1', expect.objectContaining({
      headers: expect.objectContaining({ 'X-Cartographer-Request': '1' }),
    }))
  })

  it('reloads only a recorded image with an explicit POST', async () => {
    const fetch = mockResponse({ imageUrl: '/api/imagery/google-refreshed' })
    expect(await searchService.imagery('job/1', 'google-old')).toBe('/api/imagery/google-refreshed')
    expect(fetch).toHaveBeenCalledWith('/api/searches/job%2F1/imagery/google-old', expect.objectContaining({
      method: 'POST', headers: expect.objectContaining({ 'X-Cartographer-Request': '1' }),
    }))
  })

  it('rejects an external or credential-bearing reload URL', async () => {
    mockResponse({ imageUrl: 'https://maps.example/image?key=secret' })
    await expect(searchService.imagery('job-1', 'google-old')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('rejects malformed analyzed frames', async () => {
    mockResponse({ ...job, frames: [{ id: 'frame-1', position: { longitude: 900, latitude: 42 }, heading: 90 }] })
    await expect(searchService.get(job.id)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('encodes identifiers and uses DELETE to cancel a search', async () => {
    const fetch = mockResponse({ ...job, id: 'search/with spaces', status: 'cancelled' })
    await searchService.cancel('search/with spaces')
    expect(fetch).toHaveBeenCalledWith('/api/searches/search%2Fwith%20spaces', expect.objectContaining({ method: 'DELETE' }))
  })

  it('unwraps locations and safely encodes the user query', async () => {
    const locations = [{ label: 'Cornell University', position: { longitude: -76.4831, latitude: 42.4474 } }]
    const fetch = mockResponse({ locations })
    expect(await searchService.locations('Cornell & Ithaca')).toEqual(locations)
    expect(fetch).toHaveBeenCalledWith('/api/locations?q=Cornell%20%26%20Ithaca', expect.any(Object))
  })

  it('reports provider capabilities from health', async () => {
    const health = { status: 'ok', provider: 'demo', liveSearchAvailable: false }
    mockResponse(health)
    expect(await searchService.health()).toEqual(health)
  })

  it('preserves spending reservations and an actionable availability reason', async () => {
    const budget = { limitUsd: 5, usedUsd: 0.24, reservedUsd: 0.12, remainingUsd: 4.64 }
    const usage = { google: budget, openai: budget, model: 'gpt-5-mini', liveSearchAvailable: false,
      blockedReason: 'An imagery provider is not configured.' }
    const fetch = mockResponse(usage)
    expect(await searchService.usage()).toEqual(usage)
    expect(fetch).toHaveBeenCalledWith('/api/usage', expect.any(Object))
  })

  it('rejects invalid budget information', async () => {
    mockResponse({ google: { limitUsd: '5' }, openai: {}, model: 'gpt-5-mini', liveSearchAvailable: false })
    await expect(searchService.usage()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('accepts a null availability reason when live search is available', async () => {
    const budget = { limitUsd: 4, usedUsd: 0, reservedUsd: 0, remainingUsd: 4 }
    const usage = { google: budget, openai: { ...budget, limitUsd: 2, remainingUsd: 2 },
      model: 'gpt-4.1-mini', liveSearchAvailable: true, blockedReason: null }
    mockResponse(usage)
    expect(await searchService.usage()).toEqual(usage)
  })

  it('retains structured server errors including a useful user message', async () => {
    mockResponse({ error: { code: 'AREA_TOO_LARGE', message: 'Choose a smaller area.', details: { maximum: 25 } } }, 422)
    await expect(searchService.create(search)).rejects.toMatchObject({
      name: 'ApiError', code: 'AREA_TOO_LARGE', message: 'Choose a smaller area.', status: 422, details: { maximum: 25 },
    })
  })

  it('handles server HTML errors without displaying their markup', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<h1>Proxy error</h1>', { status: 503 })))
    await expect(searchService.get('search-1')).rejects.toMatchObject({ code: 'HTTP_ERROR', status: 503 })
  })

  it('rejects successful but malformed JSON responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{missing', { status: 200 })))
    await expect(searchService.get('search-1')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it.each([
    { ...job, progress: null },
    { ...job, status: 'invented' },
    { ...job, detections: [{ ...job.detections[0], position: { longitude: 900, latitude: 42 } }] },
    { ...job, detections: [{ ...job.detections[0], confidence: 8 }] },
  ])('rejects incomplete or invalid search records', async payload => {
    mockResponse(payload)
    await expect(searchService.get('search-1')).rejects.toBeInstanceOf(ApiError)
  })

  it('rejects invalid location coordinates', async () => {
    mockResponse({ locations: [{ label: 'Invalid place', position: { longitude: 0, latitude: 100 } }] })
    await expect(searchService.locations('Invalid')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('rejects a snapshot belonging to a different search', async () => {
    mockResponse(job)
    await expect(searchService.get('other-search')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('turns network failures into a readable error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    await expect(searchService.health()).rejects.toMatchObject({ code: 'NETWORK_ERROR', status: 0 })
  })

  it('aborts slow requests with a distinct timeout error', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn((_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    })))
    const assertion = expect(searchService.get('search-1')).rejects.toMatchObject({ code: 'TIMEOUT' })
    await vi.advanceTimersByTimeAsync(20_000)
    await assertion
    expect(vi.getTimerCount()).toBe(0)
  })

  it('propagates caller cancellation without making it a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    })))
    const controller = new AbortController()
    const assertion = expect(searchService.get('search-1', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await assertion
  })
})
