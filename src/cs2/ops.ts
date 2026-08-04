// The builtin ops the interface preview implements, bound to a
// Cs2InterfaceScene. Signatures follow the emitted call shapes (verified
// against the dump's own call sites; the RuneScript convention holds:
// if_* setters take their VALUE args first and the component hash LAST,
// cc_* ops act on the active component a cc_create/cc_find/cc_setchild
// selected — with @1-suffixed variants using the second active bank).
//
// Anything not implemented warns ONCE per op into scene.warnings, which the
// preview surfaces and interfaces.md tracks — that list is the honest
// boundary of the simulation.

import type { IComponentDefinition } from '../loaders/interfaces'
import { resolveAbsoluteLayout } from '../components/interfacePreview'
import type { LayoutRect } from '../components/interfacePreview'
import { loadCacheFont, measureCacheText } from '../components/interfacePreview'
import type { Cs2Env, Cs2Value } from './interpreter'
import { asInt, asStr } from './interpreter'
import { Cs2InterfaceScene } from './runtime'
import { Cs2Cache } from './cache'
import {
  VARBIT_LIFE_POINTS, VARBIT_PRAYER_POINTS, VARP_DISEASE, VARP_POISON,
  loadPlayerState, playerVar, skillLevel,
} from '../loaders/varOverrides'
import type { EnumDef } from './cache'

/**
 * The var state one preview run reads and writes.
 *
 * Seeded from the Variables modal (`src/loaders/varOverrides.ts`) BEFORE any
 * hook runs — scripts read these as ordinary vars — and a script that writes
 * one wins for the rest of the run, exactly like the client. Unset vars read
 * zero, or a known var's derived default.
 *
 * It lives outside `makeCs2Env` so the caller can hold it: the console needs
 * the value a transmit hook is about to see, and that has to be the LIVE
 * number (an earlier hook may have written it), not the saved override.
 */
export class Cs2VarStore {
  readonly varps = new Map<number, number>([
    [VARP_POISON, playerVar('varp', VARP_POISON)],
    [VARP_DISEASE, playerVar('varp', VARP_DISEASE)],
  ])

  readonly varbits = new Map<number, number>([
    [VARBIT_LIFE_POINTS, playerVar('varbit', VARBIT_LIFE_POINTS)],
    [VARBIT_PRAYER_POINTS, playerVar('varbit', VARBIT_PRAYER_POINTS)],
  ])

  readonly varcs = new Map<number, number>()
  readonly varcStrings = new Map<number, string>()

  /** What a script reading this varp right now would get. */
  varp(id: number): number {
    return this.varps.get(id) ?? playerVar('varp', id)
  }

  varbit(id: number): number {
    return this.varbits.get(id) ?? playerVar('varbit', id)
  }
}

export type Cs2Context = {
  scene: Cs2InterfaceScene
  /** windowed_getmode: 1 = fixed, 2 = resizable (the client's window modes) */
  mode: 'fixed' | 'resizable'
  rootHandle: FileSystemDirectoryHandle
  /** layout basis per interface (the slot rect it is attached into), set by
   *  the compositor before hooks run — the root pane gets the viewport */
  basis: Map<number, { w: number; h: number }>
  /** loads an interface's components for if_opensubclient (client-side
   *  IF_OPENSUBCLIENT); absent = the op records a warning instead */
  loadInterface?: (id: number) => Promise<(IComponentDefinition | null)[] | null>
  /** session-persistent data caches (parsed scripts, enums, params) */
  cache: Cs2Cache
  /** the run's var state; pass one in to read it back while hooks run */
  vars?: Cs2VarStore
  /** `client_clock()` — the client's 20ms cycle counter. Scripts time things
   *  by comparing it against a varc they advance themselves (the tooltip
   *  hover delay in script_4761 is the type specimen), so a clock frozen at 0
   *  makes any such countdown depend purely on how many times the hook is
   *  called rather than on elapsed time. */
  cycle?: number
}

const b = (v: Cs2Value) => asInt(v) !== 0

