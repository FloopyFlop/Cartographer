import * as Cesium from 'cesium'
import type { AreaTool, Bounds, Detection, Location, Position, SearchArea, SearchLayer } from '@/types'
import { initializeViewer, destroyViewer } from '@/vendor/titanium/viewer'
import { setStylizationConfig } from '@/vendor/titanium/postprocess/stylize'
import type { ViewerHandle } from '@/vendor/titanium/types'
import { boundsCenter, boundsForArea, boundsFromCorners, circlePositions, expandBounds, normalizeLongitude } from './geometry'

interface WorkspaceCallbacks {
  onAreaChange: (area: SearchArea) => void
  onSelect: (detection: Detection | null) => void
  onViewportChange: (bounds: Bounds) => void
  onDrawingChange: (count: number) => void
  onError: (message: string) => void
  onTileError: (unavailable: boolean) => void
}

interface LayerState {
  source: Cesium.CustomDataSource
  detections: Map<string, Detection>
  removeClusterListener: () => void
}

interface ClusterSelection { kind: 'cluster'; positions: Cesium.Cartesian3[] }

const BLACK = Cesium.Color.fromCssColorString('#242424')
const WHITE = Cesium.Color.WHITE
const OUTLINE = Cesium.Color.fromCssColorString('#d1d1d1')
const FILL = Cesium.Color.fromCssColorString('#ffffff').withAlpha(0.055)
const HISTORY = Cesium.Color.fromCssColorString('#d1d1d1').withAlpha(0.24)
const CLUSTER_SYMBOLS = new Map<number, string>()
function markerSymbol(fill: string, stroke: string) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="${fill}" stroke="${stroke}" stroke-width="1.7"/></svg>`)}`
}
const MARKERS = { normal: markerSymbol('#fafafa', '#242424'), hovered: markerSymbol('#d4d4d4', '#242424'), selected: markerSymbol('#242424', '#fafafa') }

function markerBillboard() {
  return { image: MARKERS.normal, width: 16, height: 16, horizontalOrigin: Cesium.HorizontalOrigin.CENTER, verticalOrigin: Cesium.VerticalOrigin.CENTER, disableDepthTestDistance: Number.POSITIVE_INFINITY }
}

function clusterSymbol(count: number) {
  const cached = CLUSTER_SYMBOLS.get(count)
  if (cached) return cached
  const fontSize = count >= 1000 ? 9 : count >= 100 ? 10 : 11
  // A single billboard keeps the count and circle together. Separate Cesium
  // points can otherwise obscure label glyphs at the same depth in 2D scenes.
  const symbol = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 32 32"><circle cx="16" cy="16" r="14.5" fill="#fafafa" stroke="#242424" stroke-width="1.5"/><text x="16" y="16.5" text-anchor="middle" dominant-baseline="central" fill="#242424" font-family="Arial,sans-serif" font-size="${fontSize}">${count}</text></svg>`)}`
  CLUSTER_SYMBOLS.set(count, symbol)
  return symbol
}

function cartesian(position: Position) {
  return Cesium.Cartesian3.fromDegrees(position.longitude, position.latitude)
}

function rectangle(bounds: Bounds) {
  return Cesium.Rectangle.fromDegrees(bounds.west, bounds.south, bounds.east, bounds.north)
}

function isCluster(value: unknown): value is ClusterSelection {
  return !!value && typeof value === 'object' && 'kind' in value && value.kind === 'cluster' && 'positions' in value
}

