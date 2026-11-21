import type { ReactNode } from 'react'

export function errorText(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

export function SettingsRow({ id, label, description, children }: { id: string; label: string; description: string; children: ReactNode }) {
  return (
    <div id={id} tabIndex={-1} className="settings-row">
      <div className="settings-row-copy">
        <div id={`${id}-label`}>{label}</div>
        <p>{description}</p>
      </div>
      {children}
    </div>
  )
}

export function Segments<T extends string | number>({ options, value, labelId, onChange }: {
  options: readonly { value: T; label: string }[]
  value: T
  labelId: string
  onChange: (value: T) => void
}) {
  return (
    <div className="settings-segments" role="group" aria-labelledby={labelId}>
      {options.map((option) => <button key={option.value} type="button" aria-pressed={value === option.value}
        onClick={() => onChange(option.value)}>{option.label}</button>)}
    </div>
  )
}
