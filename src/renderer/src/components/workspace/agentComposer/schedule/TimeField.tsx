import React from 'react'

import { CloseIconButton, Input } from '../../../ui'
import { formatScheduleTime, parseScheduleTime, type ScheduleTime } from './scheduleEditor'
import { isImeKey } from '../../../../utils/imeKey'

/**
 * One time of day, typed: "9", "9:30", "9pm", "21:00". Read on Enter or when
 * focus leaves; one that does not read goes back to what it was. A bare hour
 * keeps the AM/PM the field already had.
 */
export function TimeField({
  time,
  removable = false,
  onChange,
  onRemove,
}: {
  time: ScheduleTime
  removable?: boolean
  onChange: (time: ScheduleTime) => void
  onRemove?: () => void
}) {
  const shown = formatScheduleTime(time)
  const [text, setText] = React.useState(`${shown.clock} ${shown.meridiem}`)
  React.useEffect(() => setText(`${shown.clock} ${shown.meridiem}`), [shown.clock, shown.meridiem])
  const commit = () => {
    const read = parseScheduleTime(text, shown.meridiem)
    if (read === null) setText(`${shown.clock} ${shown.meridiem}`)
    else if (read !== time) onChange(read)
  }
  return (
    <span className="inline-flex items-center">
      <Input
        size="sm"
        fullWidth={false}
        value={text}
        onChange={(event) => setText(event.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (isImeKey(event)) return
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
          }
        }}
        aria-label="Time of day"
        className="w-[10ch] tabular-nums"
      />
      {removable && onRemove ? (
        <CloseIconButton size="xs" aria-label={`Remove ${shown.clock} ${shown.meridiem}`} onClick={onRemove} />
      ) : null}
    </span>
  )
}
