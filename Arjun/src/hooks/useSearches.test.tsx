// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSearches } from './useSearches'
import { searchService } from '@/services/api'
import type { Detection, SearchJob, SearchRequest, SearchStatus } from '@/types'

vi.mock('@/services/api', () => ({ searchService: { create: vi.fn(), get: vi.fn(), cancel: vi.fn() } }))

const request: SearchRequest = { query: 'Find benches', mode: 'auto',
  area: { kind: 'radius', center: { longitude: -76.48, latitude: 42.45 }, radiusMeters: 650 } }
const detection: Detection = { id: 'bench-1', searchId: 'search-1', title: 'Bench', featureType: 'bench',
  position: request.area.kind === 'radius' ? request.area.center : { longitude: 0, latitude: 0 },
  confidence: 0.9, attributes: {}, source: { provider: 'demo', attribution: 'Demonstration' },
  detectedAt: '2026-10-03T12:00:00Z', model: { name: 'demo', version: '1' }, verification: 'unverified' }
const job = (status: SearchStatus = 'queued', id = 'search-1', detections: Detection[] = []): SearchJob => ({
  id, query: request.query, area: request.area, mode: 'demo', status, detections,
  progress: { completed: detections.length, total: 10, stage: 'Loading demonstration layer' },
  createdAt: '2026-10-03T12:00:00Z', updatedAt: '2026-10-03T12:00:01Z',
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

let current: ReturnType<typeof useSearches>
let root: Root | undefined
let container: HTMLDivElement

function Harness() { current = useSearches(); return null }

beforeEach(async () => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.mocked(searchService.create).mockResolvedValue(job())
  vi.mocked(searchService.get).mockResolvedValue(job('completed'))
  vi.mocked(searchService.cancel).mockResolvedValue(job('cancelled'))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root?.render(<Harness />) })
})

afterEach(async () => {
  await act(async () => { root?.unmount() })
  root = undefined
  container.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const start = async () => { await act(async () => { await current.startSearch(request) }) }
const advance = async (milliseconds: number) => {
  await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds) })
}

