import React from 'react'

const LENGTHS = [15, 30, 45, 60, 90]

// The client says how long they have. Everything about the meeting's pacing
// follows from this one answer, so it's asked before anything else.
export default function LengthPicker({ onPick, onCancel }) {
  return (
    <div className="sheet" role="dialog" aria-label="How long do you have?">
      <div className="sheet-card">
        <h2>How long do you have today?</h2>
        <p className="muted">
          Your advisor works to the clock and will check in before it runs out. You can always
          add time.
        </p>
        <div className="lengths">
          {LENGTHS.map((minutes) => (
            <button key={minutes} className="length" onClick={() => onPick(minutes)}>
              <b>{minutes}</b><span>min</span>
            </button>
          ))}
        </div>
        <button className="link" onClick={onCancel}>Never mind</button>
      </div>
    </div>
  )
}
