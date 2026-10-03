import { useEffect, useId, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'

export function ImageSamplingInput({ value, onChange, onValidityChange }: { value: number; onChange: (count: number) => void; onValidityChange: (valid: boolean) => void }) {
  const id = useId()
  const [draft, setDraft] = useState(String(value))
  const dirty = useRef(false)
  const parsed = Number(draft)
  const valid = /^\d+$/.test(draft) && Number.isInteger(parsed) && parsed >= 4 && parsed <= 48

  useEffect(() => { onValidityChange(valid) }, [valid, onValidityChange])
  useEffect(() => { if (!dirty.current) setDraft(String(value)) }, [value])
  const commit = () => {
    if (!valid) return
    if (dirty.current) onChange(parsed)
    dirty.current = false
  }

  return <div className="sampling-config">
    <div className="sampling-row"><label htmlFor={id}>Maximum image views</label>
      <Input id={id} type="number" min={4} max={48} step={1} value={draft} aria-invalid={!valid} aria-describedby={`${id}-help`}
        onChange={event => { dirty.current = true; setDraft(event.target.value) }} onBlur={commit}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commit() } if (event.key === 'Escape') { dirty.current = false; setDraft(String(value)) } }}/>
    </div>
    <p id={`${id}-help`} className="input-help" role={valid ? undefined : 'alert'}>{valid ? 'More views cover more of the area. Your remaining budget limits every search.' : 'Enter a whole number from 4 to 48.'}</p>
  </div>
}
