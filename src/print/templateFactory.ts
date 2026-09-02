export interface TableTemplateOptions {
  title?: string
  pageWidth?: number
}

export interface LinkTableSpec {
  varKey: string
  tableName: string
  fields: { fieldName: string; varKey: string }[]
  sumFields?: string[]
}

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
      content: `${spec.tableName || spec.varKey} detail`,
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
    const hasSum = Array.isArray(spec.sumFields) && spec.sumFields.length > 0
    elements.push({
      id: 'el-link-' + spec.varKey,
      type: 'table',
      variable: '@' + spec.varKey + '_rows',
      x: 40,
      y,
      width: pageWidth,
      height: 200,
      showHeader: true,
      showFooter: hasSum,
      tfootRepeat: false,
      autoPaginate: true,
      columnsVariable: '',
      footerDataVariable: hasSum ? '@' + spec.varKey + '_rows_footer' : '',
      columns: spec.fields.map((f) => ({ field: f.varKey, header: f.fieldName, width: colW })),
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
  const title = opts.title ?? 'Record List'
  const pageWidth = opts.pageWidth ?? 714
  const entries = Object.entries(fieldMap).filter(([, v]) => v && v !== '__count')

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
    name: 'Feishu Table Template',
    pages: [
      {
        id: 'page-1',
        elements,
      },
    ],
  }
}

function isImageLike(fieldName: string, varKey: string): boolean {
  const key = (fieldName + ' ' + varKey).toLowerCase()
  return /(图|图片|照片|凭证|附件|发票|截图|image|photo|pic|attachment|screenshot)/.test(key)
}

const PLACEHOLDER_IMG =
  'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTYwIiBoZWlnaHQ9IjEyMCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBmaWxsPSIjZjJmM2Y1Ii8+PHRleHQgeD0iNTAlIiB5PSI1NSUiIGZvbnQtc2l6ZT0iMTQiIGZpbGw9IiM4YzhjOGMiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGR5PSIuM2VtIj5JbWFnZSBwbGFjZWhvbGRlcjwvdGV4dD48L3N2Zz4='

export function buildLinkOnlyTemplate(
  linkTables: LinkTableSpec[],
  title?: string,
  skipTitle?: boolean,
): Record<string, unknown> {
  const pageWidth = 660
  const elements: Record<string, unknown>[] = []
  let y = 20
  if (title && !skipTitle) {
    elements.push({
      id: 'el-title',
      type: 'text',
      variable: '',
      content: title,
      x: 40,
      y,
      width: pageWidth,
      height: 32,
      style: {
        fontSize: 20,
        fontWeight: 'bold',
        textAlign: 'center',
        color: '#1d2129',
        backgroundColor: 'transparent',
      },
    })
    y += 52
  }
  appendLinkTables(elements, linkTables, y, pageWidth)
  return {
    id: 'feishu-link-template',
    name: title || 'Link Template',
    pages: [{ id: 'page-1', elements }],
  }
}

export function buildFieldTemplate(
  fieldMap: Record<string, string>,
  opts: { title?: string; skipTitle?: boolean } = {},
  linkTables: LinkTableSpec[] = [],
): Record<string, unknown> {
  const title = opts.title ?? 'Field Sheet'
  const skipTitle = opts.skipTitle ?? false
  const entries = Object.entries(fieldMap).filter(([, v]) => v && v !== '__count')
  const elements: Record<string, unknown>[] = []
  let y = 20
  if (!skipTitle) {
    elements.push({
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
    })
    y = 72
  }
  for (const [fieldName, varKey] of entries) {
    if (isImageLike(fieldName, varKey)) {
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
      elements.push({
        id: 'el-label-' + varKey,
        type: 'text',
        variable: '',
        content: `${fieldName}: `,
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
        content: `${fieldName}: @${varKey}`,
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
  appendLinkTables(elements, linkTables, y + 16, 660)
  return {
    id: 'feishu-field-template',
    name: title,
    pages: [{ id: 'page-1', elements }],
  }
}
