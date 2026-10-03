import { useCallback, useEffect, useRef, useState } from 'react'
import { searchService } from '@/services/api'
import type { SearchJob, SearchLayer, SearchRequest } from '@/types'

const POLL_INTERVAL_MS = 750
const MAX_RETRY_DELAY_MS = 12_000
const MAX_LAYERS = 12
const active = (job: SearchJob) => job.status === 'queued' || job.status === 'running'
const aborted = (error: unknown) => error instanceof Error && error.name === 'AbortError'
const message = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Please try again.'

export function useSearches() {
  const [layers, setLayers] = useState<SearchLayer[]>([])
  const [requestError, setRequestError] = useState<string | null>(null)
  const [pollError, setPollError] = useState<string | null>(null)
  const [submittingCount, setSubmittingCount] = useState(0)
  const layersRef = useRef<SearchLayer[]>([])
  const mounted = useRef(true)
  const removed = useRef(new Set<string>())
  const removalVersions = useRef(new Map<string, number>())
  const cancelling = useRef(new Set<string>())
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const pollControllers = useRef(new Map<string, AbortController>())
  const cancelControllers = useRef(new Map<string, AbortController>())
  const createControllers = useRef(new Set<AbortController>())
  const failures = useRef(new Map<string, number>())
  const pollErrors = useRef(new Map<string, string>())
  const poll = useRef<(id: string) => Promise<void>>(async () => {})

  const publish = useCallback((next: SearchLayer[]) => {
    layersRef.current = next
    if (mounted.current) setLayers(next)
  }, [])

  const publishPollError = useCallback(() => {
    if (mounted.current) setPollError(pollErrors.current.values().next().value ?? null)
  }, [])

  const clearPollError = useCallback((id: string) => {
    failures.current.delete(id)
    pollErrors.current.delete(id)
    publishPollError()
  }, [publishPollError])

  const stopPolling = useCallback((id: string) => {
    const timer = timers.current.get(id)
    if (timer !== undefined) clearTimeout(timer)
    timers.current.delete(id)
    pollControllers.current.get(id)?.abort()
    pollControllers.current.delete(id)
  }, [])

  const schedulePoll = useCallback((id: string, delay = POLL_INTERVAL_MS) => {
    if (!mounted.current || removed.current.has(id) || cancelling.current.has(id)
      || timers.current.has(id) || pollControllers.current.has(id)) return
    const layer = layersRef.current.find(item => item.job.id === id)
    if (!layer || !active(layer.job)) return
    timers.current.set(id, setTimeout(() => {
      timers.current.delete(id)
      void poll.current(id)
    }, delay))
  }, [])

  poll.current = useCallback(async (id: string) => {
    if (!mounted.current || removed.current.has(id) || cancelling.current.has(id)) return
    const before = layersRef.current.find(item => item.job.id === id)
    if (!before || !active(before.job)) return
    const controller = new AbortController()
    pollControllers.current.set(id, controller)
    let nextDelay = POLL_INTERVAL_MS
    try {
      const job = await searchService.get(id, controller.signal)
      const latest = layersRef.current.find(item => item.job.id === id)
      if (!mounted.current || controller.signal.aborted || removed.current.has(id)
        || cancelling.current.has(id) || !latest || !active(latest.job)) return
      clearPollError(id)
      // A slower response must never replace a more recent snapshot.
      if (Date.parse(job.updatedAt) < Date.parse(latest.job.updatedAt)) return
      publish(layersRef.current.map(layer => layer.job.id === id ? { ...layer, job } : layer))
    } catch (error) {
      if (!mounted.current || controller.signal.aborted || removed.current.has(id)
        || cancelling.current.has(id) || aborted(error)) return
      const count = (failures.current.get(id) ?? 0) + 1
      failures.current.set(id, count)
      nextDelay = Math.min(MAX_RETRY_DELAY_MS, POLL_INTERVAL_MS * 2 ** Math.min(count, 5))
      pollErrors.current.set(id, `${message(error)} Retrying search updates automatically.`)
      publishPollError()
    } finally {
      if (pollControllers.current.get(id) === controller) pollControllers.current.delete(id)
      schedulePoll(id, nextDelay)
    }
  }, [clearPollError, publish, publishPollError, schedulePoll])

  useEffect(() => {
    mounted.current = true
    layersRef.current.filter(layer => active(layer.job)).forEach(layer => schedulePoll(layer.job.id))
    return () => {
      mounted.current = false
      timers.current.forEach(timer => clearTimeout(timer))
      timers.current.clear()
      pollControllers.current.forEach(controller => controller.abort())
      pollControllers.current.clear()
      createControllers.current.forEach(controller => controller.abort())
      createControllers.current.clear()
      cancelControllers.current.forEach(controller => controller.abort())
      cancelControllers.current.clear()
    }
  }, [schedulePoll])

  const startSearch = useCallback(async (request: SearchRequest): Promise<SearchJob | undefined> => {
    setRequestError(null)
    if (layersRef.current.length >= MAX_LAYERS) {
      setRequestError('Remove a result layer before starting another search. You can keep up to 12 layers on this map.')
      return undefined
    }
    const removedAtStart = new Set(removed.current)
    const removalVersionsAtStart = new Map(removalVersions.current)
    const controller = new AbortController()
    createControllers.current.add(controller)
    setSubmittingCount(count => count + 1)
    try {
      const job = await searchService.create(request, controller.signal)
      if (!mounted.current || controller.signal.aborted) return undefined
      const removedDuringSubmission = removed.current.has(job.id)
        && (!removedAtStart.has(job.id) || removalVersions.current.get(job.id) !== removalVersionsAtStart.get(job.id))
      if (removedDuringSubmission) return undefined
      // Concurrent submissions can fill the last available slot while this request runs.
      if (layersRef.current.length >= MAX_LAYERS) {
        setRequestError('Remove a result layer before starting another search. You can keep up to 12 layers on this map.')
        if (active(job)) {
          try {
            await searchService.cancel(job.id, controller.signal)
          } catch (error) {
            if (mounted.current && !controller.signal.aborted && !aborted(error)) {
              setRequestError(`The map is full, and the new search could not be stopped. It may continue using your budget. ${message(error)}`)
            }
          }
        }
        return undefined
      }
      removed.current.delete(job.id)
      publish([...layersRef.current.filter(layer => layer.job.id !== job.id), { job, visible: true }])
      schedulePoll(job.id)
      return job
    } catch (error) {
      if (mounted.current && !controller.signal.aborted && !aborted(error)) setRequestError(message(error))
      return undefined
    } finally {
      createControllers.current.delete(controller)
      if (mounted.current) setSubmittingCount(count => Math.max(0, count - 1))
    }
  }, [publish, schedulePoll])

  const cancelSearch = useCallback(async (id: string): Promise<void> => {
    const layer = layersRef.current.find(item => item.job.id === id)
    if (!layer || !active(layer.job) || cancelling.current.has(id)) return
    setRequestError(null)
    cancelling.current.add(id)
    stopPolling(id)
    clearPollError(id)
    const controller = new AbortController()
    cancelControllers.current.set(id, controller)
    try {
      const job = await searchService.cancel(id, controller.signal)
      if (!mounted.current || controller.signal.aborted || removed.current.has(id)) return
      publish(layersRef.current.map(item => item.job.id === id ? { ...item, job } : item))
    } catch (error) {
      if (mounted.current && !controller.signal.aborted && !aborted(error)) {
        setRequestError(removed.current.has(id)
          ? `The layer was removed, but its search could not be stopped and may continue using your budget. ${message(error)}`
          : `Could not stop the search. ${message(error)}`)
      }
    } finally {
      cancelling.current.delete(id)
      if (cancelControllers.current.get(id) === controller) cancelControllers.current.delete(id)
      schedulePoll(id)
    }
  }, [clearPollError, publish, schedulePoll, stopPolling])

  const toggleLayer = useCallback((id: string) => {
    publish(layersRef.current.map(layer => layer.job.id === id ? { ...layer, visible: !layer.visible } : layer))
  }, [publish])

  const removeLayer = useCallback((id: string) => {
    const layer = layersRef.current.find(item => item.job.id === id)
    removed.current.add(id)
    removalVersions.current.set(id, (removalVersions.current.get(id) ?? 0) + 1)
    stopPolling(id)
    clearPollError(id)
    publish(layersRef.current.filter(layer => layer.job.id !== id))
    if (!layer || !active(layer.job) || cancelControllers.current.has(id)) return
    const controller = new AbortController()
    cancelControllers.current.set(id, controller)
    void searchService.cancel(id, controller.signal).catch(error => {
      if (mounted.current && !controller.signal.aborted && !aborted(error)) {
        setRequestError(`The layer was removed, but its search could not be stopped and may continue using your budget. ${message(error)}`)
      }
    }).finally(() => {
      if (cancelControllers.current.get(id) === controller) cancelControllers.current.delete(id)
    })
  }, [clearPollError, publish, stopPolling])

  const clearError = useCallback(() => setRequestError(null), [])

  return {
    layers,
    startSearch,
    cancelSearch,
    toggleLayer,
    removeLayer,
    requestError,
    clearError,
    isSubmitting: submittingCount > 0,
    activeJobs: layers.filter(layer => active(layer.job)).map(layer => layer.job),
    pollError,
  }
}
