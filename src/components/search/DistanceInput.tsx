import { useEffect, useId, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { distanceInputValue, parseDistanceInput, type DistanceUnit } from '@/lib/distance-input'

type Props = {
  label: string
  unitLabel: string
  valueMeters: number
  minimum: number
  maximum: number
  rangeDescription: string
  disabled?: boolean
  onChange: (meters: number) => void
  onValidityChange: (valid: boolean) => void
}

export function DistanceInput({ label, unitLabel, valueMeters, minimum, maximum, rangeDescription, disabled = false, onChange, onValidityChange }: Props) {
  const [unit, setUnit] = useState<DistanceUnit>('m')
  const [draft, setDraft] = useState(() => distanceInputValue(valueMeters, 'm'))
  const dirty = useRef(false)
  const errorId = useId()
  const meters = parseDistanceInput(draft, unit, minimum, maximum)
  const valid = meters !== null

  useEffect(() => { onValidityChange(valid || disabled) }, [valid, disabled, onValidityChange])
  useEffect(() => {
    if (!dirty.current) setDraft(distanceInputValue(valueMeters, unit))
  }, [valueMeters, unit])

  const commit = () => {
    if (meters === null || disabled) return
    if (dirty.current) onChange(meters)
    dirty.current = false
  }

  const changeUnit = (next: DistanceUnit) => {
    if (meters !== null) {
      commit()
      setDraft(distanceInputValue(meters, next))
    } else {
      const reinterpreted = parseDistanceInput(draft, next, minimum, maximum)
      if (reinterpreted !== null) { onChange(reinterpreted); dirty.current = false }
    }
    setUnit(next)
  }

  return <div className="distance-control">
    <div className="distance-fields">
      <Input aria-label={label} inputMode="decimal" value={draft} disabled={disabled} aria-invalid={!valid} aria-describedby={!valid ? errorId : undefined}
        onChange={event => { dirty.current = true; setDraft(event.target.value) }} onBlur={commit}
        onKeyDown={event => {
          if (event.key === 'Enter') { event.preventDefault(); commit() }
          if (event.key === 'Escape') { dirty.current = false; setDraft(distanceInputValue(valueMeters, unit)) }
        }}/>
      <Select value={unit} onValueChange={value => changeUnit(value as DistanceUnit)} disabled={disabled}>
        <SelectTrigger aria-label={unitLabel}><SelectValue/></SelectTrigger>
        <SelectContent><SelectItem value="m">m</SelectItem><SelectItem value="km">km</SelectItem><SelectItem value="mi">mi</SelectItem></SelectContent>
      </Select>
    </div>
    {!valid && !disabled && <p id={errorId} className="input-help" role="alert">{rangeDescription}</p>}
  </div>
}
