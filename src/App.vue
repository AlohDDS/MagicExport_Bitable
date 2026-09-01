<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useDesigner } from './print/useDesigner'
import { localTemplateRepo, type TemplateRepo } from './data/templateRepo'
import { createSupabaseRepo, supabaseConfigured } from './data/supabaseRepo'
import { buildTableTemplate, buildFieldTemplate, buildLinkOnlyTemplate, type LinkTableSpec } from './print/templateFactory'
import {
  getSelectionVariables,
  getRecordVariables,
  getAllRecordsVariables,
  getTableInfo,
  getTenantKey,
  isInFeishu,
  onSelectionChange,
  getLinkFields,
  getLinkSubFields,
  type LinkFieldInfo,
  type LinkSubFieldInfo,
  type LinkExpandSpec,
} from './feishu/sdk'

const TEMPLATE_NAME = 'default'

const { el, ready, markReady, setBranding, setTheme, applyData, loadTemplateData, getTemplateData } =
  useDesigner()

const status = ref('初始化设计器…')
const theme = ref<'light' | 'dark'>('light')
const inFeishu = ref(false)
const fieldMap = ref<Record<string, string>>({})
const showVars = ref(false)
const lastData = ref<Record<string, unknown>>({})
const lastFieldMap = ref<Record<string, string>>({})
const diagText = ref('')
const showDiag = ref(false)
const currentTableName = ref('')
const currentTableId = ref('')
const noSelection = ref(false)
const linkVarKeys = ref<string[]>([])

// Template management (sidebar list + Supabase team-shared storage).
const templateRepo = ref<TemplateRepo>(localTemplateRepo)
const showTplPanel = ref(false)
const tplName = ref('')
const tplList = ref<string[]>([])
const tplBusy = ref(false)
const tplError = ref('')
const tplMsg = ref('')

const displayFieldMap = computed<Record<string, string>>(() => {
  const out: Record<string, string> = {}
  for (const [fn, vk] of Object.entries(fieldMap.value)) {
    out[fn] = linkVarKeys.value.includes(vk) ? vk + '_rows' : vk
  }
  return out
})

let lastSelRecordId = ''
let selTimer: ReturnType<typeof setTimeout> | null = null
let offSelection: (() => void) | undefined = undefined

const showLinkPanel = ref(false)
const linkFields = ref<LinkFieldInfo[]>([])
const linkSubFieldMap = ref<Record<string, LinkSubFieldInfo[]>>({})
const checkedLinks = ref<Record<string, { fieldName: string; tableName: string; tableId: string; subFields: string[] }>>({})
const linkBusy = ref(false)
const linkError = ref('')
const currentLinkExpand = computed<LinkExpandSpec[]>(() => {
  const arr: LinkExpandSpec[] = []
  for (const vk of Object.keys(checkedLinks.value)) {
    const c = checkedLinks.value[vk]
    const subMap = new Map((linkSubFieldMap.value[vk] ?? []).map((s) => [s.varKey, s]))
    const subs = c.subFields.filter((vk2) => subMap.has(vk2)).map((vk2) => subMap.get(vk2)!.varKey)
    if (!subs.length) continue
    arr.push({ varKey: vk, tableId: c.tableId, subFields: subs })
  }
  return arr
})

function log(msg: string, ok = true) {
  status.value = (ok ? '✓ ' : '✗ ') + msg
  console.log('[plugin]', msg)
}

function atVar(v: string): string {
  return '@' + v
}

async function copyVar(v: string) {
  try {
    await navigator.clipboard.writeText('@' + v)
    log('已复制 @' + v)
  } catch {
    log('复制失败，请手动复制：@' + v, false)
  }
}

function stripAt(v: string): string {
  const t = (v ?? '').trim()
  return t.startsWith('@') ? t.slice(1).trim() : t
}

