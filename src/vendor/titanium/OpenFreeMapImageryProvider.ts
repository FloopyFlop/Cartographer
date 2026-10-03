import * as Cesium from 'cesium'
import { Map as VectorMap, setWorkerCount, setWorkerUrl } from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import 'maplibre-gl/dist/maplibre-gl.css'

const TILE_SIZE = 512
const PADDING = 128
const PIXEL_RATIO = 2
const CACHE_TILES = 8 // 32 MiB of canvas pixels; Cesium manages its own textures.
const MAX_PENDING = 8
const STYLE_URL = 'https://tiles.openfreemap.org/styles/dark'

setWorkerUrl(workerUrl)
setWorkerCount(2)

interface TileTask {
  key: string
  x: number
  y: number
  level: number
  resolve: (canvas: HTMLCanvasElement) => void
  reject: (error: Error) => void
}
interface Renderer { map: VectorMap; container: HTMLDivElement; busy: boolean }

/** Render current vector geometry into Cesium textures, rather than stretching
 * a fixed-resolution raster. Two reusable contexts bound GPU/worker overhead.
 * Cesium remains responsible for the globe, tools and Titanium postprocessing.
 */
export class OpenFreeMapImageryProvider implements Cesium.ImageryProvider {
  readonly tilingScheme = new Cesium.WebMercatorTilingScheme()
  readonly rectangle = this.tilingScheme.rectangle
  readonly tileWidth = TILE_SIZE * PIXEL_RATIO
  readonly tileHeight = TILE_SIZE * PIXEL_RATIO
  readonly maximumLevel = 22
  readonly minimumLevel = 0
  readonly tileDiscardPolicy: Cesium.TileDiscardPolicy = undefined!
  readonly proxy: Cesium.Proxy = undefined!
  readonly hasAlphaChannel = false
  readonly errorEvent = new Cesium.Event()
  readonly credit = new Cesium.Credit(
    '<a href="https://openfreemap.org/" target="_blank" rel="noopener noreferrer">OpenFreeMap</a> · © <a href="https://openmaptiles.org/" target="_blank" rel="noopener noreferrer">OpenMapTiles</a> · © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>', true,
  )
  private renderers: Renderer[] = []
  private queue: TileTask[] = []
  private pending = new Map<string, Promise<HTMLCanvasElement>>()
  private cache = new Map<string, HTMLCanvasElement>()
  private cancelWaiters = new Set<() => void>()
  private destroyed = false
  private failed = false

  getTileCredits() { return [] }
  pickFeatures() { return undefined }
  isDestroyed() { return this.destroyed }

  requestImage(x: number, y: number, level: number): Promise<HTMLCanvasElement> | undefined {
    if (this.destroyed || this.failed) return undefined
    const key = `${level}/${x}/${y}`
    const cached = this.cache.get(key)
    if (cached) {
      this.cache.delete(key)
      this.cache.set(key, cached)
      return Promise.resolve(cached)
    }
    const existing = this.pending.get(key)
    if (existing) return existing
    if (this.pending.size >= MAX_PENDING) return undefined
    const result = new Promise<HTMLCanvasElement>((resolve, reject) => {
      this.queue.push({ key, x, y, level, resolve, reject })
    })
    this.pending.set(key, result)
    this.drain()
    return result
  }

  private createRenderer(): Renderer {
    const container = document.createElement('div')
    container.setAttribute('aria-hidden', 'true')
    container.style.cssText = `position:fixed;left:-20000px;top:0;width:${TILE_SIZE + PADDING * 2}px;height:${TILE_SIZE + PADDING * 2}px;pointer-events:none;`
    document.body.append(container)
    try {
      const map = new VectorMap({
        container, interactive: false, attributionControl: false,
        center: [0, 0], zoom: 0, maxZoom: 24,
        pixelRatio: PIXEL_RATIO, fadeDuration: 0, trackResize: false,
        renderWorldCopies: true, canvasContextAttributes: { preserveDrawingBuffer: true, antialias: true },
      })
      map.setStyle(STYLE_URL, { transformStyle: (_previous, next) => ({
        ...next,
        // The public dark style refers to two absent sprite assets. Plain
        // neutral fills and text retain useful map detail without decorations.
        layers: next.layers.map(layer => {
          if (layer.type === 'fill' && layer.paint?.['fill-pattern']) {
            const paint = { ...layer.paint }
            delete paint['fill-pattern']
            return { ...layer, paint }
          }
          if (layer.type === 'symbol' && JSON.stringify(layer.layout?.['icon-image'] ?? '').includes('circle-11')) {
            const layout = { ...layer.layout }
            delete layout['icon-image']
            return { ...layer, layout }
          }
          return layer
        }),
      }) })
      const renderer = { map, container, busy: false }
      this.renderers.push(renderer)
      return renderer
    } catch (error) {
      container.remove()
      throw error
    }
  }

