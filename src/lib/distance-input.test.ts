import { describe, expect, it } from 'vitest'
import { distanceInputValue, parseDistanceInput } from './distance-input'

describe('freeform search distances', () => {
  it('accepts arbitrary decimals in meters, kilometers, and miles', () => {
    expect(parseDistanceInput('275.5', 'm', 25, 50_000)).toBe(275.5)
    expect(parseDistanceInput('.2755', 'km', 25, 50_000)).toBe(275.5)
    expect(parseDistanceInput('1.25', 'mi', 25, 50_000)).toBe(2011.68)
  })

  it('accepts the search radius boundaries and rejects values outside them', () => {
    expect(parseDistanceInput('25', 'm', 25, 50_000)).toBe(25)
    expect(parseDistanceInput('50', 'km', 25, 50_000)).toBe(50_000)
    expect(parseDistanceInput('24.99', 'm', 25, 50_000)).toBeNull()
    expect(parseDistanceInput('50.001', 'km', 25, 50_000)).toBeNull()
  })

  it.each(['', '.', '-100', 'Infinity', 'NaN', '1,000', '2abc'])('rejects incomplete or invalid values: %j', value => {
    expect(parseDistanceInput(value, 'm', 25, 50_000)).toBeNull()
  })

  it('formats a physical distance in the selected unit without preset snapping', () => {
    expect(distanceInputValue(375.5, 'm')).toBe('375.5')
    expect(distanceInputValue(375.5, 'km')).toBe('0.3755')
    expect(distanceInputValue(1609.344, 'mi')).toBe('1')
  })
})
