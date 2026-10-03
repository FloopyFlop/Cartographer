import { describe, expect, it } from 'vitest'
import type { ImageryFrame } from '@/types'
import { analyzedCameras } from './imagery-coverage'

const frame = (heading: number, longitude = -76.48039): ImageryFrame => ({
  id: `camera-${longitude}-${heading}`, heading, position: { longitude, latitude: 42.44477 },
  source: { provider: 'google', attribution: 'Google' }, detectionsCount: 0, status: 'analyzed',
})

describe('actual analyzed imagery coverage', () => {
  it('shows one camera for multiple viewing directions even when no objects were found', () => {
    const cameras = analyzedCameras([frame(0), frame(90), frame(180), frame(270)])
    expect(cameras).toHaveLength(1)
    expect(cameras[0].views).toBe(4)
    expect(cameras[0].position).toEqual(frame(0).position)
  })

  it('retains separate cameras and tolerates sub-centimeter metadata differences', () => {
    const cameras = analyzedCameras([frame(0), frame(90, -76.480390001), frame(180, -76.481)])
    expect(cameras).toHaveLength(2)
    expect(cameras.map(camera => camera.views)).toEqual([2, 1])
  })

  it('does not create coverage from absent imagery or malformed positions', () => {
    expect(analyzedCameras()).toEqual([])
    expect(analyzedCameras([frame(0, Number.NaN), frame(0, 181)])).toEqual([])
  })
})