async function initDesigner() {
  const node = el.value as unknown as HTMLElement & {
    addEventListener: (t: string, cb: (e?: any) => void) => void
  }
  node.addEventListener('ready', () => {
    markReady()
    log('设计器就绪')
  })
  node.addEventListener('error', (e: any) => {
    log('设计器错误：' + (e?.detail?.error?.message ?? '未知错误'), false)
  })
  node.addEventListener('exported', (e: any) => {
    if (e?.detail?.blob) log('导出完成')
  })
  setBranding({ title: '记录视图打印', showLogo: true })
  setTheme(theme.value)
  inFeishu.value = await isInFeishu()
  log(inFeishu.value ? '已识别飞书环境' : '非飞书环境（请通过多维表格自定义插件打开）')
  if (inFeishu.value) {
    try {
      const info = await getTableInfo()
      fieldMap.value = info.fieldMap
      currentTableName.value = info.tableName
      currentTableId.value = info.tableId
      linkVarKeys.value = info.linkVarKeys
      restoreLinkCfg()
    } catch {}
    try {
      offSelection = onSelectionChange(onFeishuSelectionChange)
    } catch {}
    try {
      if (supabaseConfigured()) {
        const tk = await getTenantKey()
        templateRepo.value = createSupabaseRepo(tk, currentTableId.value)
        log('模板存储：Supabase（团队共享）')
      } else {
        templateRepo.value = localTemplateRepo
        log('模板存储：浏览器本地（未配置 Supabase）')
      }
    } catch {
      templateRepo.value = localTemplateRepo
    }
  }
  let hasSavedTemplate = false
  try {
    const saved = await templateRepo.value.load(TEMPLATE_NAME)
    if (saved) {
      loadTemplateData(saved)
      hasSavedTemplate = true
    }
  } catch {}
  await refreshTemplates()
  if (inFeishu.value) await autoLoadOnOpen(hasSavedTemplate)
}

async function ensureLinkSubFields() {
  const vks = Object.keys(checkedLinks.value).filter(
    (vk) => !linkSubFieldMap.value[vk] && checkedLinks.value[vk]?.tableId,
  )
  await Promise.all(
    vks.map((vk) =>
      getLinkSubFields(checkedLinks.value[vk].tableId)
        .then((subs) => {
          linkSubFieldMap.value = { ...linkSubFieldMap.value, [vk]: subs }
        })
        .catch(() => {}),
    ),
  )
}

async function autoLoadOnOpen(hasSavedTemplate: boolean) {
  await ensureLinkSubFields()
  if (!inFeishu.value) return
  try {
    if (hasSavedTemplate) {
      await injectSelectionOnly()
    } else if (currentLinkExpand.value.length) {
      await generateLinkTemplate()
    } else {
      await generateFieldTemplate()
    }
  } catch (e: any) {
    log('打开时自动加载失败：' + (e?.message ?? e), false)
  }
}

function onFeishuSelectionChange(event: {
  data: { tableId: string | null; recordId: string | null; fieldId: string | null; viewId: string | null; baseId: string | null }
}) {
  const data = event?.data ?? ({} as any)
  const tableId = data.tableId ?? null
  const recordId = data.recordId ?? null
  if (tableId && currentTableId.value && tableId !== currentTableId.value) return
  if (recordId && recordId === lastSelRecordId) return
  lastSelRecordId = recordId ?? ''
  if (!recordId) return
  if (selTimer) clearTimeout(selTimer)
  selTimer = setTimeout(() => followSelection(recordId), 300)
}

async function followSelection(recordId: string) {
  if (!inFeishu.value) return
  try {
    const { vars, rows, fieldMap: fm } = await getRecordVariables(recordId, currentLinkExpand.value)
    const data = { ...vars, rows }
    lastData.value = data
    lastFieldMap.value = fm ?? {}
    if (fm) fieldMap.value = fm
    noSelection.value = false
    applyData(data, { merge: true })
    log(`已跟随选区：记录 ${recordId}（${Object.keys(vars).length} 个字段）`)
  } catch (e: any) {
    log('跟随选区失败：' + (e?.message ?? e), false)
  }
}

async function injectSelectionOnly() {
  const { vars, rows, note, fieldMap: fm } = await getSelectionVariables(currentLinkExpand.value)
  const data = { ...vars, rows }
  lastData.value = data
  lastFieldMap.value = fm ?? {}
  if (fm) fieldMap.value = fm
  noSelection.value = !!note && note.startsWith('No active record')
  applyData(data, { merge: true })
  log(note ? `已加载（${note}）` : `已加载 ${Object.keys(vars).length} 个字段`)
}

function notInFeishu(): boolean {
  if (inFeishu.value) return false
  log('非飞书环境，请通过多维表格自定义插件打开。', false)
  return true
}

