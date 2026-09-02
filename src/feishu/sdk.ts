import { bitable, FieldType } from '@lark-base-open/js-sdk'
import { pinyin } from 'pinyin-pro'

export interface FeishuVarsResult {
  vars: Record<string, unknown>
  rows: Record<string, unknown>[]
  note?: string
  fieldMap?: Record<string, string>
}

let _feishuProbed: boolean | null = null
export async function isInFeishu(): Promise<boolean> {
  if (_feishuProbed !== null) return _feishuProbed
  try {
    await Promise.race([
      bitable.base.getActiveTable(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000)),
    ])
    _feishuProbed = true
  } catch {
    _feishuProbed = false
  }
  return _feishuProbed
}

async function assertFeishu(): Promise<void> {
  if (!(await isInFeishu())) {
    throw new Error('Not in Feishu. Open this page via the Bitable custom plugin.')
  }
}

// Feishu tenant key (team identifier), used to scope shared templates.
export async function getTenantKey(): Promise<string> {
  await assertFeishu()
  try {
    return (await bitable.bridge.getTenantKey()) || 'unknown-tenant'
  } catch {
    return 'unknown-tenant'
  }
}

function toVarKey(raw: string, used: Set<string>): string {
  const clean = (raw ?? '').trim()
  if (/^[A-Za-z][A-Za-z0-9_.-]*$/.test(clean)) return uniqueKey(clean, used)
  const segments = clean.split(/([\u4e00-\u9fa5]+)/)
  const parts = segments.map((seg) => {
    if (/^[\u4e00-\u9fa5]+$/.test(seg)) {
      return pinyin(seg, { toneType: 'none', type: 'string' }).replace(/\s+/g, '_')
    }
    return seg
  })
  const key = parts
    .join('')
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
  let finalKey = key || 'field'
  if (!/^[A-Za-z]/.test(finalKey)) finalKey = 'f_' + finalKey
  return uniqueKey(finalKey, used)
}

function uniqueKey(base: string, used: Set<string>): string {
  let k = base
  let i = 2
  while (used.has(k)) k = `${base}_${i++}`
  used.add(k)
  return k
}

export interface TableInfo {
  tableName: string
  tableId: string
  fieldNames: string[]
  fieldMap: Record<string, string>
  linkVarKeys: string[]
}

export interface LinkFieldInfo {
  fieldName: string
  varKey: string
  type: 'SingleLink' | 'DuplexLink'
  tableId: string
  tableName: string
}

export interface LinkSubFieldInfo {
  fieldName: string
  varKey: string
}

export interface LinkExpandSpec {
  varKey: string
  tableId: string
  subFields: string[]
  sumFields?: string[]
}

function parseNum(v: unknown): number {
  if (typeof v === 'number') return v
  const s = String(v ?? '').replace(/[^0-9.\-]/g, '')
  if (s === '' || s === '-' || s === '.') return NaN
  const n = Number(s)
  return isNaN(n) ? NaN : n
}

interface CellFormat {
  prefix: string
  suffix: string
  decimals: number
}

// 从该列已有单元格字符串反推显示格式（前缀、后缀、小数位）
function detectFormat(samples: unknown[]): CellFormat {
  for (const v of samples) {
    const s = String(v ?? '').trim()
    if (!s) continue
    const m = s.match(/^([^\d\-]*)(-?\d[\d,]*\.?\d*)([^\d]*)$/)
    if (m) {
      const prefix = m[1]
      const numPart = m[2]
      const suffix = m[3]
      const decimals = numPart.includes('.') ? numPart.split('.')[1].length : 0
      return { prefix, suffix, decimals }
    }
  }
  return { prefix: '', suffix: '', decimals: 2 }
}

function formatWith(n: number, fmt: CellFormat): string {
  if (!isFinite(n)) return ''
  const factor = Math.pow(10, fmt.decimals)
  const r = Math.round(n * factor) / factor
  return (
    fmt.prefix +
    r.toLocaleString('en-US', { minimumFractionDigits: fmt.decimals, maximumFractionDigits: fmt.decimals }) +
    fmt.suffix
  )
}

// 按指定的 sumFields 计算每列合计，生成 footer 行数组（与 body 同结构）
function computeFooter(
  subRows: Record<string, unknown>[],
  subFields: string[],
  sumFields: string[],
): Record<string, unknown>[] {
  const footerRow: Record<string, unknown> = {}
  let firstNonSum: string | null = null
  for (const f of subFields) {
    if (sumFields.includes(f)) {
      let total = 0
      let ok = false
      for (const row of subRows) {
        const n = parseNum(row[f])
        if (!isNaN(n)) {
          total += n
          ok = true
        }
      }
      const fmt = detectFormat(subRows.map((row) => row[f]))
      footerRow[f] = ok ? formatWith(total, fmt) : ''
    } else {
      if (firstNonSum === null) firstNonSum = f
      footerRow[f] = ''
    }
  }
  if (firstNonSum) footerRow[firstNonSum] = '合计'
  return [footerRow]
}

