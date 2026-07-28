import { useEffect, useRef, useState } from 'react'
import { EditorView, basicSetup } from 'codemirror'
import { hoverTooltip, tooltips, keymap, MatchDecorator, ViewPlugin, Decoration, WidgetType } from '@codemirror/view'
import type { DecorationSet, ViewUpdate } from '@codemirror/view'
import { javascript } from '@codemirror/lang-javascript'
import { indentUnit } from '@codemirror/language'
import { autocompletion, acceptCompletion } from '@codemirror/autocomplete'
import { linter, lintGutter } from '@codemirror/lint'
import type { Diagnostic } from '@codemirror/lint'
import { lintCS2 } from './cs2Lint'
import type { Completion, CompletionContext } from '@codemirror/autocomplete'
import { Prec } from '@codemirror/state'
import { EditorState } from '@codemirror/state'
import { oneDark } from '@codemirror/theme-one-dark'
import type { CS2Script } from '../loaders/cs2'
import intellisense from '../data/cs2-intellisense.json'
import './CS2Viewer.css'

// Hover docs harvested from darkan-bot-refactor's CS2Interpreter (see docs/cs2.md):
// per-op arg types/names, push-back expressions from the actual client runtime, the refactored
// handler name, and the @N operand meaning. script_N hovers resolve the target's header line.
interface OpDoc {
  description: string | null
  opcode: number
  kind: string
  args: { type: string, name: string | null }[] | null
  returns: { type: string, expr: string | null }[] | null
  operandNote: string | null
  handler: string | null
  clientName: string | null
  reads: string[] | null
}

const OP_DOCS = intellisense as Record<string, OpDoc>

function sugarTooltip(signature: string, description: string): HTMLElement {
  const dom = document.createElement('div')
  dom.className = 'cs2-tooltip'
  const sig = document.createElement('div')
  sig.className = 'cs2-tooltip-sig'
  sig.textContent = signature
  dom.appendChild(sig)
  const desc = document.createElement('div')
  desc.className = 'cs2-tooltip-desc'
  desc.textContent = description
  dom.appendChild(desc)
  return dom
}

function opTooltip(word: string): HTMLElement | null {
  if (word === 'fromRGB')
    return sugarTooltip('fromRGB(r, g, b) → int',
      'Editor sugar: packs r/g/b (0-255) into a 0xRRGGBB colour int at compile time. Click the swatch to pick a colour.')
  if (word === 'get_comp')
    return sugarTooltip('get_comp(interfaceId, componentId) → int',
      'Editor sugar: packs an interface id and component id into the component hash (interfaceId << 16 | componentId) at compile time.')
  const doc = OP_DOCS[word.replace(/@\d+$/, '')]
  if (!doc) return null
  const dom = document.createElement('div')
  dom.className = 'cs2-tooltip'
  const sig = document.createElement('div')
  sig.className = 'cs2-tooltip-sig'
  const args = (doc.args ?? []).map(a => a.name ? `${a.name}: ${a.type}` : a.type).join(', ')
  const rets = doc.returns?.length ? ` → ${doc.returns.map(r => r.type).join(', ')}` : ''
  sig.textContent = `${word.replace(/@\d+$/, '')}(${args})${rets}`
  dom.appendChild(sig)
  if (doc.description) {
    const desc = document.createElement('div')
    desc.className = 'cs2-tooltip-desc'
    desc.textContent = doc.description
    dom.appendChild(desc)
  }
  const aliases = [doc.handler && `darkan: ${doc.handler}`, doc.clientName && `client: ${doc.clientName}`, `opcode ${doc.opcode}`]
    .filter(Boolean).join(' · ')
  const meta = document.createElement('div')
  meta.className = 'cs2-tooltip-meta'
  meta.textContent = aliases
  dom.appendChild(meta)
  for (const r of doc.returns ?? []) {
    if (!r.expr) continue
    const expr = document.createElement('div')
    expr.className = 'cs2-tooltip-expr'
    expr.textContent = `pushes: ${r.expr}`
    dom.appendChild(expr)
  }
  if (doc.reads?.length) {
    const reads = document.createElement('div')
    reads.className = 'cs2-tooltip-meta'
    reads.textContent = `touches: ${doc.reads.join(', ')}`
    dom.appendChild(reads)
  }
  if (doc.operandNote) {
    const note = document.createElement('div')
    note.className = 'cs2-tooltip-note'
    note.textContent = doc.operandNote
    dom.appendChild(note)
  }
  return dom
}

// ---- autocomplete: every op (with signature + description) plus the editor sugar ----