async function loadFromFeishu() {
  if (notInFeishu()) return
  try {
    const { vars, rows, note, fieldMap: fm } = await getSelectionVariables(currentLinkExpand.value)
    noSelection.value = !!note && note.startsWith('No active record')
    const data = { ...vars, rows }
    if (currentLinkExpand.value.length && !templateHasLinkTables(currentLinkExpand.value)) {
      const specs = buildLinkSpecs()
      if (specs.length) {
        loadTemplateData(buildFieldTemplate(fm ?? {}, { title: currentTableName.value || '字段单据' }, specs))
      }
    }
    lastData.value = data
    lastFieldMap.value = fm ?? {}
    if (fm) fieldMap.value = fm
    applyData(data, { merge: true })
    log(note ? `已从飞书加载（${note}）` : `已加载 ${Object.keys(vars).length} 个字段`)
  } catch (e: any) {
    log('从飞书读取失败：' + (e?.message ?? e), false)
  }
}

async function loadAllFromFeishu() {
  if (notInFeishu()) return
  noSelection.value = false
  try {
    const { vars, rows, note, fieldMap: fm } = await getAllRecordsVariables(currentLinkExpand.value)
    const data = { ...vars, rows }
    lastData.value = data
    lastFieldMap.value = fm ?? {}
    if (fm) fieldMap.value = fm
    if (fm) loadTemplateData(buildTableTemplate(fm))
    applyData(data, { merge: true })
    log(note ?? `已加载全部 ${rows.length} 行到 @rows`)
  } catch (e: any) {
    log('加载全部失败：' + (e?.message ?? e), false)
  }
}

async function generateFieldTemplate() {
  if (notInFeishu()) return
  try {
    const info = await getTableInfo()
    if (!info.fieldMap || !Object.keys(info.fieldMap).length) {
      log('无可用字段', false)
      return
    }
    fieldMap.value = info.fieldMap
    lastFieldMap.value = info.fieldMap
    linkVarKeys.value = info.linkVarKeys
    loadTemplateData(buildFieldTemplate(info.fieldMap, { title: info.tableName || '字段单据' }))
    const { vars, rows, note, fieldMap: fm } = await getSelectionVariables(currentLinkExpand.value)
    const data = { ...vars, rows }
    lastData.value = data
    if (fm) fieldMap.value = fm
    applyData(data, { merge: true })
    noSelection.value = !!note
    log(
      note
        ? `已生成字段单据（${Object.keys(info.fieldMap).length} 个字段，${note}）`
        : `已生成字段单据（${Object.keys(info.fieldMap).length} 个字段）`,
    )
  } catch (e: any) {
    log('生成字段单据失败：' + (e?.message ?? e), false)
  }
}

async function openLinkPanel() {
  if (notInFeishu()) return
  linkError.value = ''
  showLinkPanel.value = true
  linkBusy.value = true
  try {
    linkFields.value = await getLinkFields()
    if (!linkFields.value.length) {
      linkError.value = '当前表无关联字段。'
    }
  } catch (e: any) {
    linkError.value = '读取关联字段失败：' + (e?.message ?? e)
  } finally {
    linkBusy.value = false
  }
}

async function toggleLinkField(info: LinkFieldInfo) {
  const cur = checkedLinks.value[info.varKey]
  if (cur) {
    const next = { ...checkedLinks.value }
    delete next[info.varKey]
    checkedLinks.value = next
    return
  }
  if (!linkSubFieldMap.value[info.varKey]) {
    linkBusy.value = true
    try {
      const subs = await getLinkSubFields(info.tableId)
      linkSubFieldMap.value = { ...linkSubFieldMap.value, [info.varKey]: subs }
    } catch (e: any) {
      linkError.value = '读取子字段失败：' + (e?.message ?? e)
      return
    } finally {
      linkBusy.value = false
    }
  }
  checkedLinks.value = {
    ...checkedLinks.value,
    [info.varKey]: { fieldName: info.fieldName, tableName: info.tableName, tableId: info.tableId, subFields: [] },
  }
}

function toggleSubField(varKey: string, subVarKey: string) {
  const cur = checkedLinks.value[varKey]
  if (!cur) return
  const set = new Set(cur.subFields)
  if (set.has(subVarKey)) set.delete(subVarKey)
  else set.add(subVarKey)
  checkedLinks.value = {
    ...checkedLinks.value,
    [varKey]: { ...cur, subFields: [...set] },
  }
}

