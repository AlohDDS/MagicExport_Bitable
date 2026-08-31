// 根据飞书字段映射（字段名 → 英文变量名）动态生成「表格型」模板。
//
// 为什么需要它：表格元素 columns[].field 必须与注入的逐行对象键名完全一致，
// 否则表格渲染不出数据。飞书字段经 toVarKey() 映射后的键名（拼音化）无法预先固定，
// 因此「读取当前表」时按当前表的 fieldMap 现场生成表头，保证列与 @rows 严格对齐。
//
// 生成的模板：顶部一个标题文本 + 一个 variable:"@rows" 的表格，列 = 当前全部字段。

export interface TableTemplateOptions {
  /** 标题文本（静态展示用，不依赖变量） */
  title?: string
  /** 页面可用宽度（px），用于分摊列宽，默认 714 */
  pageWidth?: number
}

// 关联字段展开生成的「明细大表」规格（场景 B）。
//  - varKey：主表关联字段的变量名（如 xiao_shou_ming_xi），明细表绑定 @<varKey>_rows
//  - tableName：关联子表名（如「出货明细」），用于二级标题
//  - fields：要展开的二级子表字段（字段名 → 变量名），作为明细表列
export interface LinkTableSpec {
  varKey: string
  tableName: string
  fields: { fieldName: string; varKey: string }[]
}

// 把关联明细表（LinkTableSpec[]）追加到 elements：每个规格生成一个二级标题 + 一个 @<varKey>_rows 表格。
// 返回追加后的下一个可用 y 坐标。
function appendLinkTables(
  elements: Record<string, unknown>[],
  linkTables: LinkTableSpec[],
  startY: number,
  pageWidth: number,
): number {
  let y = startY
  for (const spec of linkTables) {
    if (!spec.fields.length) continue
    const n = Math.max(1, spec.fields.length)
    const rawW = Math.floor(pageWidth / n)
    const colW = Math.min(180, Math.max(60, rawW))
    elements.push({
      id: 'el-link-title-' + spec.varKey,
      type: 'text',
      variable: '',
      content: `${spec.tableName || spec.varKey} 明细`,
      x: 40,
      y,
      width: pageWidth,
      height: 28,
      style: {
        fontSize: 16,
        fontWeight: 'bold',
        textAlign: 'left',
        color: '#1d2129',
        backgroundColor: 'transparent',
      },
    })
    y += 36
    elements.push({
      id: 'el-link-' + spec.varKey,
      type: 'table',
      variable: '@' + spec.varKey + '_rows',
      x: 40,
      y,
      width: pageWidth,
      height: 200,
      showHeader: true,
      showFooter: false,
      tfootRepeat: false,
      autoPaginate: true,
      columnsVariable: '',
      footerDataVariable: '',
      columns: spec.fields.map((f) => ({ field: f.varKey, header: f.fieldName, width: colW })),
      // 设计期留空；运行时由 @<varKey>_rows 逐行填充
      data: [],
      style: {
        headerHeight: 36,
        rowHeight: 30,
        borderColor: '#c9cdd4',
        borderWidth: 1,
        fontSize: 12,
        textAlign: 'left',
        color: '#1d2129',
        backgroundColor: 'transparent',
      },
    })
    y += 200 + 24
  }
  return y
}

export function buildTableTemplate(
  fieldMap: Record<string, string>,
  opts: TableTemplateOptions = {},
  linkTables: LinkTableSpec[] = [],
): Record<string, unknown> {
  const title = opts.title ?? '记录清单'
  const pageWidth = opts.pageWidth ?? 714
  const entries = Object.entries(fieldMap).filter(([, v]) => v && v !== '__count')

  // 列宽分摊：尽量均分，单列限制在 [60, 180]
  const n = Math.max(1, entries.length)
  const rawW = Math.floor(pageWidth / n)
  const colW = Math.min(180, Math.max(60, rawW))

  const columns = entries.map(([fieldName, varKey]) => ({
    field: varKey,
    header: fieldName,
    width: colW,
  }))

  const titleEl = {
    id: 'el-title',
    type: 'text',
    variable: '',
    content: title,
    x: 40,
    y: 20,
    width: pageWidth,
    height: 32,
    style: {
      fontSize: 20,
      fontWeight: 'bold',
      textAlign: 'center',
      color: '#1d2129',
      backgroundColor: 'transparent',
    },
  }
  const tableEl = {
    id: 'el-table',
    type: 'table',
    variable: '@rows',
    x: 40,
    y: 72,
    width: pageWidth,
    height: 200,
    showHeader: true,
    showFooter: false,
    tfootRepeat: false,
    autoPaginate: true,
    columnsVariable: '',
    footerDataVariable: '',
    columns,
    data: [],
    style: {
      headerHeight: 36,
      rowHeight: 30,
      borderColor: '#c9cdd4',
      borderWidth: 1,
      fontSize: 12,
      textAlign: 'left',
      color: '#1d2129',
      backgroundColor: 'transparent',
    },
  }
  const elements: Record<string, unknown>[] = [titleEl, tableEl]
  let y = 72 + 200 + 24
  y = appendLinkTables(elements, linkTables, y, pageWidth)

  return {
    id: 'feishu-table-template',
    name: '飞书表格模板（自动生成）',
    data: {
      pages: [
        {
          id: 'page-1',
          elements,
        },
      ],
    },
  }
}

