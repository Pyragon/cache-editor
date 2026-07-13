// Single-character "ScriptVarType" tags shared by enums, params, structs
// and CS2 scripts. Sourced from the darkan-game-client/cryogen client source
// (CS2Type.forJagexChar) — see CLAUDE.md.
export const TYPE_LABELS: Record<string, string> = {
  i: 'int', s: 'string', o: 'obj id', n: 'npc id', K: 'idkit id', v: 'inv id',
  J: 'struct id', m: 'model id', d: 'graphic id', g: 'enum id', l: 'loc',
  k: 'chat category', c: 'coord grid', x: 'texture id', A: 'anim id', M: 'midi id',
  j: 'jingle id', '1': 'boolean', '@': 'cursor id', '«': 'sound id', '`': 'map area',
  I: 'component', S: 'stat id', t: 'spotanim id',
}

export function typeLabel(char: string): string {
  return TYPE_LABELS[char] ?? 'unknown'
}
