import { useEffect, useRef, useState } from 'react'
import { searchService } from '@/services/api'
import type { Detection } from '@/types'

export function useImageryPreview(source: Detection['source'], searchId: string, frameId?: string) {
  const [imageUrl, setImageUrl] = useState(source.imageUrl)
  const [failed, setFailed] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const controller = useRef<AbortController | null>(null)
  useEffect(() => {
    controller.current?.abort()
    setImageUrl(source.imageUrl); setFailed(false); setLoading(false); setError(null)
    return () => controller.current?.abort()
  }, [source.imageUrl, searchId, frameId])
  const reload = async () => {
    if (loading || source.provider !== 'google') return
    const id = frameId || source.imageUrl?.split('/').pop()
    if (!id) return
    controller.current?.abort()
    const current = new AbortController()
    controller.current = current
    setLoading(true); setError(null)
    try {
      const url = await searchService.imagery(searchId, id, current.signal)
      if (!current.signal.aborted) { setImageUrl(url); setFailed(false) }
    } catch (cause) {
      if (!current.signal.aborted) setError(cause instanceof Error ? cause.message : 'The preview could not be reloaded.')
    } finally {
      if (!current.signal.aborted) setLoading(false)
    }
  }
  return { imageUrl, failed, onFail: () => setFailed(true), reload, loading, error }
}
