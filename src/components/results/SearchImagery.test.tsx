// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SearchImagery } from './SearchImagery'
import type { ImageryFrame } from '@/types'

let root: Root
let container: HTMLDivElement
const frames: ImageryFrame[] = [0, 90].map((heading, index) => ({ id: `photo-${index}`, position: { longitude: -76.48278, latitude: 42.444862 }, heading, source: { provider: 'google', attribution: 'Google', imageUrl: `/api/imagery/photo-${index}`, referenceUrl: `https://www.google.com/maps/@?pano=${index}` }, capturedAt: '2025-05', detectionsCount: index, status: 'analyzed' }))

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

it('lets a user inspect photos even without any detections and recover after an expired preview', async () => {
  await act(async () => root.render(<SearchImagery frames={frames} query="Find bicycle racks" searchId="search-1"/>))
  await act(async () => (container.querySelector('button') as HTMLButtonElement).click())
  expect(document.body.textContent).toContain('No clear match in this photo')
  expect(document.body.textContent).toContain('Photographed May 2025')
  await act(async () => document.querySelector('img')?.dispatchEvent(new Event('error')))
  expect(document.body.textContent).toContain('Preview expired')
  expect(document.querySelector<HTMLAnchorElement>('a')?.href).toContain('google.com/maps')
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Next photo"]')?.click())
  expect(document.querySelector<HTMLImageElement>('img')?.getAttribute('src')).toBe('/api/imagery/photo-1')
  expect(document.body.textContent).toContain('1 visual match')
  expect(document.body.textContent).toContain('2 of 2 · Facing 90°')
})