export async function getTableInfo(): Promise<TableInfo> {
  await assertFeishu()
  const table = await bitable.base.getActiveTable()
  const [tableName, fields] = await Promise.all([table.getName(), table.getFieldList()])
  const fieldNames = await Promise.all(fields.map((f) => f.getName()))
  const types = await Promise.all(fields.map((f) => f.getType()))
  const used = new Set<string>()
  const fieldMap: Record<string, string> = {}
  fieldNames.forEach((n) => (fieldMap[n] = toVarKey(n, used)))
  const linkVarKeys: string[] = []
  fieldNames.forEach((n, i) => {
    if (types[i] === FieldType.SingleLink || types[i] === FieldType.DuplexLink) {
      linkVarKeys.push(fieldMap[n])
    }
  })
  return { tableName, tableId: table.id, fieldNames, fieldMap, linkVarKeys }
}

async function readRecords(
  recordIds: string[],
  linkExpand: LinkExpandSpec[] = [],
): Promise<{ vars: Record<string, unknown>; rows: Record<string, unknown>[]; fieldMap: Record<string, string> }> {
  const table = await bitable.base.getActiveTable()
  const fields = await table.getFieldList()
  const names = await Promise.all(fields.map((f) => f.getName()))
  const types = await Promise.all(fields.map((f) => f.getType()))
  const used = new Set<string>()
  const varKeys = names.map((n) => toVarKey(n, used))
  const fieldMap: Record<string, string> = {}
  names.forEach((n, i) => (fieldMap[n] = varKeys[i]))

  const matrix: string[][] = []
  for (let i = 0; i < fields.length; i++) {
    const isAttachment = types[i] === FieldType.Attachment
    const vals = await Promise.all(
      recordIds.map(async (rid) => {
        try {
          if (isAttachment) {
            const urls = await (fields[i] as any).getAttachmentUrls?.(rid)
            return Array.isArray(urls) && urls.length ? urls[0] : ''
          }
          return await fields[i].getCellString(rid)
        } catch {
          return ''
        }
      }),
    )
    matrix.push(vals)
  }

  const rows = recordIds.map((_, j) => {
    const row: Record<string, unknown> = {}
    for (let i = 0; i < fields.length; i++) row[varKeys[i]] = matrix[i][j]
    return row
  })

  const vars: Record<string, unknown> = {}
  for (let i = 0; i < fields.length; i++) vars[varKeys[i]] = matrix[i][0]
  if (recordIds.length > 1) vars['__count'] = recordIds.length

  if (linkExpand.length) {
    const fieldByVarKey = new Map<string, any>()
    for (let i = 0; i < fields.length; i++) fieldByVarKey.set(varKeys[i], fields[i])

    for (const spec of linkExpand) {
      const mainField = fieldByVarKey.get(spec.varKey)
      if (!mainField || !spec.tableId || !spec.subFields.length) continue
      let linkedTable: any = null
      try {
        linkedTable = await bitable.base.getTableById(spec.tableId)
      } catch {
        linkedTable = null
      }
      if (!linkedTable) continue

      const linkedFields = await linkedTable.getFieldList()
      const linkedNames = await Promise.all(linkedFields.map((f: any) => f.getName()))
      const linkedTypes = await Promise.all(linkedFields.map((f: any) => f.getType()))
      const subMap = new Map<string, { field: any; isAttachment: boolean }>()
      const subUsed = new Set<string>()
      for (let k = 0; k < linkedFields.length; k++) {
        if (linkedTypes[k] === FieldType.SingleLink || linkedTypes[k] === FieldType.DuplexLink) continue
        const sk = toVarKey(linkedNames[k], subUsed)
        subMap.set(sk, { field: linkedFields[k], isAttachment: linkedTypes[k] === FieldType.Attachment })
      }

      const subRows: Record<string, unknown>[] = []
      for (const rid of recordIds) {
        let linkVal: any = null
        try {
          linkVal = await mainField.getValue(rid)
        } catch {
          linkVal = null
        }
        const linkedIds: string[] = Array.isArray(linkVal?.recordIds) ? linkVal.recordIds : []
        for (const lid of linkedIds) {
          const row: Record<string, unknown> = {}
          for (const subVarKey of spec.subFields) {
            const sub = subMap.get(subVarKey)
            if (!sub) continue
            try {
              if (sub.isAttachment) {
                const urls = await sub.field.getAttachmentUrls?.(lid)
                row[subVarKey] = Array.isArray(urls) && urls.length ? urls[0] : ''
              } else {
                row[subVarKey] = await sub.field.getCellString(lid)
              }
            } catch {
              row[subVarKey] = ''
            }
          }
          subRows.push(row)
        }
      }
      vars[`${spec.varKey}_rows`] = subRows
      if (spec.sumFields && spec.sumFields.length && subRows.length) {
        vars[`${spec.varKey}_rows_footer`] = computeFooter(subRows, spec.subFields, spec.sumFields)
      }
    }
  }

  return { vars, rows, fieldMap }
}

