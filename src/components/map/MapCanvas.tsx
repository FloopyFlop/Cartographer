import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { AreaTool, Bounds, Detection, Location, SearchArea, SearchLayer } from '@/types'
import { Button } from '@/components/ui/button'
import { CesiumWorkspace } from '@/map/CesiumWorkspace'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import './map.css'

export interface MapHandle {
  flyTo(location: Location): void
  zoomIn(): void
  zoomOut(): void
  resetNorth(): void
  setStylized(enabled: boolean): void
  setSceneMode(mode: '2D' | '3D'): void
  getViewport(): Bounds | null
  finishDrawing(): void
  cancelDrawing(): void
  focusDetection(detection: Detection): void
}

export interface MapCanvasProps {
  area: SearchArea
  layers: SearchLayer[]
  selectedId: string | null
  tool: AreaTool
  onAreaChange(area: SearchArea): void
  onSelect(detection: Detection | null): void
  onViewportChange?(bounds: Bounds): void
  onDrawingChange?(count: number): void
  onReady?(): void
  onError?(message: string): void
}

export const MapCanvas = forwardRef<MapHandle, MapCanvasProps>(function MapCanvas(props, ref) {
  const host = useRef<HTMLDivElement>(null)
  const workspace = useRef<CesiumWorkspace | null>(null)
  const latest = useRef(props)
  latest.current = props
  const [error, setError] = useState<string | null>(null)
  const [tilesUnavailable, setTilesUnavailable] = useState(false)
  const [tilesLoading, setTilesLoading] = useState(true)
  const [reload, setReload] = useState(0)

  useImperativeHandle(ref, () => ({
    flyTo: (location) => workspace.current?.flyTo(location),
    zoomIn: () => workspace.current?.zoomIn(),
    zoomOut: () => workspace.current?.zoomOut(),
    resetNorth: () => workspace.current?.resetNorth(),
    setStylized: (enabled) => workspace.current?.setStylized(enabled),
    setSceneMode: (mode) => workspace.current?.setSceneMode(mode),
    getViewport: () => workspace.current?.getViewport() ?? null,
    finishDrawing: () => workspace.current?.finishDrawing(),
    cancelDrawing: () => workspace.current?.cancelDrawing(),
    focusDetection: (detection) => workspace.current?.focusDetection(detection),
  }), [])

  useEffect(() => {
    if (!host.current) return
    let current: CesiumWorkspace | null = null
    let active = true
    let observer: ResizeObserver | null = null
    setError(null)
    setTilesUnavailable(false)
    setTilesLoading(true)
    try {
      current = new CesiumWorkspace(host.current, latest.current.area, {
        onAreaChange: (area) => latest.current.onAreaChange(area),
        onSelect: (detection) => latest.current.onSelect(detection),
        onViewportChange: (bounds) => latest.current.onViewportChange?.(bounds),
        onDrawingChange: (count) => latest.current.onDrawingChange?.(count),
        onError: (message) => {
          if (!active) return
          setError(message)
          latest.current.onError?.(message)
        },
        onTileError: (unavailable) => { if (active) setTilesUnavailable(unavailable) },
        onTileLoading: (loading) => { if (active) setTilesLoading(loading) },
      })
      workspace.current = current
      current.updateLayers(latest.current.layers)
      current.setSelectedId(latest.current.selectedId)
      current.setTool(latest.current.tool)
      observer = new ResizeObserver(() => current?.resize())
      observer.observe(host.current)
      latest.current.onReady?.()
    } catch (initializationError) {
      console.error('[Cartographer] Map initialization failed.', initializationError)
      const message = 'The map needs a browser with WebGL support. Enable hardware acceleration, then reload the map.'
      setError(message)
      latest.current.onError?.(message)
    }
    return () => {
      active = false
      observer?.disconnect()
      current?.destroy()
      if (workspace.current === current) workspace.current = null
      // Cesium initialization may fail before it returns a viewer; clearing its
      // owned container also makes a subsequent retry and StrictMode safe.
      host.current?.replaceChildren()
    }
  }, [reload])

  useEffect(() => { workspace.current?.updateArea(props.area) }, [props.area])
  useEffect(() => { workspace.current?.updateLayers(props.layers) }, [props.layers])
  useEffect(() => { workspace.current?.setSelectedId(props.selectedId) }, [props.selectedId])
  useEffect(() => { workspace.current?.setTool(props.tool) }, [props.tool])

  return (
    <div className="map-canvas" aria-label="Interactive map of the search area">
      <div ref={host} className="map-viewer" tabIndex={0} role="application" aria-label="Geographic map. Drag to move, scroll to zoom. Use the area tools to select a search area."
        onKeyDown={(event) => {
          if (event.key === 'Escape') workspace.current?.cancelDrawing()
          if (event.key === '+' || event.key === '=') { event.preventDefault(); workspace.current?.zoomIn() }
          if (event.key === '-') { event.preventDefault(); workspace.current?.zoomOut() }
        }} />
      {tilesUnavailable && !error && (
        <p className="map-network-notice" role="status">Map imagery is unavailable. You can still use the area tools and view results.</p>
      )}
      {tilesLoading && !tilesUnavailable && !error && <p className="map-tiles-loading" role="status">Loading map detail…</p>}
      {error && (
        <div className="map-error" role="alert">
          <div>
            <h2>The map could not load</h2>
            <p>{error}</p>
            <Button variant="outline" onClick={() => setReload((value) => value + 1)}>Reload map</Button>
          </div>
        </div>
      )}
    </div>
  )
})
