// Session-persistent CS2 data caches. One instance per opened cache root,
// shared across every interpreter run — without this, each gameframe repaint
// (every pointer-move of a resize drag) re-parsed all scripts and re-fetched
// every enum/param JSON through the FileSystem API, which is where the
// multi-second resize lag came from.

import type { Cs2Script } from './ast'

export type EnumDef = {
  keyTypeChar?: string
  valueTypeChar?: string
  defaultIntValue?: number
  defaultStringValue?: string
  values?: Record<string, unknown>
}

export class Cs2Cache {
  /** parsed scripts by id (null = missing or unparseable) */
  scripts = new Map<number, Cs2Script | null>()
  /** enum defs by id */
  enums = new Map<number, Promise<EnumDef | null>>()
  /** param tables by `<op>:<subjectId>` */
  params = new Map<string, Promise<Record<string, unknown>>>()
}
