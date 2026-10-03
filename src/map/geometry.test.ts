import { describe, expect, it } from 'vitest'
import { boundsCenter, boundsForArea, boundsFromCorners, circlePositions, expandBounds } from './geometry'

describe('geographic bounds', () => {
  it('keeps a selected dateline-crossing region narrow', () => {
    const bounds = boundsFromCorners({ longitude: 179.5, latitude: 10 }, { longitude: -179.5, latitude: 11 })
    expect(bounds).toEqual({ west: 179.5, east: -179.5, south: 10, north: 11 })
    expect(Math.abs(boundsCenter(bounds).longitude)).toBe(180)
    expect(expandBounds(bounds).west).toBeCloseTo(179.4)
    expect(expandBounds(bounds).east).toBeCloseTo(-179.4)
  })

  it('finds the short bounds for a route crossing the dateline', () => {
    const bounds = boundsForArea({ kind: 'route', coordinates: [{ longitude: 179.9, latitude: 42 }, { longitude: -179.9, latitude: 42 }], corridorMeters: 75 })
    expect(bounds.west).toBeGreaterThan(179)
    expect(bounds.east).toBeLessThan(-179)
    expect(bounds.south).toBeLessThan(42)
    expect(bounds.north).toBeGreaterThan(42)
  })

  it('draws a closed geographic radius with a plausible physical extent', () => {
    const center = { longitude: -76.4831, latitude: 42.4474 }
    const positions = circlePositions(center, 650)
    expect(positions).toHaveLength(97)
    expect(positions[0].latitude).toBeCloseTo(positions[96].latitude, 8)
    expect(positions[0].longitude).toBeCloseTo(positions[96].longitude, 8)
    const bounds = boundsForArea({ kind: 'radius', center, radiusMeters: 650 })
    expect(bounds.north - bounds.south).toBeCloseTo(0.01169, 4)
    expect(bounds.east - bounds.west).toBeCloseTo(0.01583, 4)
  })
})
