export function imageryName(provider: string) {
  if (provider === 'google') return 'Google Street View'
  if (provider === 'panoramax') return 'Panoramax imagery'
  if (provider === 'owned') return 'licensed local imagery'
  return 'street-level imagery'
}

export function imageryDescription(provider: string) {
  if (provider === 'google') return 'Google Street View supplies imagery. Photo previews are temporary; source links remain available with cached results.'
  if (provider === 'panoramax') return 'Panoramax supplies openly licensed photos. Coverage varies by location, and each result retains its source attribution.'
  return 'Results retain their imagery source and attribution. Coverage varies by location.'
}
