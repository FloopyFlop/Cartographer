// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { maps, drawImage } = vi.hoisted(() => ({ maps: [] as Array<{
  emit: (event: string, value?: unknown) => void
  jumpTo: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
}>, drawImage: vi.fn() }))
vi.mock('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url', () => ({ default: '/worker.js' }))
vi.mock('maplibre-gl', () => ({
  setWorkerUrl: vi.fn(), setWorkerCount: vi.fn(),
  Map: class {
    listeners = new Map<string, Set<(value?: unknown) => void>>()
    jumpTo = vi.fn()
    remove = vi.fn()
    constructor() { maps.push(this) }
    setStyle() {}
    triggerRepaint() {}
    getCanvas() { return document.createElement('canvas') }
    on(event: string, listener: (value?: unknown) => void) {
      if (!this.listeners.has(event)) this.listeners.set(event, new Set())
      this.listeners.get(event)!.add(listener)
    }
    off(event: string, listener: (value?: unknown) => void) { this.listeners.get(event)?.delete(listener) }
    emit(event: string, value?: unknown) { for (const listener of [...this.listeners.get(event) || []]) listener(value) }
  },
}))

import { OpenFreeMapImageryProvider } from './OpenFreeMapImageryProvider'

let provider: OpenFreeMapImageryProvider
beforeEach(() => {
  maps.length = 0
  drawImage.mockClear()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D)
  provider = new OpenFreeMapImageryProvider()
})
afterEach(() => { provider.destroy(); vi.restoreAllMocks() })

describe('vector imagery lifecycle', () => {
  it('uses the Mercator tile center and crops high resolution imagery after tiles are ready', async () => {
    const result = provider.requestImage(1, 1, 2)!
    const view = maps[0].jumpTo.mock.calls[0][0]
    expect(view.zoom).toBe(2)
    expect(view.center[0]).toBe(-45)
    expect(view.center[1]).toBeCloseTo(40.97989806962013, 10)
    expect(drawImage).not.toHaveBeenCalled()
    maps[0].emit('idle')
    const image = await result
    expect([image.width, image.height]).toEqual([1024, 1024])
    expect(drawImage).toHaveBeenCalledWith(expect.any(HTMLCanvasElement), 256, 256, 1024, 1024, 0, 0, 1024, 1024)
  })

  it('shares identical in-flight work and reuses a completed tile', async () => {
    const first = provider.requestImage(0, 0, 0)!
    expect(provider.requestImage(0, 0, 0)).toBe(first)
    maps[0].emit('idle')
    const image = await first
    expect(await provider.requestImage(0, 0, 0)).toBe(image)
    expect(maps).toHaveLength(1)
    expect(maps[0].jumpTo).toHaveBeenCalledTimes(1)
  })

  it('bounds parallel contexts and queues, asking Cesium to retry excess requests', async () => {
    const results = Array.from({ length: 8 }, (_, x) => provider.requestImage(x, 0, 4)!)
    expect(maps).toHaveLength(2)
    expect(provider.requestImage(8, 0, 4)).toBeUndefined()
    const completed = Promise.allSettled(results)
    provider.destroy()
    expect((await completed).every(result => result.status === 'rejected')).toBe(true)
    expect(maps.every(map => map.remove.mock.calls.length === 1)).toBe(true)
    expect(document.querySelector('[aria-hidden="true"]')).toBeNull()
  })

  it('signals provider failure for a fallback and rejects pending work', async () => {
    const results = [provider.requestImage(0, 0, 3)!, provider.requestImage(1, 0, 3)!, provider.requestImage(2, 0, 3)!]
    const completed = Promise.allSettled(results)
    const failed = vi.fn(() => provider.destroy())
    provider.errorEvent.addEventListener(failed)
    maps[0].emit('error', { error: { message: 'Map source unavailable' } })
    expect((await completed).every(result => result.status === 'rejected')).toBe(true)
    expect(failed).toHaveBeenCalledOnce()
    expect(provider.requestImage(0, 0, 3)).toBeUndefined()
  })
})
