// 飞书多维表格（侧边栏插件）数据接入层。
// 通过 @lark-base-open/js-sdk 读取「当前激活表」与「记录」，拍平为 vue-print-designer 的模板变量。
//
// API 已对照 node_modules/@lark-base-open/js-sdk/dist/index.d.ts 校准：
//  - 取字段列表：table.getFieldList(): Promise<IField[]>
//  - 字段名需异步取：field.getName(): Promise<string>
//  - 取选中记录：bitable.base.getSelection(): Promise<Selection>（单条 recordId，可空）
//  - 取当前表记录 ID：table.getRecordIdList(): Promise<string[]>（单表上限约 200 条）
//  - 取可打印文本：field.getCellString(recordId): Promise<string>（官方显示字符串）
//
// 关键修正（2026-08-30）：
//  - isInFeishu() 改为「异步探测能否与飞书宿主通信」。直接 import 的 bitable 单例在普通
//    浏览器里也存在，不能用来判定环境；必须用 getActiveTable() 带超时探测，浏览器里无
//    宿主会超时 → 判定为不在飞书。
//  - getSelection() 返回空 recordId 时不报错，自动回退读取「当前激活视图」记录并提示。
//
// 变量名映射（2026-08-30，方案 A）：
//  - vue-print-designer 的变量解析正则只认 /@([A-Za-z0-9_.-]+)/，中文字段名无法解析。
//  - 故把任意字段名映射为英文变量名（含中文→拼音），并向下层返回 fieldMap（字段名→变量名），
//    供界面展示「字段 → @变量名」对照，用户复制该变量名填到设计器属性面板即可。

import { bitable, FieldType } from '@lark-base-open/js-sdk'
import { pinyin } from 'pinyin-pro'

export interface FeishuVarsResult {
  vars: Record<string, unknown>
  /**
   * 逐行对象数组（每条记录一行），键为英文变量名，与模板表格 columns[].field 对应。
   * 供表格元素（variable:"@rows"）逐行渲染。单条记录时为长度为 1 的数组。
   */
  rows: Record<string, unknown>[]
  /** 非致命提示（如选空回退），用于状态栏，不污染模板变量 */
  note?: string
  /** 字段名 → 英文变量名映射，供界面展示与复制 */
  fieldMap?: Record<string, string>
}

// 是否能真正与飞书宿主通信（带缓存）。浏览器/非插件环境会因无宿主而超时 → false。
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

// 内部断言：不在飞书环境直接抛清晰错误，避免后续调用拿到空数据。
async function assertFeishu(): Promise<void> {
  if (!(await isInFeishu())) {
    throw new Error('当前不在飞书环境：请通过多维表格「自定义插件」打开本页面，再点从飞书读取。')
  }
}

// 把任意字段名映射为 vue-print-designer 支持的变量名（正则 /@([A-Za-z0-9_.-]+)/）。
//  - 纯英文/数字/下划线/点/横线且以字母开头：直接保留。
//  - 含中文/其他字符：中文段转拼音，非中文段保留，整体清洗为 snake_case 风格，首字符非字母补 f_ 前缀。
//  - 重名自动追加 _2/_3… 保证唯一。
function toVarKey(raw: string, used: Set<string>): string {
  const clean = (raw ?? '').trim()
  if (/^[A-Za-z][A-Za-z0-9_.-]*$/.test(clean)) return uniqueKey(clean, used)
  // 按中文段切分，中文转拼音、其余原样，再统一清洗。
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
  /** 当前激活表 tableId，用于选区变化时判断是否属于同一张表 */
  tableId: string
  fieldNames: string[]
  /** 字段名 → 英文变量名映射 */
  fieldMap: Record<string, string>
}

// —— 关联字段（场景 B：展开子表多行）相关结构 ——
// 一级：主表的某个关联字段。
export interface LinkFieldInfo {
  /** 主表关联字段名（如「销售明细」） */
  fieldName: string
  /** 该字段映射出的英文变量名（如 xiao_shou_ming_xi） */
  varKey: string
  type: 'SingleLink' | 'DuplexLink'
  /** 关联到的子表 tableId */
  tableId: string
  /** 关联子表名（如「出货明细」），用于 UI 展示 */
  tableName: string
}

// 二级：关联子表内的字段（不含关联字段本身，避免递归）。
export interface LinkSubFieldInfo {
  fieldName: string
  varKey: string
}

// 关联展开规格：告诉 readRecords 如何把某个主表关联字段拍平成「@<varKey>_rows」数组。
//  - varKey：主表关联字段的变量名
//  - tableId：关联子表 ID（用于 getTableById）
//  - subFields：要展开的二级子表字段变量名列表（顺序即表格列顺序）
export interface LinkExpandSpec {
  varKey: string
  tableId: string
  subFields: string[]
}

export async function getTableInfo(): Promise<TableInfo> {
  await assertFeishu()
  const table = await bitable.base.getActiveTable()
  const [tableName, fields] = await Promise.all([table.getName(), table.getFieldList()])
  const fieldNames = await Promise.all(fields.map((f) => f.getName()))
  const used = new Set<string>()
  const fieldMap: Record<string, string> = {}
  fieldNames.forEach((n) => (fieldMap[n] = toVarKey(n, used)))
  return { tableName, tableId: table.id, fieldNames, fieldMap }
}