  private waitForIdle(map: VectorMap, update: () => void): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false
      const cleanup = () => {
        clearTimeout(timeout)
        map.off('idle', complete)
        map.off('error', fail)
        this.cancelWaiters.delete(cancel)
      }
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        cleanup()
        if (error) reject(error)
        else resolve()
      }
      const complete = () => finish()
      const fail = (event: { error: { message: string } }) => finish(new Error(event.error.message))
      const cancel = () => finish(new Error('Map renderer was closed.'))
      const timeout = setTimeout(() => finish(new Error('Vector map tiles did not load in time.')), 25_000)
      this.cancelWaiters.add(cancel)
      map.on('idle', complete)
      map.on('error', fail)
      try { update(); map.triggerRepaint() } catch (error) { finish(error instanceof Error ? error : new Error(String(error))) }
    })
  }

  private drain() {
    if (this.destroyed || this.failed) return
    while (this.queue.length) {
      let renderer = this.renderers.find(slot => !slot.busy)
      if (!renderer && this.renderers.length < 2) {
        try { renderer = this.createRenderer() } catch (error) { this.fail(error); return }
      }
      if (!renderer) return
      const task = this.queue.shift()!
      renderer.busy = true
      void this.renderTile(renderer, task)
    }
  }

  private async renderTile(renderer: Renderer, task: TileTask) {
    try {
      const scale = 2 ** task.level
      const longitude = (task.x + 0.5) / scale * 360 - 180
      // A tile center in Mercator space is not the mean of its latitudes.
      const latitude = Math.atan(Math.sinh(Math.PI * (1 - 2 * (task.y + 0.5) / scale))) * 180 / Math.PI
      await this.waitForIdle(renderer.map, () => renderer.map.jumpTo({ center: [longitude, latitude], zoom: task.level, bearing: 0, pitch: 0 }))
      if (this.destroyed) throw new Error('Map renderer was closed.')
      const canvas = document.createElement('canvas')
      canvas.width = this.tileWidth
      canvas.height = this.tileHeight
      const context = canvas.getContext('2d', { alpha: false })
      if (!context) throw new Error('Could not render vector map imagery.')
      // Padding gives labels room around tile boundaries before the final crop.
      const padding = PADDING * PIXEL_RATIO
      context.drawImage(renderer.map.getCanvas(), padding, padding, this.tileWidth, this.tileHeight, 0, 0, this.tileWidth, this.tileHeight)
      this.cache.set(task.key, canvas)
      while (this.cache.size > CACHE_TILES) this.cache.delete(this.cache.keys().next().value!)
      task.resolve(canvas)
    } catch (error) {
      task.reject(error instanceof Error ? error : new Error(String(error)))
      if (!this.destroyed) this.fail(error)
    } finally {
      this.pending.delete(task.key)
      renderer.busy = false
      this.drain()
    }
  }

  private fail(reason: unknown) {
    if (this.failed || this.destroyed) return
    this.failed = true
    const error = reason instanceof Error ? reason : new Error(String(reason))
    for (const task of this.queue.splice(0)) task.reject(error)
    this.pending.clear()
    this.errorEvent.raiseEvent({ provider: this, message: error.message, error, retry: false })
  }

  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    for (const cancel of this.cancelWaiters) cancel()
    for (const task of this.queue.splice(0)) task.reject(new Error('Map renderer was closed.'))
    for (const renderer of this.renderers) { renderer.map.remove(); renderer.container.remove() }
    this.renderers = []
    this.pending.clear()
    this.cache.clear()
  }
}