const LS_PREFIX = 'vpd-linkcfg:'
function linkCfgKey(): string {
  return LS_PREFIX + (currentTableName.value || 'default')
}
function saveLinkCfg() {
  if (!currentTableName.value) return
  try {
    localStorage.setItem(linkCfgKey(), JSON.stringify(checkedLinks.value))
  } catch {}
}
function restoreLinkCfg() {
  if (!currentTableName.value) return
  try {
    const raw = localStorage.getItem(linkCfgKey())
    if (!raw) return
    const cfg = JSON.parse(raw) as Record<string, { fieldName: string; tableName: string; tableId: string; subFields: string[] }>
    for (const vk of Object.keys(cfg)) {
      const c = cfg[vk]
      if (!linkSubFieldMap.value[vk] && c.tableId) {
        getLinkSubFields(c.tableId)
          .then((subs) => {
            linkSubFieldMap.value = { ...linkSubFieldMap.value, [vk]: subs }
          })
          .catch(() => {})
      }
    }
    checkedLinks.value = cfg
  } catch {}
}
watch(checkedLinks, () => saveLinkCfg(), { deep: true })

function templateHasLinkTables(specs: LinkExpandSpec[]): boolean {
  if (!specs.length) return true
  const pages = getTemplatePages()
  const need = new Set(specs.map((s) => '@' + s.varKey + '_rows'))
  let found = 0
  for (const p of pages) for (const el of p.elements ?? []) if (el.type === 'table' && need.has(el.variable)) found++
  return found === specs.length
}

function buildLinkSpecs(): LinkTableSpec[] {
  const specs: LinkTableSpec[] = []
  for (const vk of Object.keys(checkedLinks.value)) {
    const c = checkedLinks.value[vk]
    const subMap = new Map((linkSubFieldMap.value[vk] ?? []).map((s) => [s.varKey, s]))
    const subs = c.subFields
      .filter((vk2) => subMap.has(vk2))
      .map((vk2) => { const s = subMap.get(vk2)!; return { fieldName: s.fieldName, varKey: s.varKey } })
    if (subs.length) specs.push({ varKey: vk, tableName: c.tableName, fields: subs })
  }
  return specs
}

async function generateLinkTemplate() {
  if (notInFeishu()) return
  const specs: LinkTableSpec[] = []
  const expand: LinkExpandSpec[] = []
  for (const vk of Object.keys(checkedLinks.value)) {
    const c = checkedLinks.value[vk]
    const subMap = new Map((linkSubFieldMap.value[vk] ?? []).map((s) => [s.varKey, s]))
    const fields = c.subFields
      .filter((vk2) => subMap.has(vk2))
      .map((vk2) => { const s = subMap.get(vk2)!; return { fieldName: s.fieldName, varKey: s.varKey } })
    if (!fields.length) continue
    specs.push({ varKey: vk, tableName: c.tableName, fields })
    expand.push({ varKey: vk, tableId: c.tableId, subFields: fields.map((f) => f.varKey) })
  }
  if (!specs.length) {
    log('请至少选择一个关联字段和一个子字段。', false)
    return
  }
  try {
    const info = await getTableInfo()
    fieldMap.value = info.fieldMap
    lastFieldMap.value = info.fieldMap
    loadTemplateData(buildLinkOnlyTemplate(specs, info.tableName || '关联单据'))
    const { vars, rows, fieldMap: fm } = await getSelectionVariables(expand)
    const data = { ...vars, rows }
    lastData.value = data
    if (fm) fieldMap.value = fm
    applyData(data, { merge: true })
    log(`已生成含 ${specs.length} 个关联表的单据。`)
  } catch (e: any) {
    log('生成关联单据失败：' + (e?.message ?? e), false)
  }
}

function getTemplatePages(): any[] {
  const tpl = getTemplateData() as any
  if (!tpl) return []
  if (Array.isArray(tpl.pages)) return tpl.pages
  if (Array.isArray(tpl.data?.pages)) return tpl.data.pages
  if (Array.isArray(tpl.data?.data?.pages)) return tpl.data.data.pages
  return []
}

function summarizeTemplate(tpl: any): string {
  try {
    const s = JSON.stringify(tpl)
    return s.length > 400 ? s.slice(0, 400) + '…' : s
  } catch {
    return String(tpl)
  }
}

