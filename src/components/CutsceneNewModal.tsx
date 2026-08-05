import { useEffect, useRef, useState } from 'react'
import type { CutsceneAreaBlock, CutsceneAreaDef } from '../loaders/cutscenes'
import { areasForBlocks, CUTSCENE_CHUNKS, nextBlock } from '../loaders/cutscenes'
import CutsceneAreaBlocks from './CutsceneAreaBlocks'
import './CutscenePianoRoll.css'

// What "Add cutscene" asks before it makes one: which piece of the world the
// scene is built out of.
//
// A cutscene doesn't play in the world — it builds its own 104x104 map by
// copying blocks of chunks out of real regions. That map is the one thing the
// editor can't infer later, which is the whole reason adding a cutscene asks
// something and editing one doesn't.

type Props = {
  onCreate: (areas: CutsceneAreaDef[]) => void
  onClose: () => void
}

export default function CutsceneNewModal({ onCreate, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [blocks, setBlocks] = useState<CutsceneAreaBlock[]>([nextBlock([])])

  useEffect(() => { dialogRef.current?.showModal() }, [])

  return (
    <dialog
      ref={dialogRef}
      className="varbit-planner-dialog"
      onCancel={(e) => { e.preventDefault(); onClose() }}
    >
      <div className="cutscene-modal-body">
        <div className="anim-preview-head">
          <h3 className="confirm-dialog-title">New cutscene — what map?</h3>
          <button type="button" className="save-bar-discard" onClick={onClose}>Close</button>
        </div>

        <p className="tex-op-note">
          Pick the regions the scene is built from and where each one lands in the cutscene’s own
          {' '}{CUTSCENE_CHUNKS * 8}×{CUTSCENE_CHUNKS * 8} map. Each block becomes one row per plane,
          which you can still change afterwards.
        </p>

        <CutsceneAreaBlocks blocks={blocks} onChange={setBlocks} minBlocks={1} />

        <div className="varbit-planner-row">
          <button
            type="button"
            className="save-bar-save"
            onClick={() => { onCreate(areasForBlocks(blocks)); onClose() }}
          >
            Create cutscene
          </button>
          <span className="map-sprite-hint">
            comes with the fade-in every shipped cutscene opens with, and a FINISHED
          </span>
        </div>
      </div>
    </dialog>
  )
}
