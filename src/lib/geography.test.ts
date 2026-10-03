import { describe, expect, it } from 'vitest'
import { areaBounds, areaDescription, formatDistance, haversine, validViewport } from './geography'
import type { SearchArea } from '@/types'

describe('geographic search semantics', () => {
  it('describes the area in terms a person uses to choose a search', () => {
    expect(areaDescription({ kind: 'radius', center: { longitude: -76.48, latitude: 42.45 }, radiusMeters: 650,
      label: 'Cornell University' })).toBe('650 m around Cornell University')
    expect(areaDescription({ kind: 'route', coordinates: [], corridorMeters: 100 })).toBe('100 m either side of your route')
    expect(areaDescription({ kind: 'region', bounds: { west: 1, south: 1, east: 2, north: 2 } })).toBe('Selected region')
    expect(areaDescription({ kind: 'viewport', bounds: { west: 1, south: 1, east: 2, north: 2 } })).toBe('Current map view')
  })

  it('uses meters for nearby distances and readable kilometers for longer distances', () => {
    expect(formatDistance(650)).toBe('650 m')
    expect(formatDistance(1000)).toBe('1 km')
    expect(formatDistance(1500)).toBe('1.5 km')
    expect(formatDistance(Number.NaN)).toBe('—')
  })

  it('measures the shortest great circle distance across the antimeridian', () => {
    expect(haversine({ longitude: 179, latitude: 0 }, { longitude: -179, latitude: 0 })).toBeCloseTo(222_390.16, 0)
    expect(haversine({ longitude: -76.48, latitude: 42.45 }, { longitude: -76.48, latitude: 42.45 })).toBe(0)
  })

  it('returns radius bounds enclosing the search at its physical size', () => {
    const area: SearchArea = { kind: 'radius', center: { longitude: -76.48, latitude: 42.45 }, radiusMeters: 650 }
    const bounds = areaBounds(area)
    expect(validViewport(bounds)).toBe(true)
    expect(haversine(area.center, { longitude: area.center.longitude, latitude: bounds.north })).toBeCloseTo(650, 4)
    expect(bounds.west).toBeLessThan(area.center.longitude)
    expect(bounds.east).toBeGreaterThan(area.center.longitude)
  })

  it('preserves viewport bounds without sharing the mutable input', () => {
    const bounds = { west: -77, south: 42, east: -76, north: 43 }
    const result = areaBounds({ kind: 'viewport', bounds })
    expect(result).toEqual(bounds)
    expect(result).not.toBe(bounds)
  })

  it('expands a route by the distance on each side, including its endpoints', () => {
    const route: SearchArea = { kind: 'route', coordinates: [{ longitude: 0, latitude: 0 }, { longitude: 0.01, latitude: 0 }], corridorMeters: 100 }
    const bounds = areaBounds(route)
    expect(haversine({ longitude: 0, latitude: 0 }, { longitude: 0, latitude: bounds.south })).toBeCloseTo(100, 4)
    expect(bounds.west).toBeLessThan(0)
    expect(bounds.east).toBeGreaterThan(0.01)
  })

  it('keeps a route crossing the antimeridian in its small geographic extent', () => {
    const bounds = areaBounds({ kind: 'route', coordinates: [{ longitude: 179.9, latitude: 0 }, { longitude: -179.9, latitude: 0 }], corridorMeters: 100 })
    expect(bounds.west).toBeGreaterThan(179)
    expect(bounds.east).toBeLessThan(-179)
    expect(validViewport(bounds)).toBe(true)
  })

  it('uses all longitudes when a radius contains a pole', () => {
    const bounds = areaBounds({ kind: 'radius', center: { longitude: 20, latitude: 89.999 }, radiusMeters: 650 })
    expect(bounds.north).toBe(90)
    expect(bounds.west).toBe(-180)
    expect(bounds.east).toBe(180)
  })

  it('rejects unavailable, empty, or invalid geographic views', () => {
    expect(validViewport({ west: Number.NaN, south: 0, east: 1, north: 1 })).toBe(false)
    expect(validViewport({ west: 1, south: 0, east: 1, north: 1 })).toBe(false)
    expect(validViewport({ west: 0, south: 90, east: 1, north: 91 })).toBe(false)
    expect(validViewport({ west: 0, south: 2, east: 1, north: 1 })).toBe(false)
    expect(() => areaBounds({ kind: 'route', coordinates: [], corridorMeters: 100 })).toThrow(RangeError)
  })
})