function diagnose() {
  const rawTpl = getTemplateData() as any
  const pages = getTemplatePages()
  const injected = lastData.value
  const injectedKeys = Object.keys(injected)
  const lines: string[] = []
  lines.push('[原始模板摘要]')
  lines.push('  ' + summarizeTemplate(rawTpl).replace(/\n/g, ' '))
  lines.push('')
  lines.push(`[已注入变量] 共 ${injectedKeys.length} 个`)
  for (const k of injectedKeys) {
    const v = injected[k]
    const sample = Array.isArray(v) ? `[数组 ${v.length} 行]` : String(v ?? '').slice(0, 80)
    lines.push(`  @${k} = ${sample}`)
  }
  lines.push('')
  lines.push('[元素绑定]')
  let idx = 0
  let mismatch = 0
  for (const page of pages) {
    for (const el of page.elements ?? []) {
      idx++
      const t = el.type
      const rawVar = el.variable ?? ''
      const key = stripAt(rawVar)
      const content = (el.content ?? '').replace(/@[\w.\-]+/g, '').trim()
      const val = key ? injected[key] : undefined
      let ok = false
      let note = ''
      if (t === 'table') {
        const isRowsVar = key === 'rows' || (key.endsWith('_rows') && key in injected)
        const arr = isRowsVar ? injected[key] : undefined
        ok = isRowsVar && Array.isArray(arr)
        if (ok) {
          const cnt = (arr as unknown[]).length
          note = key === 'rows' ? `表格→@rows ✓（${cnt} 行）` : `表格→@${key} ✓（${cnt} 行关联数据）`
        } else {
          note = key ? `表格变量 @${key} 未匹配` : '表格未绑定'
        }
      } else if (t === 'image') {
        ok = !!key && key in injected && typeof val === 'string' && /^https?:\/\//.test(val)
        if (ok) note = `@${key} 是图片地址 ✓`
        else if (key && key in injected) {
          note = `@${key} 已注入但不是图片地址（${String(val).slice(0, 60) || '（空）'}）`
          mismatch++
        } else {
          note = key ? `变量 @${key} 未注入` : '图片未绑定'
          mismatch++
        }
      } else {
        ok = !!key && key in injected
        if (!ok) {
          const hit = Object.entries(lastFieldMap.value).find(
            ([fn, vk]) => content === fn || (content && (content.includes(fn) || fn.includes(content))),
          )
          note = key ? `变量 @${key} 未注入` : '未绑定'
          if (hit) note += `（文本“${content}”疑似字段“${hit[0]}”，应使用 @${hit[1]}）`
          else if (content) note += `（文本“${content}”未匹配任何字段）`
        } else {
          note = val === '' || val == null ? `@${key} 命中但为空` : `@${key} ✓`
        }
      }
      if (!ok && t !== 'image') mismatch++
      lines.push(`  #${idx} [${t}] 变量=${rawVar || '（空）'} 文本="${content}" → ${note}`)
    }
  }
  if (idx === 0) lines.push('  （无元素）')
  lines.push('')
  lines.push(mismatch === 0 ? '所有绑定正常。' : `${mismatch} 处绑定问题，可用「自动绑定」修复文本类元素。`)
  diagText.value = lines.join('\n')
  showDiag.value = true
  console.log('[plugin] 诊断:\n' + diagText.value)
  log(`诊断：${mismatch === 0 ? '全部正常' : mismatch + ' 处问题'}`)
}

async function autoBind() {
  const tpl = getTemplateData() as any
  const pages = getTemplatePages()
  if (!pages.length) {
    log('无可绑定的模板', false)
    return
  }
  const fm = lastFieldMap.value
  const entries = Object.entries(fm)
  let fixed = 0
  for (const page of pages) {
    for (const el of page.elements ?? []) {
      const t = el.type
      const key = stripAt(el.variable ?? '')
      if (t === 'table') {
        if (key !== 'rows') {
          el.variable = '@rows'
          fixed++
        }
        continue
      }
      if (key && key in lastData.value) continue
      const content = (el.content ?? '').replace(/@[\w.\-]+/g, '').trim()
      const hit = entries.find(
        ([fn, vk]) =>
          content === fn || (content && (content.includes(fn) || (fn.includes(content) && content.length >= 2))),
      )
      if (hit) {
        const [fn, vk] = hit
        el.variable = '@' + vk
        el.content = `${fn}：@${vk}`
        fixed++
      }
    }
  }
  loadTemplateData(tpl)
  applyData(lastData.value, { merge: true })
  if (fixed > 0) log(`已自动绑定 ${fixed} 个元素`)
  else log('无可修复的元素', false)
}