describe('progressive search workflow', () => {
  it('retains layers and visibility while progressive results arrive and polling stops on completion', async () => {
    vi.mocked(searchService.get).mockResolvedValueOnce(job('running', 'search-1', [detection]))
      .mockResolvedValueOnce(job('completed', 'search-1', [detection]))
    await start()
    expect(current.activeJobs).toHaveLength(1)
    await act(async () => { current.toggleLayer('search-1') })
    await advance(750)
    expect(current.layers[0].job.detections).toEqual([detection])
    expect(current.layers[0].visible).toBe(false)
    await advance(750)
    expect(current.activeJobs).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    vi.mocked(searchService.create).mockResolvedValueOnce(job('completed', 'search-2'))
    await start()
    expect(current.layers.map(layer => layer.job.id)).toEqual(['search-1', 'search-2'])
    expect(current.layers[0].visible).toBe(false)
  })

  it('handles submission failure without creating a layer or leaving a loading state', async () => {
    vi.mocked(searchService.create).mockRejectedValueOnce(new Error('Choose a smaller area.'))
    let result: SearchJob | undefined
    await act(async () => { result = await current.startSearch(request) })
    expect(result).toBeUndefined()
    expect(current.layers).toEqual([])
    expect(current.isSubmitting).toBe(false)
    expect(current.requestError).toBe('Choose a smaller area.')
  })

  it('does not let an in-flight poll overwrite a cancelled search', async () => {
    const pending = deferred<SearchJob>()
    vi.mocked(searchService.get).mockReturnValueOnce(pending.promise)
    await start()
    await advance(750)
    const signal = vi.mocked(searchService.get).mock.calls[0][1]
    await act(async () => { await current.cancelSearch('search-1') })
    expect(signal?.aborted).toBe(true)
    await act(async () => { pending.resolve(job('running', 'search-1', [detection])) })
    expect(current.layers[0].job.status).toBe('cancelled')
    expect(current.layers[0].job.detections).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels an active backend job on removal and ignores its late results', async () => {
    const pending = deferred<SearchJob>()
    vi.mocked(searchService.get).mockReturnValueOnce(pending.promise)
    await start()
    await advance(750)
    const signal = vi.mocked(searchService.get).mock.calls[0][1]
    await act(async () => { current.removeLayer('search-1') })
    expect(signal?.aborted).toBe(true)
    expect(searchService.cancel).toHaveBeenCalledWith('search-1', expect.any(AbortSignal))
    await act(async () => { pending.resolve(job('completed', 'search-1', [detection])) })
    expect(current.layers).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports when removing an active layer cannot stop its spending job', async () => {
    vi.mocked(searchService.cancel).mockRejectedValueOnce(new Error('Server unavailable.'))
    await start()
    await act(async () => { current.removeLayer('search-1') })
    expect(current.layers).toEqual([])
    expect(current.requestError).toContain('may continue using your budget')
  })

  it('retains previous detections across a poll failure and retries with backoff', async () => {
    vi.mocked(searchService.get).mockResolvedValueOnce(job('running', 'search-1', [detection]))
      .mockRejectedValueOnce(new Error('Connection interrupted.'))
      .mockResolvedValueOnce(job('completed', 'search-1', [detection]))
    await start()
    await advance(750)
    await advance(750)
    expect(current.layers[0].job.detections).toEqual([detection])
    expect(current.pollError).toContain('Connection interrupted.')
    await advance(1499)
    expect(searchService.get).toHaveBeenCalledTimes(2)
    await advance(1)
    expect(searchService.get).toHaveBeenCalledTimes(3)
    expect(current.pollError).toBeNull()
    expect(current.layers[0].job.status).toBe('completed')
  })

  it('resumes polling if cancellation fails', async () => {
    vi.mocked(searchService.cancel).mockRejectedValueOnce(new Error('Server unavailable.'))
    await start()
    await act(async () => { await current.cancelSearch('search-1') })
    expect(current.requestError).toContain('Could not stop the search.')
    expect(current.activeJobs).toHaveLength(1)
    await advance(750)
    expect(current.layers[0].job.status).toBe('completed')
  })

  it('cleans up requests and timers when its owner unmounts', async () => {
    const pending = deferred<SearchJob>()
    vi.mocked(searchService.get).mockReturnValueOnce(pending.promise)
    await start()
    await advance(750)
    const signal = vi.mocked(searchService.get).mock.calls[0][1]
    await act(async () => { root?.unmount(); root = undefined })
    expect(signal?.aborted).toBe(true)
    pending.resolve(job('running'))
    await advance(60_000)
    expect(searchService.get).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves all twelve layers and explains the limit before sending another search', async () => {
    vi.mocked(searchService.create).mockImplementation(async () => job('completed', `search-${vi.mocked(searchService.create).mock.calls.length}`))
    for (let index = 0; index < 12; index++) await start()
    await start()
    expect(current.layers).toHaveLength(12)
    expect(searchService.create).toHaveBeenCalledTimes(12)
    expect(current.requestError).toContain('Remove a result layer')
  })

  it('restores an explicitly rerun cached search after its previous layer was removed', async () => {
    vi.mocked(searchService.create).mockResolvedValue(job('completed'))
    await start()
    await act(async () => { current.removeLayer('search-1') })
    expect(current.layers).toEqual([])
    let restored: SearchJob | undefined
    await act(async () => { restored = await current.startSearch(request) })
    expect(restored?.id).toBe('search-1')
    expect(current.layers).toEqual([{ job: job('completed'), visible: true }])
  })

  it('does not restore a layer removed while its new submission is pending', async () => {
    vi.mocked(searchService.create).mockResolvedValueOnce(job('completed'))
    await start()
    const pending = deferred<SearchJob>()
    vi.mocked(searchService.create).mockReturnValueOnce(pending.promise)
    let submission: Promise<SearchJob | undefined>
    await act(async () => { submission = current.startSearch(request) })
    await act(async () => { current.removeLayer('search-1') })
    let returned: SearchJob | undefined
    await act(async () => { pending.resolve(job('completed')); returned = await submission })
    expect(returned).toBeUndefined()
    expect(current.layers).toEqual([])
  })

  it('honors a second removal during concurrent reruns of a previously removed cached search', async () => {
    vi.mocked(searchService.create).mockResolvedValueOnce(job('completed'))
    await start()
    await act(async () => { current.removeLayer('search-1') })
    const first = deferred<SearchJob>()
    const second = deferred<SearchJob>()
    vi.mocked(searchService.create).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    let firstSubmission: Promise<SearchJob | undefined>
    let secondSubmission: Promise<SearchJob | undefined>
    await act(async () => { firstSubmission = current.startSearch(request); secondSubmission = current.startSearch(request) })
    await act(async () => { first.resolve(job('completed')); await firstSubmission })
    expect(current.layers).toHaveLength(1)
    await act(async () => { current.removeLayer('search-1') })
    await act(async () => { second.resolve(job('completed')); await secondSubmission })
    expect(current.layers).toEqual([])
  })
})
