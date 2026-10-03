// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DistanceInput } from './DistanceInput'
import { ImageSamplingInput } from './ImageSamplingInput'

let root: Root
let container: HTMLDivElement
const onChange = vi.fn()
const onValidityChange = vi.fn()

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.clearAllMocks()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  vi.unstubAllGlobals()
})

async function renderDistance(valueMeters = 650) {
  await act(async () => { root.render(<DistanceInput label="Search radius" unitLabel="Radius unit" valueMeters={valueMeters}
    minimum={25} maximum={50_000} rangeDescription="Enter a radius from 25 m to 50 km." onChange={onChange} onValidityChange={onValidityChange}/>) })
}

async function type(value: string) {
  const input = container.querySelector('input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function blur() { await act(async () => { container.querySelector('input')!.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) }) }
async function key(key: string) { await act(async () => { container.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })) }) }

describe('committed search controls', () => {
  it('keeps a decimal radius draft intact and updates the map only after a valid commit', async () => {
    await renderDistance()
    await type('275.5')
    expect(container.querySelector('input')?.value).toBe('275.5')
    expect(onChange).not.toHaveBeenCalled()
    await blur()
    expect(onChange).toHaveBeenCalledOnce()
    expect(onChange).toHaveBeenCalledWith(275.5)
  })

  it('does not submit an invalid radius and recovers when the user supplies a valid value', async () => {
    await renderDistance()
    await type('.')
    await key('Enter')
    expect(onChange).not.toHaveBeenCalled()
    expect(onValidityChange).toHaveBeenLastCalledWith(false)
    expect(container.querySelector('input')?.getAttribute('aria-invalid')).toBe('true')
    expect(container.textContent).toContain('25 m to 50 km')
    await type('375.25')
    await key('Enter')
    expect(onChange).toHaveBeenCalledWith(375.25)
    expect(onValidityChange).toHaveBeenLastCalledWith(true)
  })

  it('accepts map updates without clobbering a distance the user is still typing', async () => {
    await renderDistance()
    await renderDistance(800)
    expect(container.querySelector('input')?.value).toBe('800')
    await type('275.')
    await renderDistance(900)
    expect(container.querySelector('input')?.value).toBe('275.')
    await key('Escape')
    expect(container.querySelector('input')?.value).toBe('900')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('validates image sampling counts and commits only whole numbers within the budget control range', async () => {
    await act(async () => { root.render(<ImageSamplingInput value={16} onChange={onChange} onValidityChange={onValidityChange}/>) })
    await type('49')
    await blur()
    expect(onChange).not.toHaveBeenCalled()
    expect(onValidityChange).toHaveBeenLastCalledWith(false)
    await type('7.5')
    await key('Enter')
    expect(onChange).not.toHaveBeenCalled()
    await type('28')
    expect(onChange).not.toHaveBeenCalled()
    await key('Enter')
    expect(onChange).toHaveBeenCalledWith(28)
    expect(onValidityChange).toHaveBeenLastCalledWith(true)
  })
})