async function refreshTemplates() {
  try {
    tplList.value = await templateRepo.value.list()
  } catch {
    tplList.value = []
  }
}

async function saveTpl() {
  const name = tplName.value.trim()
  if (!name) {
    tplError.value = '请先输入模板名称'
    return
  }
  tplBusy.value = true
  tplError.value = ''
  tplMsg.value = ''
  try {
    const data = getTemplateData()
    await templateRepo.value.save(name, data)
    await refreshTemplates()
    tplMsg.value = '已保存「' + name + '」'
    log('模板「' + name + '」已保存')
  } catch (e: any) {
    tplError.value = '保存失败：' + (e?.message ?? e)
  } finally {
    tplBusy.value = false
  }
}

async function loadTpl(name: string) {
  tplBusy.value = true
  tplError.value = ''
  tplMsg.value = ''
  try {
    const data = await templateRepo.value.load(name)
    if (!data) {
      tplError.value = '模板「' + name + '」不存在'
      return
    }
    loadTemplateData(data)
    tplName.value = name
    tplMsg.value = '已加载「' + name + '」'
    log('模板「' + name + '」已加载')
  } catch (e: any) {
    tplError.value = '加载失败：' + (e?.message ?? e)
  } finally {
    tplBusy.value = false
  }
}

async function deleteTpl(name: string) {
  tplBusy.value = true
  tplError.value = ''
  tplMsg.value = ''
  try {
    await templateRepo.value.remove(name)
    await refreshTemplates()
    if (tplName.value === name) tplName.value = ''
    tplMsg.value = '已删除「' + name + '」'
    log('模板「' + name + '」已删除')
  } catch (e: any) {
    tplError.value = '删除失败：' + (e?.message ?? e)
  } finally {
    tplBusy.value = false
  }
}

async function copyDiag() {
  try {
    await navigator.clipboard.writeText(diagText.value)
    log('诊断已复制')
  } catch {
    log('复制失败', false)
  }
}

onMounted(initDesigner)

onBeforeUnmount(() => {
  if (offSelection) {
    try {
      offSelection()
    } catch {}
    offSelection = undefined
  }
  if (selTimer) clearTimeout(selTimer)
})
</script>