const OP_COMPLETIONS: Completion[] = [
  ...Object.entries(OP_DOCS).map(([name, doc]) => {
    const args = (doc.args ?? []).map(a => a.name ? `${a.name}: ${a.type}` : a.type).join(', ')
    const rets = doc.returns?.length ? ` → ${doc.returns.map(r => r.type).join(', ')}` : ''
    return {
      label: name,
      type: 'function',
      detail: `(${args})${rets}`,
      info: doc.description ?? undefined,
    } satisfies Completion
  }),
  { label: 'fromRGB', type: 'function', detail: '(r, g, b) → int', info: 'Packs r/g/b (0-255) into a 0xRRGGBB colour int at compile time.' },
  { label: 'get_comp', type: 'function', detail: '(interfaceId, componentId) → int', info: 'Packs an interface id and component id into a component hash at compile time.' },
]

function cs2Completions(context: CompletionContext) {
  const word = context.matchBefore(/[A-Za-z_][A-Za-z0-9_]*/)
  if (!word || (word.from === word.to && !context.explicit)) return null
  return { from: word.from, options: OP_COMPLETIONS, validFor: /^[A-Za-z0-9_]*$/ }
}

// ---- colour swatches: fromRGB(r, g, b) calls get an inline swatch that opens a picker ----

const RGB_RE = /fromRGB\((\d+), (\d+), (\d+)\)/g

class SwatchWidget extends WidgetType {
  readonly r: number
  readonly g: number
  readonly b: number

  constructor(r: number, g: number, b: number) {
    super()
    this.r = r
    this.g = g
    this.b = b
  }
  override eq(other: SwatchWidget) { return other.r === this.r && other.g === this.g && other.b === this.b }
  override toDOM() {
    const span = document.createElement('span')
    span.className = 'cs2-swatch'
    span.style.background = `rgb(${this.r}, ${this.g}, ${this.b})`
    span.title = 'Click to pick a colour'
    return span
  }
  override ignoreEvent() { return false }
}

const swatchMatcher = new MatchDecorator({
  regexp: RGB_RE,
  // add the swatch AFTER the call text rather than replacing it: cc_setcolor(fromRGB(46, 43, 35))■
  decorate: (add, _from, to, m) =>
    add(to, to, Decoration.widget({ widget: new SwatchWidget(+m[1], +m[2], +m[3]), side: 1 })),
})

const swatchPlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet
  constructor(view: EditorView) { this.decorations = swatchMatcher.createDeco(view) }
  update(update: ViewUpdate) { this.decorations = swatchMatcher.updateDeco(update, this.decorations) }
}, {
  decorations: plugin => plugin.decorations,
  eventHandlers: {
    mousedown(event, view) {
      const target = event.target as HTMLElement
      if (!target.classList.contains('cs2-swatch')) return
      const pos = view.posAtDOM(target)
      const line = view.state.doc.lineAt(pos)
      RGB_RE.lastIndex = 0
      let m: RegExpExecArray | null
      let hit: { from: number, to: number } | null = null
      let start = '#000000'
      while ((m = RGB_RE.exec(line.text))) {
        const from = line.from + m.index
        const to = from + m[0].length
        if (pos >= from && pos <= to) {
          hit = { from, to }
          start = '#' + [+m[1], +m[2], +m[3]].map(v => v.toString(16).padStart(2, '0')).join('')
          break
        }
      }
      if (!hit) return
      const input = document.createElement('input')
      input.type = 'color'
      input.value = start
      input.style.position = 'fixed'
      input.style.left = `${(event as MouseEvent).clientX}px`
      input.style.top = `${(event as MouseEvent).clientY}px`
      input.style.opacity = '0'
      input.style.pointerEvents = 'none'
      document.body.appendChild(input)
      const range = hit
      const apply = () => {
        const r = parseInt(input.value.slice(1, 3), 16)
        const g = parseInt(input.value.slice(3, 5), 16)
        const b = parseInt(input.value.slice(5, 7), 16)
        const insert = `fromRGB(${r}, ${g}, ${b})`
        view.dispatch({ changes: { from: range.from, to: range.to, insert } })
        range.to = range.from + insert.length
      }
      input.addEventListener('input', apply)
      input.addEventListener('change', () => { apply(); input.remove() })
      input.click()
      event.preventDefault()
    },
  },
})