export async function getSelectionVariables(linkExpand: LinkExpandSpec[] = []): Promise<FeishuVarsResult> {
  await assertFeishu()
  const selection = await bitable.base.getSelection()
  const recordId = selection.recordId
  if (recordId) {
    const { vars, rows, fieldMap } = await readRecords([recordId], linkExpand)
    return { vars, rows, fieldMap }
  }

  const table = await bitable.base.getActiveTable()
  const ids = await table.getRecordIdList()
  if (!ids.length) {
    throw new Error('No records in current table.')
  }

  const { vars, rows, fieldMap } = await readRecords(ids.slice(0, 1), linkExpand)
  return {
    vars,
    rows,
    fieldMap,
    note: `No active record detected. Please click a row (not checkbox) to activate. Using first visible record as fallback (${ids.length} total).`,
  }
}

export async function getRecordVariables(
  recordId: string,
  linkExpand: LinkExpandSpec[] = [],
): Promise<FeishuVarsResult> {
  await assertFeishu()
  const { vars, rows, fieldMap } = await readRecords([recordId], linkExpand)
  return { vars, rows, fieldMap }
}

export function onSelectionChange(
  cb: (e: {
    data: { baseId: string | null; tableId: string | null; viewId: string | null; fieldId: string | null; recordId: string | null }
  }) => void,
): (() => void) | undefined {
  try {
    return bitable.base.onSelectionChange(cb as any) as (() => void) | undefined
  } catch {
    return undefined
  }
}

export async function getAllRecordsVariables(linkExpand: LinkExpandSpec[] = []): Promise<FeishuVarsResult> {
  await assertFeishu()
  const table = await bitable.base.getActiveTable()
  const ids = await table.getRecordIdList()
  if (!ids.length) {
    throw new Error('No records in current table.')
  }
  const { vars, rows, fieldMap } = await readRecords(ids, linkExpand)
  return {
    vars,
    rows,
    fieldMap,
    note: `Loaded all ${ids.length} records into @rows.`,
  }
}

export async function getLinkFields(): Promise<LinkFieldInfo[]> {
  await assertFeishu()
  const table = await bitable.base.getActiveTable()
  const fields = await table.getFieldList()
  const names = await Promise.all(fields.map((f) => f.getName()))
  const types = await Promise.all(fields.map((f) => f.getType()))
  const used = new Set<string>()
  const result: LinkFieldInfo[] = []
  for (let i = 0; i < fields.length; i++) {
    const t = types[i]
    if (t !== FieldType.SingleLink && t !== FieldType.DuplexLink) continue
    const varKey = toVarKey(names[i], used)
    let tableId = ''
    let tableName = ''
    try {
      tableId = await (fields[i] as any).getTableId()
      if (tableId) {
        const lt = await bitable.base.getTableById(tableId)
        tableName = await lt.getName()
      }
    } catch {}
    result.push({
      fieldName: names[i],
      varKey,
      type: t === FieldType.SingleLink ? 'SingleLink' : 'DuplexLink',
      tableId,
      tableName,
    })
  }
  return result
}

export async function getLinkSubFields(tableId: string): Promise<LinkSubFieldInfo[]> {
  await assertFeishu()
  const table = await bitable.base.getTableById(tableId)
  const fields = await table.getFieldList()
  const names = await Promise.all(fields.map((f) => f.getName()))
  const types = await Promise.all(fields.map((f) => f.getType()))
  const used = new Set<string>()
  const result: LinkSubFieldInfo[] = []
  for (let i = 0; i < fields.length; i++) {
    if (types[i] === FieldType.SingleLink || types[i] === FieldType.DuplexLink) continue
    result.push({ fieldName: names[i], varKey: toVarKey(names[i], used) })
  }
  return result
}
