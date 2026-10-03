import { useId, useRef } from 'react'
import { ArrowRight, Circle, Scan, Route, RectangleHorizontal, MousePointer2, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { areaDescription } from '@/lib/geography'
import { imageryName } from '@/lib/imagery'
import type { SearchArea, AreaTool, SearchRequest } from '@/types'

export type AreaMode = 'radius' | 'viewport' | 'region' | 'route'
const options = [ { kind: 'radius', label: 'Radius', Icon: Circle }, { kind: 'viewport', label: 'Map view', Icon: RectangleHorizontal }, { kind: 'region', label: 'Region', Icon: Scan }, { kind: 'route', label: 'Route', Icon: Route } ] as const
export function SearchPanel({ query, onQueryChange, area, areaMode, onAreaModeChange, onRadiusChange, onCorridorChange, onChoosePoint, tool, ready, isSubmitting, onSearch, error, onClearError, mode, onModeChange, liveAvailable, imageryProvider }: { query: string; onQueryChange: (query: string) => void; area: SearchArea; areaMode: AreaMode; onAreaModeChange: (mode: AreaMode) => void; onRadiusChange: (radius: number) => void; onCorridorChange: (meters: number) => void; onChoosePoint: () => void; tool: AreaTool; ready: boolean; isSubmitting: boolean; onSearch: () => void; error: string | null; onClearError: () => void; mode: SearchRequest['mode']; onModeChange: (mode: SearchRequest['mode']) => void; liveAvailable: boolean; imageryProvider: string }) {
  const input = useRef<HTMLTextAreaElement>(null)
  const queryId = useId()
  const draft = tool !== 'navigate'
  return <section className="search-panel" aria-label="Find physical features">
    <div className="search-intro"><h1>Find something.</h1><p>A question for the world around you.</p></div>
    <label className="field-label" htmlFor={queryId}>What are you looking for?</label>
    <Textarea id={queryId} ref={input} value={query} maxLength={500} placeholder="Bicycle racks near campus, benches along a walk…" onChange={e => { onQueryChange(e.target.value); onClearError() }} onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && query.trim() && !draft && ready && !isSubmitting) { e.preventDefault(); onSearch() } }} className="query-input"/>
    <div className="query-suggestions" aria-label="Example searches">{['Bicycle racks', 'Benches', 'Drinking fountains'].map(example => <Button key={example} variant="ghost" size="sm" onClick={() => { onQueryChange(example); onClearError(); input.current?.focus() }}>{example}<ArrowRight size={12}/></Button>)}</div>
    <div className="area-section"><h2>Where should we look?</h2>
      <div className="area-options" role="group" aria-label="Search area type">{options.map(({ kind, label, Icon }) => <Tooltip key={kind}><TooltipTrigger asChild><Button variant="ghost" className={areaMode === kind ? 'area-option active' : 'area-option'} onClick={() => onAreaModeChange(kind)} aria-pressed={areaMode === kind} disabled={!ready}><Icon size={16}/><span>{label}</span></Button></TooltipTrigger><TooltipContent>{kind === 'radius' ? 'Search around a point' : kind === 'viewport' ? 'Search the visible map' : kind === 'region' ? 'Choose two corners on the map' : 'Draw a walking route on the map'}</TooltipContent></Tooltip>)}</div>
      <div className="area-context">
        <p>{draft ? tool === 'radius' ? 'Choose a center on the map.' : tool === 'region' ? 'Choose two opposite corners.' : 'Click the map to draw your route.' : areaDescription(area)}</p>
        {areaMode === 'radius' && <div className="area-config"><Select value={String(area.kind === 'radius' ? area.radiusMeters : 650)} onValueChange={v => onRadiusChange(Number(v))}><SelectTrigger aria-label="Search radius"><SelectValue/></SelectTrigger><SelectContent>{[250, 500, 650, 1000, 1609, 2000].map(m => <SelectItem key={m} value={String(m)}>{m === 1609 ? '1 mile' : m >= 1000 ? `${m / 1000} km` : `${m} m`} radius</SelectItem>)}</SelectContent></Select><Button variant="ghost" size="sm" onClick={onChoosePoint} disabled={!ready}><MousePointer2 size={13}/>Set center</Button></div>}
        {areaMode === 'route' && <div className="area-config"><Select disabled={area.kind !== 'route'} value={String(area.kind === 'route' ? area.corridorMeters : 100)} onValueChange={v => onCorridorChange(Number(v))}><SelectTrigger aria-label="Route corridor width"><SelectValue/></SelectTrigger><SelectContent>{[50, 100, 200, 500].map(m => <SelectItem key={m} value={String(m)}>{m} m either side</SelectItem>)}</SelectContent></Select>{!draft && <Button variant="ghost" size="sm" onClick={() => onAreaModeChange('route')}>Redraw</Button>}</div>}
        {areaMode === 'region' && !draft && <Button variant="ghost" className="redraw-button" size="sm" onClick={() => onAreaModeChange('region')}>Redraw region</Button>}
        {areaMode === 'viewport' && <p className="area-help">Move the map to adjust the search area.</p>}
      </div>
    </div>
    <div className="search-mode"><span>Search method</span><Select value={mode} onValueChange={v => onModeChange(v as SearchRequest['mode'])}><SelectTrigger aria-label="Search method"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="auto">Automatic</SelectItem><SelectItem value="precomputed">Sample layers</SelectItem><SelectItem value="live">Live imagery</SelectItem></SelectContent></Select></div>
    {mode === 'live' && <p className="method-note">{liveAvailable ? `Analyze ${imageryName(imageryProvider)} with computer vision. Repeated searches reuse cached results.` : 'Live search is not available yet. Choose sample layers to try the workflow.'}</p>}
    <Button className="search-submit" disabled={!query.trim() || isSubmitting || draft || !ready} onClick={onSearch}>{isSubmitting ? <Loader2 size={16} className="animate-spin"/> : <ArrowRight size={17}/>}<span>{isSubmitting ? 'Starting search…' : draft ? 'Finish choosing an area' : 'Search this area'}</span></Button>
    {error && <div className="search-error" role="alert"><p>{error}</p><Button variant="ghost" size="sm" onClick={onClearError}>Dismiss</Button></div>}
    <p className="sample-disclosure">{mode === 'precomputed' || !liveAvailable ? 'Illustrative Cornell sample layers. Locations are not verified infrastructure.' : `Searches analyze a small sample of ${imageryName(imageryProvider)}. Locations are approximate; coverage is not exhaustive.`}</p>
  </section>
}