function makeHover(resolveScript?: (id: number) => Promise<string | null>) {
  return hoverTooltip(async (view, pos) => {
    const line = view.state.doc.lineAt(pos)
    const text = line.text
    const rel = pos - line.from
    const isWord = (ch: string) => /[A-Za-z0-9_@]/.test(ch)
    let s = rel, e = rel
    while (s > 0 && isWord(text[s - 1])) s--
    while (e < text.length && isWord(text[e])) e++
    if (s === e) return null
    const word = text.slice(s, e)

    let dom: HTMLElement | null = null
    const scriptRef = word.match(/^script_(\d+)$/)
    if (scriptRef && resolveScript) {
      const header = await resolveScript(parseInt(scriptRef[1], 10))
      if (header) {
        dom = document.createElement('div')
        dom.className = 'cs2-tooltip'
        const sig = document.createElement('div')
        sig.className = 'cs2-tooltip-sig'
        sig.textContent = header
        dom.appendChild(sig)
      }
    } else {
      dom = opTooltip(word)
    }
    if (!dom) return null
    const dom2 = dom
    return { pos: line.from + s, end: line.from + e, above: true, create: () => ({ dom: dom2 }) }
  })
}

// IDE-style editor for decompiled CS2 scripts. The TypeScript grammar is close enough to the
// decompiled syntax (docs/cs2.md) for highlighting; Ctrl-F search comes with basicSetup.
// Fallback (asm-form) scripts get a banner with the reason they couldn't be structured.
// Saving writes the text back to unpacked/cs2; cryogen recompiles on repack and will reject
// text that doesn't compile, so a bad edit can't corrupt the cache silently.

interface CS2ViewerProps {
  script: CS2Script
  onSave: (data: CS2Script) => Promise<void> | void
  onDirtyChange?: (dirty: boolean) => void
  /** Resolves another script's header line for script_N hovers. */
  resolveScript?: (id: number) => Promise<string | null>
}

export function CS2Viewer({ script, onSave, onDirtyChange, resolveScript }: CS2ViewerProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const [isDirty, setIsDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!hostRef.current) return
    // structured source gets the grammar linter; asm fallback files have their own format
    const cs2Linter = script.isFallback ? [] : [
      lintGutter(),
      linter(view => lintCS2(view.state.doc.toString(), OP_DOCS) as Diagnostic[]),
    ]
    const view = new EditorView({
      doc: script.source,
      extensions: [
        basicSetup,
        cs2Linter,
        javascript({ typescript: true }),
        oneDark,
        autocompletion({ override: [cs2Completions] }),
        Prec.highest(keymap.of([{ key: 'Tab', run: acceptCompletion }])),
        // the dumped source is tab-indented — make Enter's auto-indent match
        indentUnit.of('	'),
        EditorState.tabSize.of(4),
        // fixed-position tooltips escape the editor's overflow clipping and flip below
        // the line automatically when there's no room above
        tooltips({ position: 'fixed', parent: document.body }),
        makeHover(resolveScript),
        swatchPlugin,
        EditorView.updateListener.of(update => {
          if (!update.docChanged) return
          const dirty = update.state.doc.toString() !== script.source
          setIsDirty(dirty)
          onDirtyChange?.(dirty)
        }),
      ],
      parent: hostRef.current,
    })
    viewRef.current = view
    setIsDirty(false)
    onDirtyChange?.(false)
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [script])

  function discard() {
    const view = viewRef.current
    if (!view) return
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: script.source } })
    setIsDirty(false)
    onDirtyChange?.(false)
  }

  async function save() {
    const view = viewRef.current
    if (!view) return
    setSaving(true)
    try {
      await onSave({ ...script, source: view.state.doc.toString() })
      setIsDirty(false)
      onDirtyChange?.(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="cs2-viewer">
      <div className="cs2-viewer-header">
        <h3>script_{script.id}</h3>
        <span className="cs2-viewer-hint">Ctrl-F to search · edits recompile on cache pack</span>
      </div>
      {script.isBinary && (
        <div className="cs2-fallback-banner">
          <strong>Binary data, not a script.</strong> This file holds raw bytecode — it isn't
          decompiled text and can't be edited or packed as-is. It's likely a stale leftover;
          delete it with Remove, or re-dump the cs2 entry from cryogen.
        </div>
      )}
      {script.isFallback && (
        <div className="cs2-fallback-banner">
          <strong>Assembly fallback.</strong> This script couldn't be decompiled to structured
          source yet ({script.fallbackReason ?? 'unknown reason'}). It's shown as instruction-level
          text — still fully editable and byte-identical through repack.
        </div>
      )}
      <div className="cs2-editor-host" ref={hostRef} />
      {isDirty && (
        <div className="save-bar">
          <span className="save-bar-label">Unsaved changes</span>
          <div className="save-bar-actions">
            <button type="button" className="save-bar-discard" onClick={discard} disabled={saving}>
              Discard
            </button>
            <button type="button" className="save-bar-save" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
