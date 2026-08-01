// How the cutscene pages count time.
//
// The cache stores every action start in CLIENT CYCLES — 20ms each, the
// client's own frame clock (the dump's `lengthInCycles`). A RuneScape game TICK
// is 600ms, i.e. 30 of those cycles: the ratio is written straight into the
// cutscene walk pacing, where one tile (512 units) takes 30 cycles at walking
// pace. Neither unit subsumes the other — the raw field is what you edit, ticks
// are what you reason about against server-side timing, seconds are what you
// watch — so the roll's pill offers all three and everything else follows it.

export type CutsceneClockUnit = 'seconds' | 'ticks' | 'cycles'

export const CYCLE_MS = 20
export const CYCLES_PER_TICK = 30

export const CLOCK_UNITS: { key: CutsceneClockUnit; label: string; hint: string }[] = [
  { key: 'seconds', label: 'Seconds', hint: 'Wall-clock seconds — 50 client cycles each' },
  { key: 'ticks', label: 'Ticks', hint: 'RuneScape game ticks — 600ms each, or 30 client cycles' },
  { key: 'cycles', label: 'Cycles', hint: "Client cycles — 20ms each, the cache's own unit (lengthInCycles)" },
]

const SUFFIX: Record<CutsceneClockUnit, string> = { seconds: 's', ticks: 't', cycles: 'c' }

const scaled = (cycles: number, unit: CutsceneClockUnit): number =>
  unit === 'cycles' ? cycles : unit === 'ticks' ? cycles / CYCLES_PER_TICK : (cycles * CYCLE_MS) / 1000

/** Full precision, for a running clock: seconds and ticks always carry their
 *  decimal so the readout doesn't change width as it counts. */
export const clockValue = (cycles: number, unit: CutsceneClockUnit): string =>
  unit === 'cycles' ? String(cycles) : scaled(cycles, unit).toFixed(1)

export const clockSuffix = (unit: CutsceneClockUnit): string => SUFFIX[unit]

/** Trimmed, for ruler labels and per-action stamps: gridlines land on whole
 *  units by construction (see clockGranularity), so a ".0" is just noise. */
export function clockShort(cycles: number, unit: CutsceneClockUnit): string {
  const v = scaled(cycles, unit)
  return `${Number.isInteger(v) ? v : v.toFixed(1)}${SUFFIX[unit]}`
}

/** Cycles per ruler division, chosen so the labels come out whole in the
 *  displayed unit: 50 cycles is a second, 30 is a tick. */
export const clockGranularity = (unit: CutsceneClockUnit): number => (unit === 'ticks' ? CYCLES_PER_TICK : 50)
