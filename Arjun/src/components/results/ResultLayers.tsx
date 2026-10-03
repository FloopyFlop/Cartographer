import { useState } from 'react'
import { ChevronDown, ChevronRight, Eye, EyeOff, MoreHorizontal, Trash2, Download, Square, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { FeatureIcon } from './FeatureIcon'
import type { Detection, SearchLayer } from '@/types'

function exportLayer(layer: SearchLayer) {
  const collection = { type: 'FeatureCollection', name: layer.job.query, properties: { source: layer.job.mode, query: layer.job.query, area: layer.job.area, coverage: layer.job.mode === 'live' ? 'sparse-sample' : 'synthetic-fixtures', positionAccuracy: layer.job.mode === 'live' ? 'camera-location' : 'illustrative', licenses: [...new Set(layer.job.detections.map(d => d.source.license?.name).filter(Boolean))] }, features: layer.job.detections.map(d => ({ type: 'Feature', id: d.id, geometry: { type: 'Point', coordinates: [d.position.longitude, d.position.latitude] }, properties: { title: d.title, featureType: d.featureType, description: d.description, confidence: d.confidence, source: d.source, verification: d.verification, attributes: d.attributes, metadata: d.metadata, model: d.model, detectedAt: d.detectedAt } })) }
  const url = URL.createObjectURL(new Blob([JSON.stringify(collection, null, 2)], { type: 'application/geo+json' }))
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${layer.job.query.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60) || 'cartographer'}-${layer.job.mode}.geojson`; anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
export function ResultLayers({ layers, selectedId, onSelect, onToggle, onRemove, onCancel }: { layers: SearchLayer[]; selectedId: string | null; onSelect: (d: Detection) => void; onToggle: (id: string) => void; onRemove: (id: string) => void; onCancel: (id: string) => void }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  if (!layers.length) return null
  return <section className="result-layers" aria-label="Search layers">
    <div className="section-heading"><h2>Your layers</h2><span>{layers.length}</span></div>
    {[...layers].reverse().map(layer => {
      const job = layer.job
      const active = job.status === 'queued' || job.status === 'running'
      const folded = collapsed.has(job.id)
      const count = job.detections.length
      const sample = job.mode === 'demo'
      const resultWord = sample ? 'sample result' : 'detection'
      const percent = job.progress.total ? Math.min(100, Math.round(job.progress.completed / job.progress.total * 100)) : 0
      return <div className="result-layer" key={job.id}>
        <div className="layer-header">
          <Button variant="ghost" className="layer-title" onClick={() => setCollapsed(prev => { const next = new Set(prev); next.has(job.id) ? next.delete(job.id) : next.add(job.id); return next })} aria-expanded={!folded}>{folded ? <ChevronRight size={14}/> : <ChevronDown size={14}/>}<span>{sample ? job.interpretation?.featureType.replaceAll('_', ' ') || job.query : job.query}</span></Button>
          <Button variant="ghost" size="icon" className="layer-action" onClick={() => onToggle(job.id)} aria-label={layer.visible ? `Hide ${job.query} layer` : `Show ${job.query} layer`}>{layer.visible ? <Eye size={15}/> : <EyeOff size={15}/>}</Button>
          <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="layer-action" aria-label={`Options for ${job.query}`}><MoreHorizontal size={16}/></Button></DropdownMenuTrigger><DropdownMenuContent align="end">{active && <DropdownMenuItem onSelect={() => onCancel(job.id)}><Square size={14}/>Stop search</DropdownMenuItem>}<DropdownMenuItem disabled={!count} onSelect={() => exportLayer(layer)}><Download size={14}/>Export GeoJSON</DropdownMenuItem><DropdownMenuItem onSelect={() => onRemove(job.id)}><Trash2 size={14}/>Remove layer</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
        </div>
        {!folded && <>
          {active ? <div className="search-progress" role="status"><div><span><Loader2 size={13} className="animate-spin"/>{job.progress.stage || 'Preparing search'}</span><Button variant="ghost" size="sm" onClick={() => onCancel(job.id)}>Stop</Button></div><div className="progress-track" role="progressbar" aria-label="Search progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><span style={{ width: `${percent}%` }}/></div><p>{count ? `${count} ${resultWord}${count === 1 ? '' : 's'} so far` : 'Results will appear as the search runs.'}</p></div> : job.status === 'failed' ? <p className="layer-message" role="alert">{job.error?.message || 'This search could not be completed.'}</p> : <p className="layer-summary">{job.status === 'cancelled' ? 'Stopped · ' : ''}{count ? `${count} ${resultWord}${count === 1 ? '' : 's'}${job.cacheHit ? ' · Cached' : ''}` : sample ? 'No sample results in this area' : 'No detections in the sampled imagery'}</p>}
          {!active && !count && job.status !== 'failed' && <p className="layer-message">{sample ? job.interpretation?.description || 'Try a larger area around Cornell or choose a different feature.' : job.progress.stage.includes('No') ? job.progress.stage + '. Try a nearby area.' : 'The sampled photos did not show a clear match. This does not mean the object is absent from the area.'}</p>}
          {count > 0 && <div className="detection-list">{job.detections.map(d => <Button key={d.id} variant="ghost" className={`detection-row ${selectedId === d.id ? 'selected' : ''}`} onClick={() => onSelect(d)}><FeatureIcon type={d.featureType} size={17}/><span>{d.title}</span><ChevronRight size={13}/></Button>)}</div>}
        </>}
      </div>
    })}
  </section>
}
