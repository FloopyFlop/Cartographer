import { useState } from 'react'
import { ExternalLink, Image, ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import type { ImageryFrame } from '@/types'
import { useImageryPreview } from '@/hooks/useImageryPreview'

export function SearchImagery({ frames, query, searchId }: { frames: ImageryFrame[]; query: string; searchId: string }) {
  const [index, setIndex] = useState(0)
  const frame = frames[Math.min(index, frames.length - 1)]
  const preview = useImageryPreview(frame?.source || { provider: '', attribution: '' }, searchId, frame?.id)
  if (!frame) return null
  const captured = frame.capturedAt?.slice(0, 7)
  const date = captured && /^\d{4}-\d{2}$/.test(captured) ? new Date(`${captured}-01T00:00:00Z`) : undefined
  const dateLabel = date && Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date) : undefined
  return <Dialog>
    <DialogTrigger asChild><Button variant="outline" size="sm" className="search-imagery-trigger"><Image size={14}/>View {frames.length} analyzed {frames.length === 1 ? 'photo' : 'photos'}</Button></DialogTrigger>
    <DialogContent className="search-imagery-dialog">
      <DialogHeader><DialogTitle>Search imagery</DialogTitle><DialogDescription>{query}</DialogDescription></DialogHeader>
      <div className="search-image-view">
        {preview.imageUrl && !preview.failed
          ? <img src={preview.imageUrl} alt={frame.heading === undefined ? 'Analyzed street-level photo' : `Analyzed Street View photo facing ${frame.heading} degrees`} onError={preview.onFail}/>
          : <div className="p-6 text-center text-sm text-muted-foreground"><p>Preview expired. Open the original imagery below to inspect this location.</p>{frame.source.provider === 'google' && <Button className="mt-3" variant="outline" disabled={preview.loading} onClick={() => void preview.reload()}>{preview.loading ? 'Loading preview…' : 'Reload preview'}</Button>}<p className="mt-2 text-xs">Reloading uses your Google budget when the photo is no longer cached.</p>{preview.error && <p className="mt-2" role="alert">{preview.error}</p>}</div>}
      </div>
      <div className="search-image-navigation"><Button variant="outline" size="icon" aria-label="Previous photo" disabled={index === 0} onClick={() => setIndex(value => Math.max(0, value - 1))}><ChevronLeft size={16}/></Button><span>{Math.min(index + 1, frames.length)} of {frames.length}{frame.heading === undefined ? '' : ` · Facing ${frame.heading}°`}</span><Button variant="outline" size="icon" aria-label="Next photo" disabled={index >= frames.length - 1} onClick={() => setIndex(value => Math.min(frames.length - 1, value + 1))}><ChevronRight size={16}/></Button></div>
      <div className="search-image-caption"><p>{frame.detectionsCount ? `${frame.detectionsCount} visual ${frame.detectionsCount === 1 ? 'match' : 'matches'}` : 'No clear match in this photo'}{dateLabel ? ` · Photographed ${dateLabel}` : ''}</p><p>{frame.source.attribution}</p>{frame.source.referenceUrl && <Button asChild variant="outline" size="sm"><a href={frame.source.referenceUrl} target="_blank" rel="noreferrer">Open source imagery<ExternalLink size={13}/></a></Button>}</div>
    </DialogContent>
  </Dialog>
}