// 判断一个字段是否应作为图片元素渲染（字段名/变量名含图片、凭证、附件、照片等关键字）
function isImageLike(fieldName: string, varKey: string): boolean {
  const key = (fieldName + ' ' + varKey).toLowerCase()
  return /(图|图片|照片|凭证|附件|发票|截图|image|photo|pic|attachment|screenshot)/.test(key)
}

// 图片元素的占位显示（设计期没数据时展示）
const PLACEHOLDER_IMG =
  'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTYwIiBoZWlnaHQ9IjEyMCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBmaWxsPSIjZjJmM2Y1Ii8+PHRleHQgeD0iNTAlIiB5PSI1NSUiIGZvbnQtc2l6ZT0iMTQiIGZpbGw9IiM4YzhjOGMiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGR5PSIuM2VtIj7nlLTmoKHmiYvnkIY8L3RleHQ+PC9zdmc+'

// 根据飞书字段映射生成「单条记录」单据模板：每个字段一行「字段名：@变量名」，
// content 内联 @变量名 占位，保证解析后显示「字段名：值」。元素 schema 与
// vue-print-designer 加载器兼容（id/type/x/y/width/height/style 齐全）。
// 对图片/附件类字段会生成 image 元素并自动绑定对应 @变量名。
export function buildFieldTemplate(
  fieldMap: Record<string, string>,
  opts: { title?: string } = {},
  linkTables: LinkTableSpec[] = [],
): Record<string, unknown> {
  const title = opts.title ?? '字段单据（自动生成）'
  const entries = Object.entries(fieldMap).filter(([, v]) => v && v !== '__count')
  const elements: Record<string, unknown>[] = [
    {
      id: 'el-title',
      type: 'text',
      variable: '',
      content: title,
      x: 40,
      y: 20,
      width: 660,
      height: 32,
      style: {
        fontSize: 20,
        fontWeight: 'bold',
        textAlign: 'center',
        color: '#1d2129',
        backgroundColor: 'transparent',
      },
    },
  ]
  let y = 72
  for (const [fieldName, varKey] of entries) {
    if (isImageLike(fieldName, varKey)) {
      // 图片元素：variable 绑定 @varKey，设计期显示占位图
      elements.push({
        id: 'el-' + varKey,
        type: 'image',
        variable: '@' + varKey,
        content: PLACEHOLDER_IMG,
        x: 120,
        y,
        width: 160,
        height: 120,
        style: {
          objectFit: 'contain',
          borderWidth: 0,
          backgroundColor: 'transparent',
        },
      })
      // 在图片上方加字段名标签
      elements.push({
        id: 'el-label-' + varKey,
        type: 'text',
        variable: '',
        content: `${fieldName}：`,
        x: 40,
        y: y + 48,
        width: 70,
        height: 24,
        style: {
          fontSize: 14,
          textAlign: 'right',
          color: '#1d2129',
          backgroundColor: 'transparent',
        },
      })
      y += 136
    } else {
      elements.push({
        id: 'el-' + varKey,
        type: 'text',
        variable: '@' + varKey,
        content: `${fieldName}：@${varKey}`,
        x: 40,
        y,
        width: 660,
        height: 26,
        style: {
          fontSize: 14,
          textAlign: 'left',
          color: '#1d2129',
          backgroundColor: 'transparent',
        },
      })
      y += 32
    }
  }
  // 追加关联明细表（场景 B）：在字段单据下方另起段落，主表字段不混入明细表
  appendLinkTables(elements, linkTables, y + 16, 660)
  return {
    id: 'feishu-field-template',
    name: title,
    data: { pages: [{ id: 'page-1', elements }] },
  }
}
