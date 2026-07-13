export type ParamRow = { key: string; isString: boolean; value: string }

export function toParamRows(params: Record<string, number | string> | undefined): ParamRow[] {
  if (!params) return []
  return Object.entries(params).map(([key, value]) => ({
    key,
    isString: typeof value === 'string',
    value: String(value),
  }))
}

export function paramRowsToRecord(rows: ParamRow[]): Record<string, number | string> | undefined {
  const params: Record<string, number | string> = {}
  for (const row of rows) {
    if (row.key === '') continue
    params[row.key] = row.isString ? row.value : (Number(row.value) || 0)
  }
  return Object.keys(params).length > 0 ? params : undefined
}
