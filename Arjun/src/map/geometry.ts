import type { Bounds, Position, SearchArea } from '@/types'

const EARTH_RADIUS = 6_371_008.8
const DEGREES = 180 / Math.PI

export function normalizeLongitude(longitude: number) {
  return ((longitude + 180) % 360 + 360) % 360 - 180
}

/** West > east deliberately represents a rectangle crossing the antimeridian. */
export function boundsFromCorners(first: Position, second: Position): Bounds {
  const a = normalizeLongitude(first.longitude)
  const b = normalizeLongitude(second.longitude)
  const crossesDateline = Math.abs(a - b) > 180
  return {
    west: crossesDateline ? Math.max(a, b) : Math.min(a, b),
    east: crossesDateline ? Math.min(a, b) : Math.max(a, b),
    south: Math.min(first.latitude, second.latitude),
    north: Math.max(first.latitude, second.latitude),
  }
}

export function circlePositions(center: Position, radiusMeters: number, count = 96): Position[] {
  const latitude = center.latitude / DEGREES
  const longitude = center.longitude / DEGREES
  const distance = radiusMeters / EARTH_RADIUS
  return Array.from({ length: count + 1 }, (_, index) => {
    const bearing = (index / count) * Math.PI * 2
    const lat = Math.asin(Math.sin(latitude) * Math.cos(distance) + Math.cos(latitude) * Math.sin(distance) * Math.cos(bearing))
    const lon = longitude + Math.atan2(Math.sin(bearing) * Math.sin(distance) * Math.cos(latitude), Math.cos(distance) - Math.sin(latitude) * Math.sin(lat))
    return { longitude: normalizeLongitude(lon * DEGREES), latitude: lat * DEGREES }
  })
}

function boundsForPositions(positions: Position[], paddingMeters = 0): Bounds {
  const longitudes = positions.map((position) => normalizeLongitude(position.longitude)).sort((a, b) => a - b)
  let largestGap = -1
  let gapIndex = 0
  for (let index = 0; index < longitudes.length; index += 1) {
    const next = index === longitudes.length - 1 ? longitudes[0] + 360 : longitudes[index + 1]
    const gap = next - longitudes[index]
    if (gap > largestGap) { largestGap = gap; gapIndex = index }
  }
  const south = Math.min(...positions.map((position) => position.latitude))
  const north = Math.max(...positions.map((position) => position.latitude))
  const latitudePadding = paddingMeters / EARTH_RADIUS * DEGREES
  const longitudePadding = latitudePadding / Math.max(0.05, Math.cos(Math.max(Math.abs(south), Math.abs(north)) / DEGREES))
  const span = 360 - largestGap
  const west = longitudes[(gapIndex + 1) % longitudes.length]
  const east = longitudes[gapIndex]
  return {
    west: span + longitudePadding * 2 >= 360 ? -180 : normalizeLongitude(west - longitudePadding),
    east: span + longitudePadding * 2 >= 360 ? 180 : normalizeLongitude(east + longitudePadding),
    south: Math.max(-90, south - latitudePadding),
    north: Math.min(90, north + latitudePadding),
  }
}

export function boundsForArea(area: SearchArea): Bounds {
  if (area.kind === 'radius') return boundsForPositions(circlePositions(area.center, area.radiusMeters))
  if (area.kind === 'route') return boundsForPositions(area.coordinates, area.corridorMeters)
  return area.bounds
}

export function boundsCenter(bounds: Bounds): Position {
  const east = bounds.east < bounds.west ? bounds.east + 360 : bounds.east
  return { longitude: normalizeLongitude((bounds.west + east) / 2), latitude: (bounds.south + bounds.north) / 2 }
}

export function expandBounds(bounds: Bounds, factor = 1.2): Bounds {
  const center = boundsCenter(bounds)
  const width = (bounds.east < bounds.west ? bounds.east + 360 : bounds.east) - bounds.west
  const halfWidth = Math.max(0.0006, width * factor / 2)
  const halfHeight = Math.max(0.0006, (bounds.north - bounds.south) * factor / 2)
  return {
    west: halfWidth >= 180 ? -180 : normalizeLongitude(center.longitude - halfWidth),
    east: halfWidth >= 180 ? 180 : normalizeLongitude(center.longitude + halfWidth),
    south: Math.max(-89.9, center.latitude - halfHeight),
    north: Math.min(89.9, center.latitude + halfHeight),
  }
}