<template>
  <div class="layout">
    <header class="toolbar">
      <strong class="brand">记录视图打印</strong>
      <button @click="loadFromFeishu">从飞书读取</button>
      <button @click="loadAllFromFeishu">读取全部</button>
      <button @click="generateFieldTemplate">生成字段单据</button>
      <button @click="openLinkPanel">关联明细</button>
      <span class="sep" />
      <button @click="showVars = !showVars">变量(@)</button>
      <button @click="diagnose">诊断</button>
      <button @click="autoBind">自动绑定</button>
      <span class="sep" />
      <button @click="showTplPanel = !showTplPanel">模板</button>
      <span v-if="noSelection" class="badge">点击行(非复选框) · 用首条</span>
      <span class="status">{{ status }}</span>
    </header>
    <main class="stage">
      <print-designer ref="el"></print-designer>
    </main>
    <section v-if="showVars" class="varpanel">
      <div class="varhint">
        绑定变量（需精确匹配）：<br />
        1）选中元素 → 属性“variable”填 <code>@var</code>；或 2）直接输入 <code>@var</code>。<br />
        使用“生成字段单据”可避免拼写错误。
      </div>
      <div v-if="Object.keys(displayFieldMap).length === 0" class="varmpty">暂无变量，请先从飞书读取。</div>
      <div v-for="(v, k) in displayFieldMap" :key="v" class="varrow" @click="copyVar(v)">
        <span class="fld" :title="k">{{ k }}</span>
        <span class="arrow">→</span>
        <code class="vcode">{{ atVar(v) }}</code>
        <span class="copy">复制</span>
      </div>
    </section>
    <section v-if="showLinkPanel" class="linkpanel">
      <div class="linkhead">
        <strong>关联明细（展开子表行）</strong>
        <button class="mini" @click="showLinkPanel = false">关闭</button>
      </div>
      <div class="linkhint">
        勾选一个关联字段，再勾选要包含的子字段。选择按表保存。
      </div>
      <div v-if="linkBusy" class="linkmsg">加载字段中…</div>
      <div v-if="linkError" class="linkerr">{{ linkError }}</div>
      <div v-if="!linkBusy && !linkFields.length && !linkError" class="linkmsg">当前表无关联字段。</div>
      <div v-for="lf in linkFields" :key="lf.varKey" class="linkgroup">
        <label class="linklv1">
          <input type="checkbox" :checked="!!checkedLinks[lf.varKey]" @change="toggleLinkField(lf)" />
          <span class="lfname">{{ lf.fieldName }}</span>
          <span class="arrow">→</span>
          <span class="ltname">{{ lf.tableName || '（关联表）' }}</span>
        </label>
        <div v-if="checkedLinks[lf.varKey]" class="linksub">
          <label v-for="sf in (linkSubFieldMap[lf.varKey] || [])" :key="sf.varKey" class="linksubitem">
            <input
              type="checkbox"
              :checked="checkedLinks[lf.varKey].subFields.includes(sf.varKey)"
              @change="toggleSubField(lf.varKey, sf.varKey)"
            />
            <span>{{ sf.fieldName }}</span>
            <code class="vcode">{{ atVar(sf.varKey) }}</code>
          </label>
          <div v-if="!(linkSubFieldMap[lf.varKey] || []).length" class="linkmsg">子表无字段。</div>
        </div>
      </div>
      <div class="linkfoot">
        <button @click="generateLinkTemplate">生成关联单据</button>
        <span class="linkcnt">{{ Object.keys(checkedLinks).length }} 个关联 · {{ Object.values(checkedLinks).reduce((a, c) => a + c.subFields.length, 0) }} 个子字段</span>
      </div>
    </section>
    <section v-if="showDiag" class="diagpanel">
      <div class="diaghead">
        <strong>诊断</strong>
        <button class="mini" @click="copyDiag">复制</button>
        <button class="mini" @click="showDiag = false">关闭</button>
      </div>
      <pre class="diagbody">{{ diagText }}</pre>
    </section>
    <section v-if="showTplPanel" class="tplpanel">
      <div class="tplhead">
        <strong>模板（{{ templateRepo.kind === 'supabase' ? '团队共享' : '本地' }}）</strong>
        <button class="mini" @click="showTplPanel = false">关闭</button>
      </div>
      <div class="tplsave">
        <input v-model="tplName" @input="tplMsg = ''; tplError = ''" placeholder="模板名称，如 出库单01" @keyup.enter="saveTpl" />
        <button :disabled="tplBusy" @click="saveTpl">保存当前为</button>
      </div>
      <div v-if="tplMsg" class="tplok">{{ tplMsg }}</div>
      <div v-if="tplError" class="tplerr">{{ tplError }}</div>
      <div v-if="tplBusy" class="tplmsg">处理中…</div>
      <div v-if="!tplList.length" class="tplmsg">暂无已保存模板。</div>
      <div v-for="n in tplList" :key="n" class="tplrow">
        <span class="tplname" :title="n">{{ n }}</span>
        <button class="mini" @click="loadTpl(n)">加载</button>
        <button class="mini danger" @click="deleteTpl(n)">删除</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.layout {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: #f5f6f8;
  border-bottom: 1px solid #e5e6eb;
  flex-wrap: wrap;
}
.brand {
  margin-right: 4px;
}
.toolbar button {
  padding: 5px 10px;
  border: 1px solid #c9cdd4;
  background: #fff;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
}
.toolbar button:hover {
  border-color: #3370ff;
  color: #3370ff;
}
.sep {
  width: 1px;
  height: 18px;
  background: #e5e6eb;
  margin: 0 4px;
}
.status {
  margin-left: auto;
  font-size: 12px;
  color: #4e5969;
}
.badge {
  margin-left: 8px;
  padding: 2px 8px;
  font-size: 12px;
  color: #8a5a00;
  background: #fff3e0;
  border: 1px solid #ffcf8b;
  border-radius: 10px;
}
.stage {
  flex: 1;
  min-height: 0;
  position: relative;
}
.stage :deep(print-designer) {
  width: 100%;
  height: 100%;
  display: block;
}
.varpanel,
.diagpanel,
.linkpanel {
  max-height: 42%;
  overflow: auto;
  padding: 8px 12px;
  background: #fafbfc;
  border-top: 1px solid #e5e6eb;
  font-size: 13px;
}
.varhint {
  color: #4e5969;
  margin-bottom: 6px;
  line-height: 1.6;
}
.varhint code,
.vcode {
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  background: #eef0f3;
  padding: 1px 5px;
  border-radius: 3px;
  color: #1d2129;
}
.varrow {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  border-radius: 4px;
  cursor: pointer;
}
.varrow:hover {
  background: #eef3ff;
}
.fld {
  max-width: 45%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #4e5969;
}
.arrow {
  color: #c9cdd4;
}
.vcode {
  background: #e8f0ff;
  color: #1d4ed8;
  font-weight: 600;
}
.copy {
  margin-left: auto;
  font-size: 12px;
  color: #3370ff;
}
.diaghead {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.diaghead .mini {
  padding: 2px 8px;
  font-size: 12px;
  border: 1px solid #c9cdd4;
  background: #fff;
  border-radius: 4px;
  cursor: pointer;
}
.diagbody {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-all;
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 12px;
  line-height: 1.5;
  color: #1d2129;
  background: #fff;
  border: 1px solid #e5e6eb;
  border-radius: 4px;
  padding: 8px;
}
.tplpanel {
  position: fixed;
  right: 12px;
  top: 60px;
  z-index: 99999;
  width: 300px;
  background: #fff;
  border: 1px solid #e5e6eb;
  border-radius: 6px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.12);
  padding: 10px 12px;
}
.tplhead {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.tplhead .mini {
  margin-left: auto;
  padding: 2px 8px;
  font-size: 12px;
  border: 1px solid #c9cdd4;
  background: #fff;
  border-radius: 4px;
  cursor: pointer;
}
.tplsave {
  display: flex;
  gap: 6px;
  margin-bottom: 8px;
}
.tplsave input {
  flex: 1;
  min-width: 0;
  padding: 5px 8px;
  border: 1px solid #c9cdd4;
  border-radius: 4px;
  font-size: 13px;
}
.tplsave button {
  padding: 5px 10px;
  border: 1px solid #3370ff;
  background: #3370ff;
  color: #fff;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
  white-space: nowrap;
}
.tplsave button:disabled {
  opacity: 0.6;
  cursor: default;
}
.tplerr {
  color: #f53f3f;
  font-size: 12px;
  margin-bottom: 6px;
}
.tplok {
  color: #00a854;
  font-size: 12px;
  margin-bottom: 6px;
  font-weight: 600;
}
.tplmsg {
  font-size: 12px;
  color: #86909c;
  margin-bottom: 6px;
}
.tplrow {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 0;
  border-top: 1px solid #f2f3f5;
}
.tplname {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}
.tplrow .mini {
  padding: 2px 8px;
  font-size: 12px;
  border: 1px solid #c9cdd4;
  background: #fff;
  border-radius: 4px;
  cursor: pointer;
}
.tplrow .mini.danger {
  border-color: #f53f3f;
  color: #f53f3f;
}
.linkhead {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.linkhead .mini {
  padding: 2px 8px;
  font-size: 12px;
  border: 1px solid #c9cdd4;
  background: #fff;
  border-radius: 4px;
  cursor: pointer;
}
.linkhint,
.linkmsg,
.linkerr {
  color: #4e5969;
  margin-bottom: 6px;
  line-height: 1.6;
}
.linkerr {
  color: #d4380d;
}
.linkgroup {
  border: 1px solid #e5e6eb;
  border-radius: 6px;
  margin-bottom: 8px;
  background: #fff;
}
.linklv1 {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  cursor: pointer;
}
.linklv1 .lfname {
  font-weight: 600;
  color: #1d2129;
}
.linklv1 .arrow {
  color: #c9cdd4;
}
.linklv1 .ltname {
  color: #3370ff;
}
.linksub {
  padding: 4px 10px 10px 28px;
  border-top: 1px dashed #e5e6eb;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 4px 12px;
}
.linksubitem {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #1d2129;
}
.linksubitem .vcode {
  background: #e8f0ff;
  color: #1d4ed8;
  font-weight: 600;
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  padding: 1px 5px;
  border-radius: 3px;
}
.linkfoot {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 4px;
}
.linkfoot button {
  padding: 6px 14px;
  border: 1px solid #3370ff;
  background: #3370ff;
  color: #fff;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
}
.linkcnt {
  font-size: 12px;
  color: #4e5969;
}
</style>
