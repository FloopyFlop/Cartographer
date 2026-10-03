import type { Bounds, Position, SearchArea } from '@/types'

const EARTH_RADIUS_METERS = 6_371_008.8
const radians = (degrees: number) => degrees * Math.PI / 180
const degrees = (angle: number) => angle * 180 / Math.PI
const longitude = (value: number) => ((value + 180) % 360 + 360) % 360 - 180

export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters) || meters < 0) return '—'
  if (meters < 1000) return `${Math.round(meters).toLocaleString('en-US')} m`
  return `${Number((meters / 1000).toFixed(2)).toLocaleString('en-US')} km`
}

export function areaDescription(area: SearchArea): string {
  switch (area.kind) {
    case 'radius': return `${formatDistance(area.radiusMeters)} around ${area.label || 'the selected point'}`
    case 'route': return `${formatDistance(area.corridorMeters)} either side of ${area.label || 'your route'}`
    case 'region': return area.label || 'Selected region'
    case 'viewport': return area.label || 'Current map view'
  }
}

export function haversine(a: Position, b: Position): number {
  const latDifference = radians(b.latitude - a.latitude)
  const lngDifference = radians(b.longitude - a.longitude)
  const arc = Math.sin(latDifference / 2) ** 2
    + Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(lngDifference / 2) ** 2
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(Math.min(1, Math.max(0, arc))))
}

function bufferedBounds(bounds: Bounds, meters: number): Bounds {
  const latitudeMargin = degrees(meters / EARTH_RADIUS_METERS)
  const south = Math.max(-90, bounds.south - latitudeMargin)
  const north = Math.min(90, bounds.north + latitudeMargin)
  if (south === -90 || north === 90) return { west: -180, east: 180, south, north }
  const longitudeMargin = degrees(Math.asin(Math.min(1,
    Math.sin(meters / EARTH_RADIUS_METERS) / Math.cos(radians(Math.max(Math.abs(bounds.south), Math.abs(bounds.north)))))))
  const width = bounds.east >= bounds.west ? bounds.east - bounds.west : 360 - bounds.west + bounds.east
  if (width + 2 * longitudeMargin >= 360) return { west: -180, east: 180, south, north }
  return { west: longitude(bounds.west - longitudeMargin), east: longitude(bounds.east + longitudeMargin), south, north }
}

export function areaBounds(area: SearchArea): Bounds {
  if (area.kind === 'radius') {
    return bufferedBounds({ west: area.center.longitude, east: area.center.longitude,
      south: area.center.latitude, north: area.center.latitude }, area.radiusMeters)
  }
  if (area.kind !== 'route') return { ...area.bounds }
  if (area.coordinates.length < 2) throw new RangeError('A route requires at least two positions.')
  const longitudes = area.coordinates.map(point => ((point.longitude % 360) + 360) % 360).sort((a, b) => a - b)
  let largestGap = -1
  let gapIndex = 0
  for (let index = 0; index < longitudes.length; index++) {
    const next = index === longitudes.length - 1 ? longitudes[0] + 360 : longitudes[index + 1]
    if (next - longitudes[index] > largestGap) {
      largestGap = next - longitudes[index]
      gapIndex = index
    }
  }
  const west = longitude(longitudes[(gapIndex + 1) % longitudes.length])
  const east = longitude(longitudes[gapIndex])
  return bufferedBounds({ west, east, south: Math.min(...area.coordinates.map(point => point.latitude)),
    north: Math.max(...area.coordinates.map(point => point.latitude)) }, area.corridorMeters)
}

export function validViewport(bounds: Bounds): boolean {
  return Object.values(bounds).every(Number.isFinite)
    && bounds.west >= -180 && bounds.west <= 180 && bounds.east >= -180 && bounds.east <= 180
    && bounds.south >= -90 && bounds.north <= 90 && bounds.south < bounds.north
    && bounds.west !== bounds.east
}
