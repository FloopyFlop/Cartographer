export type DistanceUnit = 'm' | 'km' | 'mi'

export const distanceUnits: Record<DistanceUnit, number> = { m: 1, km: 1000, mi: 1609.344 }

export function parseDistanceInput(value: string, unit: DistanceUnit, minimum: number, maximum: number): number | null {
  const cleaned = value.trim()
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(cleaned)) return null
  const meters = Number(cleaned) * distanceUnits[unit]
  return Number.isFinite(meters) && meters >= minimum && meters <= maximum ? meters : null
}

export function distanceInputValue(meters: number, unit: DistanceUnit): string {
  return String(Number((meters / distanceUnits[unit]).toFixed(8)))
}