/** Cesium owns geographic rendering and interaction; React owns product state. */
export class CesiumWorkspace {
  private handle: ViewerHandle
  private callbacks: WorkspaceCallbacks
  private container: HTMLElement
  private input: Cesium.ScreenSpaceEventHandler
  private areaSource = new Cesium.CustomDataSource('search-area')
  private draftSource = new Cesium.CustomDataSource('drawing')
  private historySource = new Cesium.CustomDataSource('search-history')
  private selectionSource = new Cesium.CustomDataSource('selected-result')
  private layerStates = new Map<string, LayerState>()
  private entityDetections = new Map<string, Detection>()
  private markerStates = new Map<string, 'selected' | 'hovered' | 'normal'>()
  private selectedId: string | null = null
  private hoveredId: string | null = null
  private tool: AreaTool = 'navigate'
  private area: SearchArea
  private drawing: Position[] = []
  private pointer: Position | null = null
  private destroyed = false
  private disposers: Array<() => void> = []
  private removeMorphListener: (() => void) | null = null
  private pendingRenderFrames = 0

  constructor(container: HTMLElement, area: SearchArea, callbacks: WorkspaceCallbacks) {
    this.container = container
    this.area = area
    this.callbacks = callbacks
    this.handle = initializeViewer(container)
    const viewer = this.handle.viewer
    viewer.scene.screenSpaceCameraController.minimumZoomDistance = 70
    viewer.scene.screenSpaceCameraController.maximumZoomDistance = 40_000_000
    viewer.scene.screenSpaceCameraController.enableTilt = false
    viewer.scene.screenSpaceCameraController.enableLook = false
    viewer.scene.screenSpaceCameraController.enableRotate = false
    this.setStylized(true)
    void viewer.dataSources.add(this.areaSource)
    void viewer.dataSources.add(this.draftSource)
    void viewer.dataSources.add(this.historySource)
    void viewer.dataSources.add(this.selectionSource)
    this.renderArea()
    viewer.camera.setView({ destination: rectangle(expandBounds(boundsForArea(area), 2.6)) })
    viewer.camera.percentageChanged = 0.1
    this.disposers.push(viewer.camera.moveEnd.addEventListener(() => this.publishViewport()))
    this.disposers.push(viewer.scene.postRender.addEventListener(() => {
      // Marker and cluster texture atlases finish over several frames. A short
      // render burst lets their images appear while keeping the idle map quiet.
      if (this.pendingRenderFrames > 0) {
        this.pendingRenderFrames -= 1
        viewer.scene.requestRender()
      }
    }))
    this.disposers.push(viewer.scene.renderError.addEventListener((_scene, error) => {
      console.error('[Cartographer] Map rendering failed.', error instanceof Error ? `${error.message}\n${error.stack}` : String(error))
      this.callbacks.onError('The map could not render. Reload the map to try again.')
    }))
    this.disposers.push(viewer.imageryLayers.layerAdded.addEventListener((layer) => this.watchImagery(layer)))
    for (let index = 0; index < viewer.imageryLayers.length; index += 1) this.watchImagery(viewer.imageryLayers.get(index))
    this.input = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas)
    this.input.setInputAction((event: { position: Cesium.Cartesian2 }) => this.click(event.position), Cesium.ScreenSpaceEventType.LEFT_CLICK)
    this.input.setInputAction((event: { endPosition: Cesium.Cartesian2 }) => this.move(event.endPosition), Cesium.ScreenSpaceEventType.MOUSE_MOVE)
    // Route completion is explicit in the UI. Cesium's default double-click zoom
    // would otherwise move the camera while someone is placing vertices.
    viewer.cesiumWidget.screenSpaceEventHandler.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK)
    this.publishViewport()
  }

  private watchImagery(layer: Cesium.ImageryLayer) {
    let failures = 0
    const removeError = layer.imageryProvider.errorEvent.addEventListener(() => {
      failures += 1
      // The Titanium adapter switches imagery providers first. A failed fallback is
      // non-fatal: geographic tools and results remain available on the globe.
      if (this.handle.viewer.imageryLayers.length && this.handle.viewer.imageryLayers.get(0) === layer && failures >= 3) {
        this.callbacks.onTileError(true)
      }
    })
    this.disposers.push(removeError)
    this.disposers.push(this.handle.viewer.scene.globe.tileLoadProgressEvent.addEventListener((remaining: number) => {
      if (remaining === 0 && failures === 0) this.callbacks.onTileError(false)
    }))
  }

  private publishViewport() {
    const bounds = this.getViewport()
    if (bounds) this.callbacks.onViewportChange(bounds)
  }

  getViewport(): Bounds | null {
    if (this.destroyed) return null
    const viewer = this.handle.viewer
    if (viewer.scene.mode === Cesium.SceneMode.MORPHING) return null
    if (viewer.scene.mode === Cesium.SceneMode.SCENE2D) {
      // computeViewRectangle assumes a globe culling volume and can return the
      // whole world or undefined in Cesium's projected 2D scene. Pick the actual
      // map corners instead, keeping a wrapped west/east interval intact.
      const width = viewer.scene.canvas.clientWidth
      const height = viewer.scene.canvas.clientHeight
      if (!width || !height) return null
      const corners = [[0, 0], [width, 0], [width, height], [0, height]].map(([x, y]) => {
        const point = viewer.camera.pickEllipsoid(new Cesium.Cartesian2(x, y), viewer.scene.globe.ellipsoid)
        return point ? Cesium.Cartographic.fromCartesian(point) : null
      })
      if (corners.some((corner) => !corner)) return null
      const first = corners[0]!
      const second = corners[1]!
      const frustum = viewer.camera.frustum
      const projectedWidth = frustum instanceof Cesium.OrthographicOffCenterFrustum ? (frustum.right ?? 0) - (frustum.left ?? 0) : frustum instanceof Cesium.OrthographicFrustum ? (frustum.width ?? 0) : 0
      const globalView = projectedWidth >= viewer.scene.globe.ellipsoid.maximumRadius * Math.PI * 2 - 1
      return {
        west: globalView ? -180 : normalizeLongitude(Cesium.Math.toDegrees(first.longitude)),
        east: globalView ? 180 : normalizeLongitude(Cesium.Math.toDegrees(second.longitude)),
        south: Math.max(-90, Math.min(...corners.map((corner) => Cesium.Math.toDegrees(corner!.latitude)))),
        north: Math.min(90, Math.max(...corners.map((corner) => Cesium.Math.toDegrees(corner!.latitude)))),
      }
    }
    const view = viewer.camera.computeViewRectangle(viewer.scene.globe.ellipsoid)
    if (!view) return null
    const west = Cesium.Math.toDegrees(view.west)
    const east = Cesium.Math.toDegrees(view.east)
    return {
      west: view.width >= Math.PI * 2 - 0.001 ? -180 : normalizeLongitude(west),
      east: view.width >= Math.PI * 2 - 0.001 ? 180 : normalizeLongitude(east),
      south: Math.max(-90, Cesium.Math.toDegrees(view.south)),
      north: Math.min(90, Cesium.Math.toDegrees(view.north)),
    }
  }

  flyTo(location: Location) {
    const area: SearchArea = { kind: 'radius', center: location.position, radiusMeters: 650 }
    this.handle.viewer.camera.flyTo({ destination: rectangle(location.bounds ? expandBounds(location.bounds, 1.2) : expandBounds(boundsForArea(area), 2.6)), duration: 0.7 })
  }

  zoomIn() {
    this.handle.viewer.camera.zoomIn(this.handle.viewer.camera.positionCartographic.height * 0.35)
    this.requestRender()
    this.publishViewport()
  }

  zoomOut() {
    this.handle.viewer.camera.zoomOut(this.handle.viewer.camera.positionCartographic.height * 0.5)
    this.requestRender()
    this.publishViewport()
  }

  resetNorth() {
    this.handle.viewer.camera.setView({ orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } })
    this.requestRender()
  }

  setStylized(enabled: boolean) {
    // These are the supplied Titanium stages and original GLSL shaders. Both
    // edge detection and cel quantization operate on the live Cesium scene.
    setStylizationConfig(this.handle, {
      enabled,
      edge: { enabled: true, threshold: 0.2 },
      toon: { enabled: true, intensity: 0.58 },
    })
  }

  setSceneMode(mode: '2D' | '3D') {
    const viewer = this.handle.viewer
    const target = mode === '2D' ? Cesium.SceneMode.SCENE2D : Cesium.SceneMode.SCENE3D
    if (viewer.scene.mode === target) return
    const bounds = this.getViewport()
    viewer.camera.cancelFlight()
    this.removeMorphListener?.()
    this.removeMorphListener = viewer.scene.morphComplete.addEventListener(() => {
      this.removeMorphListener?.()
      this.removeMorphListener = null
      const controls = viewer.scene.screenSpaceCameraController
      controls.enableRotate = mode === '3D'
      controls.enableTilt = mode === '3D'
      if (bounds) {
        let destination = bounds
        if (mode === '2D' && bounds.east - bounds.west < 360) {
          // The 3D globe is conformal at this scale; 2D uses a geographic
          // projection. Preserve the visible latitude span when returning so
          // repeated mode switches do not progressively zoom the map out.
          const center = boundsCenter(bounds)
          const halfWidth = Math.min(180, (bounds.north - bounds.south) * viewer.scene.canvas.clientWidth / Math.max(1, viewer.scene.canvas.clientHeight) / 2)
          destination = { ...bounds, west: normalizeLongitude(center.longitude - halfWidth), east: normalizeLongitude(center.longitude + halfWidth) }
        }
        viewer.camera.setView({ destination: rectangle(destination), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } })
      }
      this.requestRender()
      this.publishViewport()
    })
    if (mode === '3D') viewer.scene.morphTo3D(0.6)
    else viewer.scene.morphTo2D(0.6)
    this.requestRender()
  }

  focusDetection(detection: Detection) {
    const position = detection.position
    const viewport = this.getViewport()
    if (viewport) {
      const width = (viewport.east < viewport.west ? viewport.east + 360 : viewport.east) - viewport.west
      const height = viewport.north - viewport.south
      const relativeLongitude = ((position.longitude - viewport.west) % 360 + 360) % 360
      // Picking a visible result should leave the user's geographic context in
      // place. Off-screen results pan into view at the existing map scale.
      if (relativeLongitude > width * 0.12 && relativeLongitude < width * 0.88 && position.latitude > viewport.south + height * 0.12 && position.latitude < viewport.north - height * 0.12) return
      const latitude = Math.max(-89 + height / 2, Math.min(89 - height / 2, position.latitude))
      this.handle.viewer.camera.flyTo({ destination: rectangle({
        west: normalizeLongitude(position.longitude - width / 2),
        east: normalizeLongitude(position.longitude + width / 2),
        south: latitude - height / 2,
        north: latitude + height / 2,
      }), duration: 0.6 })
      return
    }
    this.handle.viewer.camera.flyTo({ destination: rectangle(expandBounds(boundsForArea({ kind: 'radius', center: position, radiusMeters: 650 }), 1.8)), duration: 0.6 })
  }

  updateArea(area: SearchArea) {
    this.area = area
    this.renderArea()
  }

  setTool(tool: AreaTool) {
    if (tool === this.tool) return
    this.cancelDrawing()
    this.tool = tool
    this.container.style.cursor = tool === 'navigate' ? 'grab' : 'crosshair'
    this.container.title = ''
  }

  finishDrawing() {
    if (this.tool !== 'route' || this.drawing.length < 2) return
    const coordinates = [...this.drawing]
    const corridorMeters = this.area.kind === 'route' ? this.area.corridorMeters : 100
    this.cancelDrawing()
    this.callbacks.onAreaChange({ kind: 'route', coordinates, corridorMeters, label: 'Drawn route' })
  }

  cancelDrawing() {
    this.drawing = []
    this.pointer = null
    this.draftSource.entities.removeAll()
    this.callbacks.onDrawingChange(0)
    this.requestRender()
  }

  private pickPosition(screen: Cesium.Cartesian2): Position | null {
    const world = this.handle.viewer.camera.pickEllipsoid(screen, this.handle.viewer.scene.globe.ellipsoid)
    if (!world) return null
    const geographic = Cesium.Cartographic.fromCartesian(world)
    return { longitude: normalizeLongitude(Cesium.Math.toDegrees(geographic.longitude)), latitude: Cesium.Math.toDegrees(geographic.latitude) }
  }

  private click(screen: Cesium.Cartesian2) {
    const viewer = this.handle.viewer
    if (this.tool === 'navigate') {
      const picked = viewer.scene.pick(screen)
      const id: unknown = picked?.id
      if (isCluster(id)) {
        void viewer.camera.flyToBoundingSphere(Cesium.BoundingSphere.fromPoints(id.positions), {
          duration: 0.6,
          offset: new Cesium.HeadingPitchRange(0, -Math.PI / 2, Math.max(180, Cesium.BoundingSphere.fromPoints(id.positions).radius * 4)),
        })
        return
      }
      const detection = id instanceof Cesium.Entity ? this.entityDetections.get(id.id) : undefined
      this.callbacks.onSelect(detection ?? null)
      return
    }
    const position = this.pickPosition(screen)
    if (!position) return
    if (this.tool === 'radius') {
      this.callbacks.onAreaChange({ kind: 'radius', center: position, radiusMeters: this.area.kind === 'radius' ? this.area.radiusMeters : 650, label: 'Selected location' })
    } else if (this.tool === 'region') {
      this.drawing.push(position)
      if (this.drawing.length === 2) {
        const bounds = boundsFromCorners(this.drawing[0], this.drawing[1])
        // Tiny accidental clicks do not replace a useful search area.
        if (Math.abs(bounds.north - bounds.south) < 0.00001 || Math.abs(bounds.east - bounds.west) < 0.00001) {
          this.drawing.pop()
          return
        }
        this.cancelDrawing()
        this.callbacks.onAreaChange({ kind: 'region', bounds, label: 'Selected region' })
      } else {
        this.callbacks.onDrawingChange(this.drawing.length)
        this.renderDraft()
      }
    } else {
      const last = this.drawing.at(-1)
      if (last && Math.abs(last.longitude - position.longitude) + Math.abs(last.latitude - position.latitude) < 0.000001) return
      this.drawing.push(position)
      this.callbacks.onDrawingChange(this.drawing.length)
      this.renderDraft()
    }
  }

  private move(screen: Cesium.Cartesian2) {
    if (this.tool !== 'navigate') {
      this.pointer = this.pickPosition(screen)
      if (this.drawing.length) this.renderDraft()
      return
    }
    const picked = this.handle.viewer.scene.pick(screen)
    const detection = picked?.id instanceof Cesium.Entity ? this.entityDetections.get(picked.id.id) : undefined
    const nextId = detection?.id ?? null
    if (nextId !== this.hoveredId) {
      this.hoveredId = nextId
      this.refreshMarkerAppearance()
    }
    this.container.style.cursor = detection || isCluster(picked?.id) ? 'pointer' : 'grab'
    this.container.title = detection?.title ?? (isCluster(picked?.id) ? 'Zoom in to see these results' : '')
  }

  private addArea(source: Cesium.CustomDataSource, area: SearchArea, history = false) {
    const outline = history ? HISTORY : OUTLINE
    const fill = history ? Cesium.Color.TRANSPARENT : FILL
    if (area.kind === 'radius') {
      source.entities.add({ position: cartesian(area.center), ellipse: { semiMajorAxis: area.radiusMeters, semiMinorAxis: area.radiusMeters, material: fill, height: 0.5 } })
      source.entities.add({ polyline: { positions: circlePositions(area.center, area.radiusMeters).map(cartesian), width: history ? 1 : 1.5, material: outline, clampToGround: true } })
    } else if (area.kind === 'route') {
      if (area.coordinates.length < 2) return
      source.entities.add({ corridor: { positions: area.coordinates.map(cartesian), width: area.corridorMeters * 2, material: fill, outline: true, outlineColor: outline, cornerType: Cesium.CornerType.ROUNDED, height: 0.5 } })
      if (!history) source.entities.add({ polyline: { positions: area.coordinates.map(cartesian), width: 2, material: OUTLINE.withAlpha(0.7), clampToGround: true } })
    } else {
      source.entities.add({ rectangle: { coordinates: rectangle(area.bounds), material: fill, outline: true, outlineColor: outline, height: 0.5 } })
    }
  }

  private renderArea() {
    this.areaSource.entities.removeAll()
    this.addArea(this.areaSource, this.area)
    this.requestRender()
  }

  private renderDraft() {
    this.draftSource.entities.removeAll()
    if (this.tool === 'region' && this.drawing.length && this.pointer) {
      this.addArea(this.draftSource, { kind: 'region', bounds: boundsFromCorners(this.drawing[0], this.pointer) })
    } else if (this.tool === 'route') {
      const vertices = this.pointer ? [...this.drawing, this.pointer] : this.drawing
      if (vertices.length > 1) this.addArea(this.draftSource, { kind: 'route', coordinates: vertices, corridorMeters: this.area.kind === 'route' ? this.area.corridorMeters : 100 })
    }
    for (const position of this.drawing) this.draftSource.entities.add({ position: cartesian(position), point: { pixelSize: 8, color: WHITE, outlineColor: BLACK, outlineWidth: 1.5, disableDepthTestDistance: Number.POSITIVE_INFINITY } })
    this.requestRender()
  }

  updateLayers(layers: SearchLayer[]) {
    const viewer = this.handle.viewer
    const activeIds = new Set(layers.map((layer) => layer.job.id))
    for (const [id, state] of this.layerStates) {
      if (activeIds.has(id)) continue
      state.removeClusterListener()
      for (const entity of state.source.entities.values) { this.entityDetections.delete(entity.id); this.markerStates.delete(entity.id) }
      viewer.dataSources.remove(state.source, true)
      this.layerStates.delete(id)
    }
    this.historySource.entities.removeAll()
    for (const layer of layers) {
      let state = this.layerStates.get(layer.job.id)
      if (!state) {
        const source = new Cesium.CustomDataSource(`results-${layer.job.id}`)
        source.clustering.enabled = true
        source.clustering.pixelRange = 38
        source.clustering.minimumClusterSize = 4
        source.clustering.clusterBillboards = true
        source.clustering.clusterPoints = false
        const removeClusterListener = source.clustering.clusterEvent.addEventListener((entities: Cesium.Entity[], cluster: { billboard: Cesium.Billboard; label: Cesium.Label; point: Cesium.PointPrimitive }) => {
          const positions = entities.map((entity) => entity.position?.getValue(viewer.clock.currentTime)).filter((position): position is Cesium.Cartesian3 => !!position)
          const selection: ClusterSelection = { kind: 'cluster', positions }
          cluster.billboard.show = true
          cluster.billboard.image = clusterSymbol(entities.length)
          cluster.billboard.width = 32
          cluster.billboard.height = 32
          cluster.billboard.horizontalOrigin = Cesium.HorizontalOrigin.CENTER
          cluster.billboard.verticalOrigin = Cesium.VerticalOrigin.CENTER
          cluster.billboard.disableDepthTestDistance = Number.POSITIVE_INFINITY
          cluster.billboard.id = selection
          cluster.point.show = false
          cluster.label.show = false
        })
        state = { source, detections: new Map(), removeClusterListener }
        this.layerStates.set(layer.job.id, state)
        void viewer.dataSources.add(source)
      }
      state.source.show = layer.visible
      const nextIds = new Set(layer.job.detections.map((detection) => `${layer.job.id}:${detection.id}`))
      for (const entity of [...state.source.entities.values]) {
        if (nextIds.has(entity.id)) continue
        state.source.entities.remove(entity)
        state.detections.delete(entity.id)
        this.entityDetections.delete(entity.id)
        this.markerStates.delete(entity.id)
      }
      state.source.entities.suspendEvents()
      for (const detection of layer.job.detections) {
        const entityId = `${layer.job.id}:${detection.id}`
        let entity = state.source.entities.getById(entityId)
        if (!entity) entity = state.source.entities.add({ id: entityId, position: cartesian(detection.position), billboard: markerBillboard() })
        else {
          const previous = state.detections.get(entityId)
          if (!previous || previous.position.latitude !== detection.position.latitude || previous.position.longitude !== detection.position.longitude) entity.position = new Cesium.ConstantPositionProperty(cartesian(detection.position))
        }
        state.detections.set(entityId, detection)
        this.entityDetections.set(entityId, detection)
      }
      state.source.entities.resumeEvents()
      // A few previous footprints convey context without filling the map with
      // every historical query. Only visible, completed searches are outlined.
      if (layer.visible && layer.job.status === 'completed' && layers.indexOf(layer) < 5 && JSON.stringify(layer.job.area) !== JSON.stringify(this.area)) this.addArea(this.historySource, layer.job.area, true)
    }
    this.refreshMarkerAppearance()
    this.requestRender()
  }

  setSelectedId(id: string | null) {
    this.selectedId = id
    this.refreshMarkerAppearance()
  }

  private refreshMarkerAppearance() {
    let selectedDetection: Detection | null = null
    let selectedEntityId: string | null = null
    for (const state of this.layerStates.values()) {
      for (const entity of state.source.entities.values) {
        const detection = state.detections.get(entity.id)
        if (!entity.billboard || !detection) continue
        const selected = detection.id === this.selectedId
        const hovered = detection.id === this.hoveredId
        const appearance = selected ? 'selected' : hovered ? 'hovered' : 'normal'
        if (this.markerStates.get(entity.id) !== appearance) {
          entity.billboard.width = new Cesium.ConstantProperty(selected ? 24 : hovered ? 20 : 16)
          entity.billboard.height = new Cesium.ConstantProperty(selected ? 24 : hovered ? 20 : 16)
          entity.billboard.image = new Cesium.ConstantProperty(MARKERS[appearance])
          this.markerStates.set(entity.id, appearance)
        }
        if (selected && state.source.show) {
          selectedDetection = detection
          selectedEntityId = `selection:${entity.id}`
        }
      }
    }
    for (const entity of [...this.selectionSource.entities.values]) {
      if (entity.id === selectedEntityId) continue
      this.entityDetections.delete(entity.id)
      this.selectionSource.entities.remove(entity)
    }
    if (selectedDetection && selectedEntityId) {
      const existing = this.selectionSource.entities.getById(selectedEntityId)
      if (existing) {
        const previous = this.entityDetections.get(selectedEntityId)
        if (previous?.position.latitude !== selectedDetection.position.latitude || previous?.position.longitude !== selectedDetection.position.longitude) existing.position = new Cesium.ConstantPositionProperty(cartesian(selectedDetection.position))
      } else {
        this.selectionSource.entities.add({ id: selectedEntityId, position: cartesian(selectedDetection.position), billboard: { ...markerBillboard(), image: MARKERS.selected, width: 24, height: 24 } })
      }
      this.entityDetections.set(selectedEntityId, selectedDetection)
    }
    this.requestRender()
  }

  resize() {
    if (this.destroyed) return
    this.handle.viewer.resize()
    this.requestRender()
    this.publishViewport()
  }

  private requestRender() {
    if (!this.destroyed) {
      this.pendingRenderFrames = Math.max(this.pendingRenderFrames, 4)
      this.handle.viewer.scene.requestRender()
    }
  }

  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.removeMorphListener?.()
    this.input.destroy()
    this.disposers.forEach((dispose) => dispose())
    this.layerStates.forEach((state) => state.removeClusterListener())
    this.layerStates.clear()
    this.entityDetections.clear()
    this.markerStates.clear()
    destroyViewer(this.handle)
  }
}