export function makeCs2Env(ctx: Cs2Context): Cs2Env {
  const { scene } = ctx

  const player = loadPlayerState()
  const vars = ctx.vars ?? new Cs2VarStore()
  const { varps, varbits, varcs, varcStrings } = vars
  const paramCache = ctx.cache.params

  // ---- lazily-computed layout per interface (for the get* ops) ----
  let layouts: Map<number, Map<number, LayoutRect>> | null = null
  const layoutFor = (ifaceId: number): Map<number, LayoutRect> | null => {
    if (!layouts) layouts = new Map()
    let l = layouts.get(ifaceId)
    if (!l) {
      const iface = scene.interfaces.get(ifaceId)
      if (!iface) return null
      const basis = ctx.basis.get(ifaceId) ?? { w: 765, h: 503 }
      l = resolveAbsoluteLayout(iface.components, basis.w, basis.h)
      layouts.set(ifaceId, l)
    }
    return l
  }
  const invalidateLayout = () => { layouts = null }
  const rectOf = (hash: number): LayoutRect | null => {
    const comp = scene.get(hash)
    if (!comp) return null
    return layoutFor(comp.interfaceId)?.get(comp.componentId) ?? null
  }
  const relPos = (hash: number): { x: number; y: number } => {
    const comp = scene.get(hash)
    const rect = rectOf(hash)
    if (!comp || !rect) return { x: 0, y: 0 }
    if (comp.parent === -1) return { x: rect.x, y: rect.y }
    const parentRect = rectOf((comp.interfaceId << 16) | (comp.parent & 0xffff))
    return parentRect ? { x: rect.x - parentRect.x, y: rect.y - parentRect.y } : { x: rect.x, y: rect.y }
  }

  // ---- enum lookups: the REAL enum table is the top-level enums/ dump
  // (defaultIntValue / defaultStringValue / values); config/enums is a
  // different, sparse sub-archive kept as a fallback ----
  const enumCache = ctx.cache.enums
  const loadEnum = (id: number) => {
    let p = enumCache.get(id)
    if (!p) {
      p = (async () => {
        for (const path of [['enums'], ['config', 'enums']]) {
          try {
            let dir = ctx.rootHandle
            for (const seg of path) dir = await dir.getDirectoryHandle(seg)
            const file = await (await dir.getFileHandle(`${id}.json`)).getFile()
            return JSON.parse(await file.text()) as EnumDef
          } catch { /* try the next location */ }
        }
        return null
      })()
      enumCache.set(id, p)
    }
    return p
  }

  // ---- fonts for text measurement ----
  /**
   * Lay a paragraph out at `width` and return the lines, greedy-wrapped
   * against the real glyph metrics.
   *
   * Shared by paramheight and parawidth ON PURPOSE. They are two questions
   * about the SAME layout — how many lines, and how wide the widest is — and
   * `parawidth` previously answered from the UNWRAPPED text, returning the
   * full single-line width. Every tooltip then got a box as wide as its text
   * would have been on one line, with the wrapped text sitting in the left
   * portion and dead space to the right (interface 11:18's "Empty all the
   * items you are wearing into your bank" was the reported case).
   */
  const wrapPara = async (text: string, width: number, fontId: number): Promise<string[]> => {
    const font = await loadCacheFont(ctx.rootHandle, fontId)
    const out: string[] = []
    for (const para of String(text).split('<br>')) {
      if (para === '' || !font) { out.push(para); continue }
      let line = ''
      for (const word of para.split(' ')) {
        const candidate = line === '' ? word : `${line} ${word}`
        if (measureCacheText(font, candidate) > width && line !== '') {
          out.push(line)
          line = word
        } else {
          line = candidate
        }
      }
      out.push(line)
    }
    return out.length > 0 ? out : ['']
  }

  // ---- the active-component helpers ----
  const bankOf = (name: string): [base: string, bank: number] => {
    const atIdx = name.indexOf('@')
    if (atIdx === -1) return [name, 0]
    return [name.slice(0, atIdx), Number(name.slice(atIdx + 1)) || 0]
  }
  const activeOf = (bank: number): IComponentDefinition | null => scene.active[bank] ?? null

  const mutate = (comp: IComponentDefinition | null, patch: Partial<IComponentDefinition>) => {
    if (!comp) return
    for (const [field, to] of Object.entries(patch)) {
      scene.recordChange(comp, field, comp[field as keyof IComponentDefinition], to)
    }
    Object.assign(comp, patch)
    invalidateLayout()
  }

  // Setter bodies shared by cc_* (active comp) and if_* (hash-addressed, hash
  // as the LAST argument). Each returns nothing.
  const setters: Record<string, (c: IComponentDefinition | null, a: Cs2Value[]) => void> = {
    setposition: (c, a) => mutate(c, {
      basePositionX: asInt(a[0]), basePositionY: asInt(a[1]),
      aspectXType: clampMode(asInt(a[2]), 5), aspectYType: clampMode(asInt(a[3]), 5),
    }),
    setsize: (c, a) => mutate(c, {
      baseWidth: asInt(a[0]), baseHeight: asInt(a[1]),
      aspectWidthType: clampMode(asInt(a[2]), 4), aspectHeightType: clampMode(asInt(a[3]), 4),
      aspectWidth: 0, aspectHeight: 0,
    }),
    sethide: (c, a) => mutate(c, { hidden: b(a[0]) }),
    setgraphic: (c, a) => mutate(c, { spriteId: asInt(a[0]) }),
    settext: (c, a) => mutate(c, { text: asStr(a[0]) }),
    setcolor: (c, a) => mutate(c, { color: asInt(a[0]) & 0xffffff }),
    settrans: (c, a) => mutate(c, { transparency: asInt(a[0]) & 0xff }),
    setfill: (c, a) => mutate(c, { filled: b(a[0]) }),
    setoutline: (c, a) => mutate(c, { borderThickness: asInt(a[0]) }),
    settextfont: (c, a) => mutate(c, { fontId: asInt(a[0]) }),
    settextalign: (c, a) => mutate(c, {
      textHorizontalAli: asInt(a[0]), textVerticalAli: asInt(a[1]), lineSpacing: asInt(a[2]),
    }),
    settextshadow: (c, a) => mutate(c, { shadow: b(a[0]) }),
    settiling: (c, a) => mutate(c, { tiling: b(a[0]) }),
    sethflip: (c, a) => mutate(c, { flipHorizontal: b(a[0]) }),
    setvflip: (c, a) => mutate(c, { flipVertical: b(a[0]) }),
    setmodel: (c, a) => mutate(c, { modelType: 'RAW_MODEL', modelId: asInt(a[0]) }),
    setmodelanim: (c, a) => mutate(c, { animation: asInt(a[0]) }),
    setmodelzoom: (c, a) => mutate(c, { spriteScale: asInt(a[0]) }),
    setscrollsize: (c, a) => mutate(c, { scrollWidth: asInt(a[0]), scrollHeight: asInt(a[1]) }),
    setitem: (c, a) => {
      // an ITEM component: modelType ITEM with the item id — the painter
      // draws a placeholder for now (item sprites are on the roadmap)
      mutate(c, { modelType: 'ITEM', modelId: asInt(a[0]) })
    },
    setopbase: (c, a) => mutate(c, { opBase: asStr(a[0]) }),
    setopname: (c, a) => mutate(c, { opBase: asStr(a[0]) }),
    setoptionname: (c, a) => mutate(c, { opBase: asStr(a[0]) }),
    setlinewid: (c, a) => mutate(c, { lineWidth: asInt(a[0]) }),
    setlinewidth: (c, a) => mutate(c, { lineWidth: asInt(a[0]) }),
    setlinedirection: (c, a) => mutate(c, { lineDirection: b(a[0]) }),
    setborderthickness: (c, a) => mutate(c, { borderThickness: asInt(a[0]) }),
    setspritescale: (c, a) => mutate(c, { spriteScale: asInt(a[0]) }),
    setspriteshadow: (c, a) => mutate(c, { spriteShadow: asInt(a[0]) }),
    setgraphicshadow: (c, a) => mutate(c, { spriteShadow: asInt(a[0]) }),
    set2dangle: (c, a) => mutate(c, { angle2d: asInt(a[0]) }),
    setmaxlines: (c, a) => mutate(c, { maxTextLines: asInt(a[0]) }),
    setmaxtextlines: (c, a) => mutate(c, { maxTextLines: asInt(a[0]) }),
    setalpha: (c, a) => mutate(c, { alpha: b(a[0]) }),
    setmodelorthog: (c, a) => mutate(c, { usesOrthogonal: b(a[0]) }),
    setclickmask: (c, a) => mutate(c, { clickMask: b(a[0]) }),
    setnoclickthrough: (c, a) => mutate(c, { preventClickThrough: b(a[0]) }),
    set_item_no_num: (c, a) => mutate(c, { modelType: 'ITEM', modelId: asInt(a[0]) }),
    set_item_always_num: (c, a) => mutate(c, { modelType: 'ITEM', modelId: asInt(a[0]) }),
    setitem_nonum: (c, a) => mutate(c, { modelType: 'ITEM', modelId: asInt(a[0]) }),
    setitem_alwaysnum: (c, a) => mutate(c, { modelType: 'ITEM', modelId: asInt(a[0]) }),
    setnpchead: (c, a) => mutate(c, { modelType: 'NPC_HEAD', modelId: asInt(a[0]) }),
    setuseop: (c, a) => mutate(c, { targetVerb: asStr(a[0]) }),
    setuseoptionstring: (c, a) => mutate(c, { targetVerb: asStr(a[0]) }),
    setscrollpos: () => { /* scroll offsets aren't modelled in the preview */ },
    setop: (c, a) => {
      if (!c) return
      const idx = asInt(a[0]) - 1
      const options = [...(c.options ?? [])]
      while (options.length <= idx) options.push('')
      options[idx] = asStr(a[1])
      mutate(c, { options, hasInteraction: true })
    },
  }

  // getters shared by cc_/if_ variants
  const getters: Record<string, (c: IComponentDefinition | null) => Cs2Value> = {
    getx: (c) => c ? relPos((c.interfaceId << 16) | c.componentId).x : 0,
    gety: (c) => c ? relPos((c.interfaceId << 16) | c.componentId).y : 0,
    getwidth: (c) => c ? rectOf((c.interfaceId << 16) | c.componentId)?.width ?? 0 : 0,
    getheight: (c) => c ? rectOf((c.interfaceId << 16) | c.componentId)?.height ?? 0 : 0,
    gethide: (c) => c?.hidden ? 1 : 0,
    ishidden: (c) => c?.hidden ? 1 : 0,
    gettext: (c) => c?.text ?? '',
    getgraphic: (c) => c?.spriteId ?? -1,
    getspriteid: (c) => c?.spriteId ?? -1,
    getcolour: (c) => c?.color ?? 0,
    getcolor: (c) => c?.color ?? 0,
    gettrans: (c) => c?.transparency ?? 0,
    gettransparency: (c) => c?.transparency ?? 0,
    getscrollx: () => 0,
    getscrolly: () => 0,
    getscrollwidth: (c) => c?.scrollWidth ?? 0,
    getscrollheight: (c) => c?.scrollHeight ?? 0,
    getlayer: (c) => c && c.parent !== -1 ? ((c.interfaceId << 16) | (c.parent & 0xffff)) >>> 0 : -1,
    getparentlayer: (c) => c && c.parent !== -1 ? ((c.interfaceId << 16) | (c.parent & 0xffff)) >>> 0 : -1,
    getcontaineritemid: (c) => c?.modelType === 'ITEM' ? c.modelId : -1,
    get2dangle: (c) => c?.angle2d ?? 0,
  }

  /** hook installers: recorded as intentional no-ops (we don't run event
   *  hooks in a static preview), NOT warned as unknown */
  const HOOK_INSTALLERS = new Set([
    'setonmouseover', 'setonmouseleave', 'setonmouserepeat', 'setonclick',
    'setonop', 'setondrag', 'setondragcomplete', 'setonhold', 'setonrelease',
    'setontimer', 'setonvartransmit', 'setonstattransmit', 'setoninvtransmit',
    'setonkey', 'setonscrollwheel', 'setonclanchat', 'setonchat', 'setonuse',
    'setonmiscactivity', 'setondialogabort', 'setonsubchange', 'setonresize',
  ])

  const envStub = (name: string, result: Cs2Value = 0) => {
    scene.warn(name, 'environment op stubbed')
    return result
  }

  return {
    async loadScriptSource(id: number): Promise<string | null> {
      try {
        const dir = await ctx.rootHandle.getDirectoryHandle('cs2')
        const file = await (await dir.getFileHandle(`${id}.cs2`)).getFile()
        return await file.text()
      } catch { return null }
    },

    warn(message: string) {
      scene.warn('interpreter', message)
    },

    callBuiltin(rawName: string, args: Cs2Value[]) {
      const [name, bank] = bankOf(rawName)

      // ---- component addressing ----
      if (name === 'get_comp') return ((asInt(args[0]) << 16) | (asInt(args[1]) & 0xffff)) >>> 0
      if (name === 'cc_create') return scene.create(bank, asInt(args[0]), asInt(args[1]), asInt(args[2])) ? 1 : 0
      if (name === 'cc_find') return scene.find(bank, asInt(args[0]), asInt(args[1])) ? 1 : 0
      if (name === 'cc_setchild') {
        scene.active[bank] = scene.get(asInt(args[0]))
        return scene.active[bank] ? 1 : 0
      }
      if (name === 'cc_deleteall') { scene.deleteAll(asInt(args[0])); invalidateLayout(); return }
      if (name === 'cc_delete') {
        // deletes the ACTIVE dynamic component
        const c = activeOf(bank)
        if (c) {
          const iface = scene.interfaces.get(c.interfaceId)
          if (iface) iface.components[c.componentId] = null
          scene.active[bank] = null
          scene.recordEvent(`${c.interfaceId}:${c.componentId}`, 'cc_delete', 'removed')
          invalidateLayout()
        }
        return
      }
      if (name === 'if_getnextsubid') {
        const parentHash = asInt(args[0])
        const iface = scene.interfaces.get(parentHash >>> 16)
        if (!iface) return 0
        const parentKeyBase = (parentHash & 0xffff) << 16
        let next = 0
        for (const key of iface.dynamicByKey.keys()) {
          if ((key & 0xffff0000) === parentKeyBase) next = Math.max(next, (key & 0xffff) + 1)
        }
        return next
      }
      if (name === 'if_isopen') return scene.subs.has(asInt(args[0]) >>> 0) ? 1 : 0
      if (name === 'if_isopenwithid' || name === 'if_isopenwithid2') {
        return scene.subs.get(asInt(args[0]) >>> 0) === asInt(args[1]) ? 1 : 0
      }
      if (name === 'if_opensubclient') {
        const target = asInt(args[0]) >>> 0
        const ifaceId = asInt(args[1])
        if (!ctx.loadInterface) { scene.warn(rawName, 'no interface loader'); return }
        return (async () => {
          const comps = await ctx.loadInterface!(ifaceId)
          if (!comps) { scene.warn(rawName, `interface ${ifaceId} missing`); return undefined }
          scene.addInterface(ifaceId, comps)
          scene.subs.set(target, ifaceId)
          scene.recordEvent(`${target >>> 16}:${target & 0xffff}`, 'if_opensubclient', `opened interface ${ifaceId}`)
          invalidateLayout()
          return undefined
        })()
      }
      if (name === 'if_closesubclient') {
        scene.subs.delete(asInt(args[0]) >>> 0)
        return
      }

      // ---- cc_* setters/getters on the active component ----
      if (name.startsWith('cc_')) {
        const op = name.slice(3)
        if (setters[op]) { setters[op](activeOf(bank), args); return }
        if (getters[op]) return getters[op](activeOf(bank))
        if (HOOK_INSTALLERS.has(op)) return
        scene.warn(rawName, `unimplemented cc op (${args.length} args)`)
        return 0
      }

      // ---- if_* setters/getters addressed by hash (LAST arg) ----
      if (name.startsWith('if_')) {
        const op = name.slice(3)
        if (setters[op]) {
          const hash = asInt(args[args.length - 1])
          const target = scene.get(hash)
          // A setter aimed at a component that isn't in the scene does nothing
          // AND says nothing — which is exactly how a script "runs fine" while
          // changing nothing on screen. Log it; it's the first thing to check
          // when a hook looks like a no-op.
          if (!target) {
            scene.recordEvent(hashLabel(hash), rawName, 'target not in scene — skipped')
          }
          setters[op](target, args.slice(0, -1))
          return
        }
        if (getters[op]) return getters[op](scene.get(asInt(args[0])))
        if (HOOK_INSTALLERS.has(op)) return
        scene.warn(rawName, `unimplemented if op (${args.length} args)`)
        return 0
      }

      // ---- vars ----
      // through the store, so the console's "what value fired this hook" and
      // the script's own read can never disagree
      if (name === '__get_varp') return vars.varp(asInt(args[0]))
      if (name === '__get_varbit' || name === '__get_varpbit') return vars.varbit(asInt(args[0]))
      if (name.startsWith('__get_clan')) return 0
      if (name === '__set_varp') { varps.set(asInt(args[0]), asInt(args[1])); return }
      if (name === '__set_varbit' || name === '__set_varpbit') { varbits.set(asInt(args[0]), asInt(args[1])); return }
      if (name === '__set_varc') { varcs.set(asInt(args[0]), asInt(args[1])); return }
      if (name === '__set_varc_string') { varcStrings.set(asInt(args[0]), asStr(args[1])); return }
      if (name.startsWith('__set_clan')) return
      if (name === '__get_varc' || name === '__get_clientvarp') return varcs.get(asInt(args[0])) ?? 0
      if (name === '__get_varc_string' || name === '__get_varcstring') return varcStrings.get(asInt(args[0])) ?? ''
      if (name === 'setvarc_int' || name === 'setvarcint') { varcs.set(asInt(args[0]), asInt(args[1])); return }
      if (name === 'setvarc_string') { varcStrings.set(asInt(args[0]), asStr(args[1])); return }
      if (name === 'setvarp' || name === 'setvar') { varps.set(asInt(args[0]), asInt(args[1])); return }
      if (name === 'setvarbit') { varbits.set(asInt(args[0]), asInt(args[1])); return }
      if (name === 'getvarc_int') return varcs.get(asInt(args[0])) ?? 0
      if (name === 'getvarc_string') return varcStrings.get(asInt(args[0])) ?? ''
      if (name === 'getvarbit') return varbits.get(asInt(args[0])) ?? 0
      if (name === 'getvarp') return varps.get(asInt(args[0])) ?? 0

      // ---- environment queries ----
      if (name === 'windowed_getmode') return ctx.mode === 'fixed' ? 1 : 2
      if (name === 'world_language') return 0
      if (name === 'clientclock') return ctx.cycle ?? 0
      if (name === 'map_members' || name === 'world_members' || name === 'playermember') return player.members ? 1 : 0
      if (name === 'stat' || name === 'stat_base') return skillLevel(asInt(args[0]))
      if (name === 'stat_visible_xp') return 0
      if (name === 'runenergy_visible') return player.runEnergy
      if (name === 'runweight_visible') return 0
      if (name === 'inv_size') return 28
      if (name.startsWith('chat_getfilter')) return 0
      if (name.startsWith('userdetail')) return 0
      if (name === 'playermod' || name === 'playermodlevel' || name === 'staffmodlevel') return 0
      if (name === 'gender') return 0
      if (name === 'get_displayname' || name === 'chat_playername') return player.displayName
      if (name === 'comlevel_active') return 3
      if (name === 'new_array') {
        const size = asInt(args[1])
        return [new Array(Math.max(0, Math.min(size, 65536))).fill(0) as Cs2Value[]] as Cs2Value[]
      }
      if (name === 'struct_param' || name === 'item_param' || name === 'npc_param' || name === 'object_param' || name === 'quest_param') {
        const folder = { struct_param: ['config', 'structs'], item_param: ['items'], npc_param: ['npcs'], object_param: ['objects'], quest_param: ['config', 'quests'] }[name]!
        const key = `${name}:${asInt(args[0])}`
        let p = paramCache.get(key)
        if (!p) {
          p = (async () => {
            try {
              let dir = ctx.rootHandle
              for (const seg of folder) dir = await dir.getDirectoryHandle(seg)
              const file = await (await dir.getFileHandle(`${asInt(args[0])}.json`)).getFile()
              const def = JSON.parse(await file.text()) as { parameters?: Record<string, unknown>; params?: Record<string, unknown>; values?: Record<string, unknown> }
              return def.parameters ?? def.params ?? def.values ?? {}
            } catch { return {} }
          })()
          paramCache.set(key, p)
        }
        return p.then((table) => {
          const v = table[String(asInt(args[1]))]
          return typeof v === 'string' ? v : typeof v === 'number' ? v : 0
        })
      }
      if (name === 'instr6213') {
        // if_setop(opIndex, text, comp) under its unnamed id
        setters.setop!(scene.get(asInt(args[2])), [args[0], args[1]])
        return
      }

      // ---- arithmetic / string library ----
      if (name === 'scale') {
        const [v, range, max] = [asInt(args[0]), asInt(args[1]), asInt(args[2])]
        return range === 0 ? 0 : ((v * max / range) | 0)
      }
      if (name === 'min') return Math.min(asInt(args[0]), asInt(args[1]))
      if (name === 'max') return Math.max(asInt(args[0]), asInt(args[1]))
      if (name === 'abs') return Math.abs(asInt(args[0]))
      if (name === 'random') return 0 // deterministic previews
      if (name === 'randominc') return 0
      if (name === 'interpolate') {
        // interpolate(y0, y1, x0, x1, x)
        const [y0, y1, x0, x1, x] = args.map(asInt)
        if (x1 === x0) return y0
        return (y0 + ((y1 - y0) * (x - x0) / (x1 - x0))) | 0
      }
      if (name === 'to_string' || name === 'tostring') return asStr(args[0])
      if (name === 'to_int' || name === 'toint') {
        const n = parseInt(asStr(args[0]), 10)
        return Number.isFinite(n) ? n : 0
      }
      if (name === 'fromRGB' || name === 'fromrgb') return ((asInt(args[0]) & 0xff) << 16) | ((asInt(args[1]) & 0xff) << 8) | (asInt(args[2]) & 0xff)
      if (name === 'string_length') return asStr(args[0]).length
      if (name === 'substring') return asStr(args[0]).slice(asInt(args[1]), asInt(args[2]))
      if (name === 'string_indexof_string') return asStr(args[0]).indexOf(asStr(args[1]), asInt(args[2]))
      if (name === 'string_indexof_char') return asStr(args[0]).indexOf(String.fromCharCode(asInt(args[1])), asInt(args[2]))
      if (name === 'uppercase') return asStr(args[0]).toUpperCase()
      if (name === 'lowercase' || name === 'lower_string') return asStr(args[0]).toLowerCase()
      if (name === 'tostring_localised' || name === 'tostring_localized' || name === 'formatnumber') return asStr(args[0])
      if (name === 'append') return asStr(args[0]) + asStr(args[1])
      if (name === 'append_num' || name === 'append_signnum') return asStr(args[0]) + asStr(args[1])
      if (name === 'append_char') return asStr(args[0]) + String.fromCharCode(asInt(args[1]))
      if (name === 'removetags') return asStr(args[0]).replace(/<[^>]*>/g, '')
      if (name === 'escape') return asStr(args[0])
      if (name === 'compare') {
        const [x, y] = [asStr(args[0]), asStr(args[1])]
        return x < y ? -1 : x > y ? 1 : 0
      }
      if (name === 'get_col_tag') return '<col=' + (asInt(args[0]) & 0xffffff).toString(16).padStart(6, '0') + '>'
      if (name === 'pow') return Math.pow(asInt(args[0]), asInt(args[1])) | 0
      if (name === 'client_clock') return ctx.cycle ?? 0

      // ---- text measurement (real glyph metrics) ----
      // paramheight / parawidth are the same layout asked two ways: lay the
      // paragraph out at the given width, then count lines or measure the
      // widest one.
      if (name === 'paramheight') {
        return (async () => (await wrapPara(asStr(args[0]), asInt(args[1]), asInt(args[2]))).length)()
      }
      if (name === 'parawidth' || name === 'paramwidth') {
        return (async () => {
          const font = await loadCacheFont(ctx.rootHandle, asInt(args[2]))
          const lines = await wrapPara(asStr(args[0]), asInt(args[1]), asInt(args[2]))
          if (!font) return Math.max(...lines.map((l) => l.length * 6), 0)
          return lines.reduce((widest, line) => Math.max(widest, measureCacheText(font, line)), 0)
        })()
      }
      if (name === 'stringwidth') {
        return (async () => {
          const font = await loadCacheFont(ctx.rootHandle, asInt(args[1]))
          return font ? measureCacheText(font, asStr(args[0])) : asStr(args[0]).length * 6
        })()
      }

      // ---- enums (real dump data; typed by the value-type char exactly as
      // the client op is: 's' returns a string, everything else an int) ----
      if (name === 'enum') {
        return (async () => {
          const [, valueChar, enumId, key] = args
          const wantString = asStr(valueChar) === 's'
          const def = await loadEnum(asInt(enumId))
          if (!def) return wantString ? '' : -1
          const v = def.values?.[String(asInt(key))]
          if (wantString) {
            if (typeof v === 'string') return v
            const dflt = def.defaultStringValue ?? ''
            return dflt === 'null' ? '' : dflt
          }
          if (typeof v === 'number') return v | 0
          return (def.defaultIntValue ?? -1) | 0
        })()
      }
      if (name === 'enum_string') {
        return (async () => {
          const def = await loadEnum(asInt(args[0]))
          const v = def?.values?.[String(asInt(args[1]))]
          if (typeof v === 'string') return v
          const dflt = def?.defaultStringValue ?? ''
          return dflt === 'null' ? '' : dflt
        })()
      }
      if (name === 'enum_getoutputcount') {
        return (async () => {
          const def = await loadEnum(asInt(args[0]))
          return def?.values ? Object.keys(def.values).length : 0
        })()
      }
      if (name === 'enum_hasoutput') {
        return (async () => {
          const def = await loadEnum(asInt(args[2] ?? args[0]))
          return def?.values ? 1 : 0
        })()
      }

      // ---- sound / misc environment: silent stubs ----
      if (name.startsWith('sound_') || name.startsWith('detailget') || name.startsWith('jingle')) {
        return envStub(rawName)
      }
      if (name.startsWith('hook_')) return // hook installers by another name
      if (name.startsWith('instr')) {
        const n = Number(name.slice(5))
        if (HOOK_INSTRS.has(n)) return // component-hook installers: no-op
        // hook installers are recognisable by SHAPE: a script_N reference plus
        // a signature string among the args (cc-flavoured ones carry no
        // component); treat those as intentional no-ops, not unknowns
        if (args.some((a) => typeof a === 'string' && /^script_-?\d+$/.test(a))) return
        scene.warn(rawName, `unnamed instruction (${args.length} args)`)
        return 0
      }

      scene.warn(rawName, `unknown builtin (${args.length} args)`)
      return 0
    },
  }
}

function clampMode(v: number, max: number): number {
  return v < 0 ? 0 : v > max ? max : v
}

/** A component hash as "interface:component" — or the raw number when it
 *  clearly isn't one (an unresolved hook sentinel, a -1). */
function hashLabel(hash: number): string {
  if (hash < 0 || (hash >>> 16) === 0) return String(hash)
  return `${hash >>> 16}:${hash & 0xffff}`
}

/** COMPONENT_HOOK instr ids (hook installers whose ops are unnamed in the
 *  table) — intentional no-ops in a static preview, not unknowns. */
const HOOK_INSTRS = new Set([
  6231, 6232, 6235, 6237, 6239, 6240, 6246, 6247, 6248, 6249, 6250, 6251,
  6252, 6253, 6254, 6255, 6256, 6257, 6260, 6342, 6376, 6393, 6507, 6527,
  6708, 6898,
])