// 读取指定记录（单条或批量），拍平为模板变量：
//  - vars：单值变量（文本/条码/图片元素用）。单条记录→标量；多条记录→取「首条」作为表头展示。
//  - rows：逐行对象数组（每条记录一行），键为英文变量名。供表格元素（variable:"@rows"）逐行渲染。
// 返回的 vars / rows 键已为英文变量名；fieldMap 记录原始字段名 → 变量名。
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

  // 按字段逐列读取（每列一条与 recordIds 等长的字符串数组）
  // 附件字段用 getAttachmentUrls 取图片 URL；其余用 getCellString 取可打印文本。
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

  // 逐行对象数组：每个对象 = 一条记录，键为英文变量名
  const rows = recordIds.map((_, j) => {
    const row: Record<string, unknown> = {}
    for (let i = 0; i < fields.length; i++) row[varKeys[i]] = matrix[i][j]
    return row
  })

  // 单值变量：单条记录→该条标量；多条记录→取首条作为表头展示（其余数据走 rows 表格）
  const vars: Record<string, unknown> = {}
  for (let i = 0; i < fields.length; i++) vars[varKeys[i]] = matrix[i][0]
  if (recordIds.length > 1) vars['__count'] = recordIds.length

  // —— 关联字段展开（场景 B）：把每条主记录关联的「子表多行」拍平成「@<varKey>_rows」数组 ——
  // 仅包含用户勾选的二级子表字段；主表字段不进入明细表（用户明确拒绝 Lookup 字段）。
  if (linkExpand.length) {
    // 主字段 varKey → field 对象，便于按变量名取到关联字段
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

      // 读取子表字段，建立「子表字段变量名 → {field, 是否附件}」映射
      const linkedFields = await linkedTable.getFieldList()
      const linkedNames = await Promise.all(linkedFields.map((f: any) => f.getName()))
      const linkedTypes = await Promise.all(linkedFields.map((f: any) => f.getType()))
      const subMap = new Map<string, { field: any; isAttachment: boolean }>()
      const subUsed = new Set<string>()
      for (let k = 0; k < linkedFields.length; k++) {
        // 跳过子表里的关联字段，避免递归/混淆
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
      // 注入形如 @xiao_shou_ming_xi_rows 的数组变量，供模板里 variable:"@xiao_shou_ming_xi_rows" 的表格逐行渲染
      vars[`${spec.varKey}_rows`] = subRows
    }
  }

  return { vars, rows, fieldMap }
}

// 读取「当前选中记录」；若无选中记录，回退读取当前激活视图的第 1 条并提示。
// linkExpand：关联字段展开规格（场景 B），为空则不展开关联子表。
export async function getSelectionVariables(linkExpand: LinkExpandSpec[] = []): Promise<FeishuVarsResult> {
  await assertFeishu()
  const selection = await bitable.base.getSelection()
  const recordId = selection.recordId
  if (recordId) {
    const { vars, rows, fieldMap } = await readRecords([recordId], linkExpand)
    return { vars, rows, fieldMap }
  }
  // 选空回退：读当前激活视图的记录（getRecordIdList 单表上限约 200 条）
  const table = await bitable.base.getActiveTable()
  const ids = await table.getRecordIdList()
  if (!ids.length) {
    throw new Error('当前表没有任何记录，无法读取。')
  }
  const { vars, rows, fieldMap } = await readRecords(ids.slice(0, 1), linkExpand)
  return {
    vars,
    rows,
    fieldMap,
    note: `未选中记录，已用当前视图第 1 条（共 ${ids.length} 条）。如需指定某条，请在表格选中该行后重读。`,
  }
}

// 读取指定 recordId 的记录（用于跟随选区变化刷新）。直接读该记录，不回退、不提示「未选中」。
export async function getRecordVariables(
  recordId: string,
  linkExpand: LinkExpandSpec[] = [],
): Promise<FeishuVarsResult> {
  await assertFeishu()
  const { vars, rows, fieldMap } = await readRecords([recordId], linkExpand)
  return { vars, rows, fieldMap }
}

// 监听选区变化（用户点击记录/单元格/切换表）。返回取消监听函数（无该能力时返回 undefined）。
// 飞书文档：event.data = { baseId, tableId, viewId, fieldId, recordId }，recordId 为当前激活记录。
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

// 批量：读取当前表全部记录（数组型变量，供模板表格逐行）。单表上限约 200 条。
export async function getAllRecordsVariables(linkExpand: LinkExpandSpec[] = []): Promise<FeishuVarsResult> {
  await assertFeishu()
  const table = await bitable.base.getActiveTable()
  const ids = await table.getRecordIdList()
  if (!ids.length) {
    throw new Error('当前表没有任何记录，无法读取。')
  }
  const { vars, rows, fieldMap } = await readRecords(ids, linkExpand)
  return {
    vars,
    rows,
    fieldMap,
    note: `已读取当前表全部 ${ids.length} 条记录（已生成逐行对象数组 @rows，供模板表格逐行渲染）。`,
  }
}

// 列出当前主表的所有关联字段（一级），含关联到的子表名，供「关联明细」面板勾选。
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
    } catch {
      /* 关联表读取失败不阻断主流程 */
    }
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

// 读取某个关联子表（二级）的可用字段，供用户在一级勾选后进一步勾选要展开的子字段。
// 跳过子表内的关联字段，避免递归/混乱。
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
