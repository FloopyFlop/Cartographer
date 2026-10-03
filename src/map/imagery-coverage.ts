import type { ImageryFrame, Position } from '@/types'

export interface AnalyzedCamera {
  key: string
  position: Position
  views: number
}

/** Multiple headings from one panorama represent one camera location on the map. */
export function analyzedCameras(frames: ImageryFrame[] = []): AnalyzedCamera[] {
  const cameras = new Map<string, AnalyzedCamera>()
  for (const frame of frames) {
    const { longitude, latitude } = frame.position
    if (frame.status !== 'analyzed' || !Number.isFinite(longitude) || !Number.isFinite(latitude)
      || longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) continue
    const key = `${longitude.toFixed(6)}:${latitude.toFixed(6)}`
    const camera = cameras.get(key)
    if (camera) camera.views += 1
    else cameras.set(key, { key, position: frame.position, views: 1 })
  }
  return [...cameras.values()]
}
