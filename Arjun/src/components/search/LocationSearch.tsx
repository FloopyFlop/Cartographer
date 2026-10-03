import { useEffect, useState } from 'react'
import { Search, MapPin, ArrowUpRight, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogTrigger } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { searchService } from '@/services/api'
import type { Location } from '@/types'
import { INITIAL_LOCATION } from '@/types'

export function LocationSearch({ location, onSelect }: { location: Location; onSelect: (location: Location) => void }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Location[]>([INITIAL_LOCATION])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      setLoading(true); setError(null)
      searchService.locations(query.trim() || 'Cornell', controller.signal)
        .then(value => { if (!controller.signal.aborted) setResults(value) })
        .catch((e: unknown) => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Location search is unavailable.') })
        .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    }, 250)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [query, open])
  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger asChild><Button variant="outline" className="location-trigger"><Search size={16}/><span>{location.label}</span><span className="location-shortcut">⌘ K</span></Button></DialogTrigger>
    <DialogContent className="location-dialog">
      <DialogHeader><DialogTitle>Go somewhere</DialogTitle><DialogDescription>Find a place, then choose where to look.</DialogDescription></DialogHeader>
      <div className="location-field"><Search size={17}/><Input autoFocus placeholder="Search for a city, campus, or place" value={query} onChange={e => setQuery(e.target.value)} aria-label="Search for a location"/>{loading && <Loader2 className="animate-spin" size={16}/>}</div>
      <div className="location-results" aria-live="polite">
        {error ? <p className="inline-message">{error}</p> : !loading && !results.length ? <p className="inline-message">No matching places. Try Cornell, Ithaca, New York, London, or San Francisco.</p> : results.map(result => <Button key={result.id || result.label} variant="ghost" className="location-result" onClick={() => { onSelect(result); setOpen(false); setQuery('') }}><MapPin size={18}/><span><strong>{result.label}</strong>{result.description && <small>{result.description}</small>}</span><ArrowUpRight size={15}/></Button>)}
      </div>
      <p className="dialog-footnote">Location search currently includes a small set of sample places.</p>
    </DialogContent>
  </Dialog>
}
