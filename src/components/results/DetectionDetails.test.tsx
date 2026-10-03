// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DetectionDetails } from './DetectionDetails'
import type { Detection } from '@/types'

const detection: Detection = {
  id: 'live-bench-1', searchId: 'search-1', title: 'Bench', featureType: 'bench',
  position: { longitude: -76.48, latitude: 42.45 }, confidence: 0.82, attributes: {},
  source: { provider: 'panoramax', attribution: 'Panoramax contributor', imageUrl: 'https://example.com/source.jpg', referenceUrl: 'https://example.com/photo' },
  detectedAt: '2026-10-03T12:00:00Z', model: { name: 'vision', version: '1' }, verification: 'unverified',
  metadata: { visualEvidence: 'A slatted bench stands beside the footpath.', imageBoundingBox: { x: 0.125, y: 0.25, width: 0.5, height: 0.375 } },
}

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  vi.unstubAllGlobals()
})

async function render(value: Detection = detection) {
  await act(async () => { root.render(<DetectionDetails detection={value} onClose={() => {}} onFocus={() => {}} />) })
}

describe('source imagery and visual evidence', () => {
  it('labels model localization as approximate and lets users inspect a clean photo', async () => {
    await render()
    expect(container.textContent).toContain('Approximate object outline')
    await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Hide outline')?.click())
    expect(container.querySelector('[aria-label="Reported object area"]')).toBeNull()
    expect(container.querySelector('img')).not.toBeNull()
    await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Show outline')?.click())
    expect(container.querySelector('[aria-label="Reported object area"]')).not.toBeNull()
  })
  it('makes an unverified visual match and its approximate location explicit', async () => {
    await render()
    expect(container.textContent).toContain('Unverified visual match')
    expect(container.textContent).toContain('A slatted bench stands beside the footpath.')
    expect(container.textContent).toContain('The marker shows the camera location.')
    expect(container.textContent).toContain('its exact position has not been established')
    expect(container.querySelector<HTMLAnchorElement>('.source-photo')?.href).toBe('https://example.com/photo')
  })

  it.each([
    { x: 0.125, y: 0.25, width: 0.5, height: 0.375 },
    [0.125, 0.25, 0.5, 0.375] as [number, number, number, number],
  ])('places normalized boxes over an uncropped source image: %j', async imageBoundingBox => {
    await render({ ...detection, metadata: { imageBoundingBox } })
    const box = container.querySelector<HTMLSpanElement>('[aria-label="Reported object area"]')
    expect(box?.style.left).toBe('12.5%')
    expect(box?.style.top).toBe('25%')
    expect(box?.style.width).toBe('50%')
    expect(box?.style.height).toBe('37.5%')
    expect(container.querySelector<HTMLImageElement>('img')?.style.height).toBe('auto')
    expect(container.querySelector<HTMLImageElement>('img')?.style.maxHeight).toBe('none')
  })

  it.each([
    [0, 0, 0, 0.5],
    [-0.1, 0, 0.5, 0.5],
    [0.8, 0, 0.5, 0.5],
    [0, 0, Number.NaN, 0.5],
    [0, 0, 0.5],
  ])('does not draw malformed or out-of-image boxes: %j', async (...coordinates) => {
    await render({ ...detection, metadata: { imageBoundingBox: coordinates as [number, number, number, number] } })
    expect(container.querySelector('[aria-label="Reported object area"]')).toBeNull()
    expect(container.querySelector('img')).not.toBeNull()
  })

  it('restores the image when another detection is selected after an image error', async () => {
    await render()
    await act(async () => { container.querySelector('img')?.dispatchEvent(new Event('error')) })
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('Source image unavailable.')
    expect(container.querySelector<HTMLAnchorElement>('.source-image-link')?.href).toBe('https://example.com/photo')
    await render({ ...detection, id: 'live-bench-2', source: { ...detection.source, imageUrl: 'https://example.com/second.jpg' } })
    expect(container.querySelector<HTMLImageElement>('img')?.src).toBe('https://example.com/second.jpg')
    expect(container.textContent).not.toContain('Source image unavailable.')
  })

  it('keeps demonstration data clearly separate from visual matches', async () => {
    await render({ ...detection, source: { provider: 'demo', attribution: 'Demonstration' }, metadata: undefined })
    expect(container.textContent).toContain('Demonstration data')
    expect(container.textContent).not.toContain('Unverified visual match')
    expect(container.textContent).not.toContain('camera location')
  })

  it('does not repeat the same evidence as the description', async () => {
    await render({ ...detection, description: ` ${detection.metadata?.visualEvidence} ` })
    expect(container.textContent?.match(/A slatted bench stands beside the footpath\./g)).toHaveLength(1)
  })
})
