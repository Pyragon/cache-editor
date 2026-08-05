import { useEffect, useRef } from 'react'
import type { CutsceneActionDef, CutsceneDef } from '../loaders/cutscenes'
import { clockShort } from './cutsceneClock'
import type { CutsceneClockUnit } from './cutsceneClock'
import './CutscenePianoRoll.css'

// "C" on the piano roll: turn the view you're looking at into camera data.
//
// A shot is a DIRECT_CAMERA_MOVEMENT plus the TWO paths it names — one holds
// where the camera is, the other what it aims at — and nothing in the format
// records which two belong together except that action. So the only two useful
// verbs are "start a shot here" and "add this view as another keyframe of an
// existing shot", which is exactly what this asks.

type Props = {
  def: CutsceneDef
  cycle: number
  unit: CutsceneClockUnit
  /** Shots already in the cutscene, with their index into `def.actions`. */
  shots: { action: CutsceneActionDef; index: number }[]
  freeCam: boolean
  onNewShot: () => void
  onAddKeyframe: (actionIndex: number) => void
  onGoToShot: (actionIndex: number) => void
  onClose: () => void
}

export default function CutsceneCameraModal({
  def, cycle, unit, shots, freeCam, onNewShot, onAddKeyframe, onGoToShot, onClose,
}: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  useEffect(() => { dialogRef.current?.showModal() }, [])

  return (
    <dialog
      ref={dialogRef}
      className="varbit-planner-dialog"
      onCancel={(e) => { e.preventDefault(); onClose() }}
    >
      <div className="cutscene-modal-body">
        <div className="anim-preview-head">
          <h3 className="confirm-dialog-title">Camera at {clockShort(cycle, unit)}</h3>
          <button type="button" className="save-bar-discard" onClick={onClose}>Close</button>
        </div>

        {!freeCam && (
          <p className="cutscene-note">
            Free camera is off, so this captures whatever the cutscene’s own camera is showing right
            now. Turn free camera on first if you want to frame the shot yourself.
          </p>
        )}

        <div className="varbit-planner-quick">
          <button
            type="button"
            className="replace-btn"
            onClick={() => { onNewShot(); onClose() }}
          >
            New shot from this view
          </button>
          <span className="map-sprite-hint">
            creates the move action at {clockShort(cycle, unit)} plus its camera and aim paths
          </span>
        </div>

        <p className="tex-op-note">
          A shot with one keyframe holds still. Capture the view again into the same shot and the
          camera flies between the keyframes, at the spline speeds on the action.
        </p>

        <div className="quest-table-wrap">
          <table className="quest-table">
            <thead>
              <tr><th>Shot at</th><th>Camera path</th><th>Aim path</th><th>Keyframes</th><th /></tr>
            </thead>
            <tbody>
              {shots.map(({ action, index }) => {
                const f = (action.fields ?? {}) as Record<string, number>
                const keyframes = def.camMovements[f.positionMovementIndex]?.xPositions.length ?? 0
                return (
                  <tr key={index}>
                    <td>{clockShort(action.lengthInCycles, unit)}</td>
                    <td className="item-stack-index">{f.positionMovementIndex}</td>
                    <td className="item-stack-index">{f.lookAtMovementIndex}</td>
                    <td className="item-stack-index">{keyframes}</td>
                    <td>
                      <span className="anim-fit-actions">
                        <button
                          type="button"
                          className="field-link-btn"
                          onClick={() => { onAddKeyframe(index); onClose() }}
                        >
                          Add this view
                        </button>
                        <button
                          type="button"
                          className="field-link-btn"
                          onClick={() => { onGoToShot(index); onClose() }}
                        >
                          Go to shot
                        </button>
                      </span>
                    </td>
                  </tr>
                )
              })}
              {shots.length === 0 && (
                <tr><td colSpan={5} className="cutscene-editor-empty">No shots yet — start one above.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </dialog>
  )
}
