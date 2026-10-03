import { useCallback, useEffect, useRef, useState } from 'react'
import { Map, Plus, Minus, Navigation2, X, Check, PanelLeft, Layers, ArrowRight, Loader2, SlidersHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet'
import { TooltipProvider } from '@/components/ui/tooltip'
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { IconButton } from '@/components/layout/IconButton'
import { AboutDialog } from '@/components/layout/AboutDialog'
import { BudgetDialog } from '@/components/layout/BudgetDialog'
import { LocationSearch } from '@/components/search/LocationSearch'
import { SearchPanel, type AreaMode } from '@/components/search/SearchPanel'
import { ResultLayers } from '@/components/results/ResultLayers'
import { DetectionDetails } from '@/components/results/DetectionDetails'
import { MapCanvas, type MapHandle } from '@/components/map/MapCanvas'
import { useSearches } from '@/hooks/useSearches'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { searchService } from '@/services/api'
import { INITIAL_AREA, INITIAL_LOCATION } from '@/types'
import type { AreaTool, Bounds, Detection, Location, SearchArea, SearchRequest } from '@/types'

export default function App() {
  const map = useRef<MapHandle>(null)
  const [location, setLocation] = useState<Location>(INITIAL_LOCATION)
  const [area, setArea] = useState<SearchArea>(INITIAL_AREA)
  const [areaMode, setAreaMode] = useState<AreaMode>('radius')
  const [tool, setTool] = useState<AreaTool>('navigate')
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<SearchRequest['mode']>('auto')
  const [ready, setReady] = useState(false)
  const [mapUnavailable, setMapUnavailable] = useState(false)
  const [liveAvailable, setLiveAvailable] = useState(false)
  const [imageryProvider, setImageryProvider] = useState('google')
  const [stylized, setStylized] = useState(true)
  const [sceneMode, setSceneMode] = useState<'2D' | '3D'>('2D')
  const isMobile = useMediaQuery('(max-width: 720px)')
  const [drawingCount, setDrawingCount] = useState(0)
  const [selected, setSelected] = useState<Detection | null>(null)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const searches = useSearches()
  const { layers, activeJobs } = searches
  useEffect(() => {
    const controller = new AbortController()
    void searchService.health(controller.signal).then(health => { setLiveAvailable(health.liveSearchAvailable); setImageryProvider(health.provider) }).catch(() => {})
    return () => controller.abort()
  }, [layers.length])
  const cancelDrawing = useCallback(() => { map.current?.cancelDrawing(); setTool('navigate'); setAreaMode(area.kind); setDrawingCount(0) }, [area.kind])
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { if (tool !== 'navigate') cancelDrawing(); else setSelected(null) }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); document.querySelector<HTMLButtonElement>('.location-trigger')?.click() }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [tool, cancelDrawing])
  const handleAreaChange = useCallback((next: SearchArea) => { setArea(next); setAreaMode(next.kind); setTool('navigate'); setDrawingCount(0); setLocalError(null); if (isMobile) setMobileOpen(true) }, [isMobile])
  const handleViewport = useCallback((bounds: Bounds) => {
    if (areaMode === 'viewport' && tool === 'navigate') setArea({ kind: 'viewport', bounds, label: 'Current map view' })
  }, [areaMode, tool])
  function changeAreaMode(next: AreaMode) {
    map.current?.cancelDrawing(); setDrawingCount(0); setLocalError(null); setAreaMode(next)
    if (next === 'viewport') {
      const bounds = map.current?.getViewport()
      if (bounds) { setArea({ kind: 'viewport', bounds, label: 'Current map view' }); setTool('navigate') }
      else { setLocalError('Zoom in to a local area before searching the map view.'); setAreaMode(area.kind); setTool('navigate') }
    } else if (next === 'radius') {
      const bounds = map.current?.getViewport()
      const width = bounds ? bounds.east >= bounds.west ? bounds.east - bounds.west : bounds.east + 360 - bounds.west : 0
      const centerLongitude = bounds ? ((bounds.west + width / 2 + 180) % 360 + 360) % 360 - 180 : location.position.longitude
      setArea(previous => previous.kind === 'radius' ? previous : { kind: 'radius', center: bounds ? { longitude: centerLongitude, latitude: (bounds.south + bounds.north) / 2 } : location.position, radiusMeters: 650, label: 'Map center' })
      setTool('navigate')
    } else { setTool(next); if (isMobile) setMobileOpen(false) }
  }
  function navigate(next: Location) {
    cancelDrawing(); setLocation(next); setArea({ kind: 'radius', center: next.position, radiusMeters: area.kind === 'radius' ? area.radiusMeters : 650, label: next.label }); setAreaMode('radius'); setSelected(null); map.current?.flyTo(next)
  }
  async function runSearch() {
    if (!query.trim() || tool !== 'navigate' || !ready) return
    const job = await searches.startSearch({ query: query.trim(), area, mode })
    if (job) { setMobileOpen(false); setSelected(null) }
  }
  function selectDetection(detection: Detection | null) { setSelected(detection); if (detection) { setMobileOpen(false); map.current?.focusDetection(detection) } }
  const panel = <><SearchPanel query={query} onQueryChange={setQuery} area={area} areaMode={areaMode} onAreaModeChange={changeAreaMode} onRadiusChange={radiusMeters => setArea(previous => previous.kind === 'radius' ? { ...previous, radiusMeters } : previous)} onCorridorChange={corridorMeters => setArea(previous => previous.kind === 'route' ? { ...previous, corridorMeters } : previous)} onChoosePoint={() => { map.current?.cancelDrawing(); setTool('radius'); setMobileOpen(false) }} tool={tool} ready={ready} isSubmitting={searches.isSubmitting} onSearch={() => void runSearch()} error={localError || searches.requestError} onClearError={() => { setLocalError(null); searches.clearError() }} mode={mode} onModeChange={setMode} liveAvailable={liveAvailable} imageryProvider={imageryProvider}/>
    {searches.pollError && <p className="poll-error" role="alert">{searches.pollError}</p>}
    <ResultLayers layers={layers} selectedId={selected?.id || null} onSelect={selectDetection} onToggle={id => { searches.toggleLayer(id); if (selected?.searchId === id) setSelected(null) }} onRemove={id => { searches.removeLayer(id); if (selected?.searchId === id) setSelected(null) }} onCancel={id => void searches.cancelSearch(id)}/></>
  const visibleCount = layers.filter(l => l.visible).reduce((sum, l) => sum + l.job.detections.length, 0)
  return <TooltipProvider delayDuration={350}><div className="app-shell">
    <header className="app-header"><a href="/" className="brand" aria-label="Cartographer home"><Map size={23} strokeWidth={1.5}/><span>Cartographer</span></a><div className="header-location"><LocationSearch location={location} onSelect={navigate}/></div><div className="header-end"><span className="workspace-label">Local workspace</span><BudgetDialog/><AboutDialog imageryProvider={imageryProvider}/></div></header>
    <main className="app-main"><aside className="desktop-sidebar"><div className="sidebar-scroll">{panel}</div><div className="sidebar-footer"><span>Search the physical world.</span><span>Cartographer</span></div></aside>
      <section className="map-workspace" aria-label="Interactive geographic map">
        <MapCanvas ref={map} area={area} layers={layers} selectedId={selected?.id || null} tool={tool} onAreaChange={handleAreaChange} onSelect={selectDetection} onViewportChange={handleViewport} onDrawingChange={setDrawingCount} onReady={() => { setReady(true); setMapUnavailable(false) }} onError={() => { setMapUnavailable(true); setReady(false) }}/>
        {!ready && !mapUnavailable && <div className="map-loading" role="status"><Loader2 size={20} className="animate-spin"/><p>Opening the map…</p></div>}
        {ready && <><div className="map-place"><h2>{location.label}</h2>{location.description && <p>{location.description}</p>}</div><div className="map-appearance"><DropdownMenu><DropdownMenuTrigger asChild><Button variant="outline" size="sm" aria-label="Titanium map appearance"><SlidersHorizontal size={14}/>Titanium</Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuLabel>Titanium rendering</DropdownMenuLabel><DropdownMenuCheckboxItem checked={stylized} onCheckedChange={enabled => { setStylized(enabled); map.current?.setStylized(enabled) }}>Cel shading</DropdownMenuCheckboxItem><DropdownMenuSeparator/><DropdownMenuRadioGroup value={sceneMode} onValueChange={value => { const next = value as '2D' | '3D'; setSceneMode(next); map.current?.setSceneMode(next) }}><DropdownMenuRadioItem value="2D">2D map</DropdownMenuRadioItem><DropdownMenuRadioItem value="3D">3D globe</DropdownMenuRadioItem></DropdownMenuRadioGroup></DropdownMenuContent></DropdownMenu></div><div className="map-controls"><IconButton label="Zoom in" onClick={() => map.current?.zoomIn()}><Plus size={19}/></IconButton><IconButton label="Zoom out" onClick={() => map.current?.zoomOut()}><Minus size={19}/></IconButton><div className="control-divider"/><IconButton label="Reset north" onClick={() => map.current?.resetNorth()}><Navigation2 size={17}/></IconButton></div></>}
        {tool !== 'navigate' && <div className="drawing-bar" role="status"><span>{tool === 'radius' ? 'Click the map to set the center' : tool === 'region' ? drawingCount ? 'Choose the opposite corner' : 'Choose the first corner' : drawingCount < 2 ? 'Click to add at least two route points' : `${drawingCount} points · Add more or finish your route`}</span><Button variant="ghost" size="sm" onClick={cancelDrawing}><X size={14}/>Cancel</Button>{tool === 'route' && <Button size="sm" disabled={drawingCount < 2} onClick={() => map.current?.finishDrawing()}><Check size={14}/>Done</Button>}</div>}
        {!layers.length && ready && tool === 'navigate' && <div className="map-empty-hint">A place to look. Something to find.</div>}
        {!!layers.length && ready && <div className="map-result-count" aria-live="polite"><span className="marker-legend"/>{visibleCount} {visibleCount === 1 ? 'result' : 'results'} on the map</div>}
        {selected && <div className="desktop-details"><DetectionDetails detection={selected} onClose={() => setSelected(null)} onFocus={() => map.current?.focusDetection(selected)}/></div>}
        <div className="mobile-map-action"><Button onClick={() => setMobileOpen(true)}>{activeJobs.length ? <Loader2 size={16} className="animate-spin"/> : layers.length ? <Layers size={16}/> : <PanelLeft size={16}/>}<span>{activeJobs.length ? 'Search in progress' : layers.length ? 'Search & layers' : 'Find something'}</span><ArrowRight size={15}/></Button></div>
      </section>
    </main>
    <Sheet open={mobileOpen && isMobile} onOpenChange={setMobileOpen}><SheetContent side="bottom" className="mobile-search-sheet"><SheetHeader><SheetTitle>Cartographer</SheetTitle><SheetDescription>Describe something. Choose where to look.</SheetDescription></SheetHeader><div className="sidebar-scroll">{panel}</div></SheetContent></Sheet>
    <Sheet open={!!selected && isMobile} onOpenChange={open => { if (!open) setSelected(null) }}><SheetContent side="bottom" className="mobile-detail-sheet"><SheetHeader className="sr-only"><SheetTitle>Detection details</SheetTitle><SheetDescription>Inspect the selected map result.</SheetDescription></SheetHeader>{selected && <DetectionDetails compact detection={selected} onClose={() => setSelected(null)} onFocus={() => { map.current?.focusDetection(selected); setSelected(null) }}/>}</SheetContent></Sheet>
  </div></TooltipProvider>
}
