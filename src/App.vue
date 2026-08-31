<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useDesigner } from './print/useDesigner'
import { localTemplateRepo } from './data/templateRepo'
import { buildTableTemplate, buildFieldTemplate, type LinkTableSpec } from './print/templateFactory'
import {
  getSelectionVariables,
  getAllRecordsVariables,
  getTableInfo,
  isInFeishu,
  getLinkFields,
  getLinkSubFields,
  type LinkFieldInfo,
  type LinkSubFieldInfo,
  type LinkExpandSpec,
} from './feishu/sdk'

const TEMPLATE_NAME = 'default'

const { el, ready, markReady, setBranding, setTheme, applyData, loadTemplateData, getTemplateData } =
  useDesigner()

const status = ref('正在初始化设计器…')
const theme = ref<'light' | 'dark'>('light')
const inFeishu = ref(false)
// 字段名 → 英文变量名映射（用于「变量对照」面板展示与复制）
const fieldMap = ref<Record<string, string>>({})
// 是否展开变量对照面板
const showVars = ref(false)
// 最近一次注入的数据（变量名 → 值）与字段映射，供「诊断 / 自动修正」使用
const lastData = ref<Record<string, unknown>>({})
const lastFieldMap = ref<Record<string, string>>({})
// 诊断结果文本与面板
const diagText = ref('')
const showDiag = ref(false)
// 当前表名（用于关联配置持久化的 key）与「未选中记录·用第1条」角标
const currentTableName = ref('')
const noSelection = ref(false)

// —— 关联字段（场景 B）两级勾选 UI 状态 ——
const showLinkPanel = ref(false)
const linkFields = ref<LinkFieldInfo[]>([]) // 一级：主表关联字段
const linkSubFieldMap = ref<Record<string, LinkSubFieldInfo[]>>({}) // varKey → 二级子表字段
const checkedLinks = ref<Record<string, { fieldName: string; tableName: string; tableId: string; subFields: string[] }>>({})
const linkBusy = ref(false)
const linkError = ref('')
// 当前生效的关联展开规格：根据两级勾选实时计算，
// 这样「从飞书读取」时直接用最新勾选，不用必须点「生成关联单据」。
const currentLinkExpand = computed<LinkExpandSpec[]>(() => {
  const arr: LinkExpandSpec[] = []
  for (const vk of Object.keys(checkedLinks.value)) {
    const c = checkedLinks.value[vk]
    const subs = (linkSubFieldMap.value[vk] ?? [])
      .filter((s) => c.subFields.includes(s.varKey))
      .map((s) => s.varKey)
    if (!subs.length) continue
    arr.push({ varKey: vk, tableId: c.tableId, subFields: subs })
  }
  return arr
})

function log(msg: string, ok = true) {
  status.value = (ok ? '✓ ' : '✗ ') + msg
  console.log('[plugin]', msg)
}

// 把变量名拼成 @变量名（Vue 模板里 @ 是 v-on 简写，不能直接写 @{{v}}）
function atVar(v: string): string {
  return '@' + v
}

// 点击变量行复制 @变量名 到剪贴板
async function copyVar(v: string) {
  try {
    await navigator.clipboard.writeText('@' + v)
    log('已复制变量名 @' + v)
  } catch {
    log('复制失败（浏览器限制），请手动复制：@' + v, false)
  }
}

// 去掉变量名前缀 @（与库内 normalizeVariableKey 行为一致：仅去 @，保留其余）
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
    log('设计器错误：' + (e?.detail?.error?.message ?? 'unknown'), false)
  })
  node.addEventListener('exported', (e: any) => {
    if (e?.detail?.blob) log('导出成功（blob 已生成）')
  })
  setBranding({ title: '记录视图打印', showLogo: true })
  setTheme(theme.value)
  inFeishu.value = await isInFeishu()
  log(inFeishu.value ? '检测到飞书环境' : '未检测到飞书环境（请通过多维表格自定义插件打开本页）')
  // 飞书环境：提前拉取全表字段映射，让「变量对照」面板一进来就能列出所有 @变量名
  if (inFeishu.value) {
    try {
      const info = await getTableInfo()
      fieldMap.value = info.fieldMap
      currentTableName.value = info.tableName
      // 方案 A：恢复上次保存的关联明细勾选，日常「从飞书读取」即可自动排版+注入
      restoreLinkCfg()
    } catch {
      /* 忽略，读取记录时会再拿 */
    }
  }
  // 尝试恢复上次保存的模板
  let hasSavedTemplate = false
  try {
    const saved = await localTemplateRepo.load(TEMPLATE_NAME)
    if (saved) {
      loadTemplateData(saved)
      hasSavedTemplate = true
    }
  } catch {
    /* 忽略 */
  }
  // 打开即读取：自动注入当前选中记录（含关联明细），无需手动点按钮
  if (inFeishu.value) await autoLoadOnOpen(hasSavedTemplate)
}

// 确保已勾选关联字段的二级子表字段已加载。restoreLinkCfg 是异步 fire-and-forget，
// 这里显式 await，保证打开自动生成关联单据时 currentLinkExpand 已正确计算。
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

// 打开即读取：按配置自动出单据并注入当前选中记录
async function autoLoadOnOpen(hasSavedTemplate: boolean) {
  await ensureLinkSubFields()
  if (!inFeishu.value) return
  try {
    if (hasSavedTemplate) {
      // 已有自定义模板：只注入当前选中数据，不改动你的排版
      await injectSelectionOnly()
    } else if (currentLinkExpand.value.length) {
      // 空白打开且已勾选关联：自动生成关联单据并注入
      await generateLinkTemplate()
    } else {
      // 空白打开：自动生成字段单据并注入
      await generateFieldTemplate()
    }
  } catch (e: any) {
    log('打开自动读取失败：' + (e?.message ?? e), false)
  }
}

// 仅注入当前选中记录数据，不做任何排版（用于已保存模板的场景，尊重用户设计）
async function injectSelectionOnly() {
  const { vars, rows, note, fieldMap: fm } = await getSelectionVariables(currentLinkExpand.value)
  const data = { ...vars, rows }
  lastData.value = data
  lastFieldMap.value = fm ?? {}
  if (fm) fieldMap.value = fm
  noSelection.value = !!note && note.startsWith('未选中')
  applyData(data, { merge: true })
  log(note ? `已自动读取并注入（${note}）` : `已自动读取并注入 ${Object.keys(vars).length} 个字段变量`)
}

// 浏览器（非飞书）环境下给一个明确提示，不再用示例数据替代。
function notInFeishu(): boolean {
  if (inFeishu.value) return false
  log('当前不在飞书环境：请通过多维表格「自定义插件」打开本页面后，再点对应按钮。', false)
  return true
}

async function loadFromFeishu() {
  if (notInFeishu()) return
  try {
    const { vars, rows, note, fieldMap: fm } = await getSelectionVariables(currentLinkExpand.value)
    noSelection.value = !!note && note.startsWith('未选中')
    const data = { ...vars, rows }
    // 方案 A：配置了关联明细且当前模板尚缺对应 @<varKey>_rows 表格时，自动排版一次（不覆盖已有自定义模板）
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
    log(note ? `已从飞书读取（${note}）` : `已从飞书读取并注入 ${Object.keys(vars).length} 个字段变量`)
  } catch (e: any) {
    log('读取飞书记录失败：' + (e?.message ?? e), false)
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
    // 按当前表字段现场生成匹配表格模板（列与 @rows 严格对齐），再注入逐行数据
    if (fm) loadTemplateData(buildTableTemplate(fm))
    applyData(data, { merge: true })
    log(note ?? `已读取当前表并注入 ${rows.length} 行到表格 @rows`)
  } catch (e: any) {
    log('读取当前表失败：' + (e?.message ?? e), false)
  }
}

// 生成「单条记录」字段单据（每个字段一行，已正确绑定 @变量名），无需手工敲名。
async function generateFieldTemplate() {
  if (notInFeishu()) return
  try {
    const info = await getTableInfo()
    if (!info.fieldMap || !Object.keys(info.fieldMap).length) {
      log('没有可用字段，无法生成模板', false)
      return
    }
    fieldMap.value = info.fieldMap
    lastFieldMap.value = info.fieldMap
    loadTemplateData(buildFieldTemplate(info.fieldMap, { title: info.tableName || '字段单据' }))
    // 生成后立即注入当前记录数据，避免「模板空白」——与「生成关联单据并注入」行为一致
    const { vars, rows, note, fieldMap: fm } = await getSelectionVariables(currentLinkExpand.value)
    const data = { ...vars, rows }
    lastData.value = data
    if (fm) fieldMap.value = fm
    applyData(data, { merge: true })
    noSelection.value = !!note
    log(
      note
        ? `已生成字段单据模板并注入数据（${Object.keys(info.fieldMap).length} 个字段，${note}）`
        : `已生成字段单据模板（${Object.keys(info.fieldMap).length} 个字段），并注入数据。`,
    )
  } catch (e: any) {
    log('生成字段模板失败：' + (e?.message ?? e), false)
  }
}

// —— 关联字段（场景 B）：打开两级勾选面板 ——
async function openLinkPanel() {
  if (notInFeishu()) return
  linkError.value = ''
  showLinkPanel.value = true
  linkBusy.value = true
  try {
    linkFields.value = await getLinkFields()
    if (!linkFields.value.length) {
      linkError.value = '当前主表没有关联字段（单向/双向关联），无法展开关联明细。'
    }
  } catch (e: any) {
    linkError.value = '读取关联字段失败：' + (e?.message ?? e)
  } finally {
    linkBusy.value = false
  }
}

// 一级勾选切换：选中时懒加载该关联字段的二级子表字段
async function toggleLinkField(info: LinkFieldInfo) {
  const cur = checkedLinks.value[info.varKey]
  if (cur) {
    // 取消勾选
    const next = { ...checkedLinks.value }
    delete next[info.varKey]
    checkedLinks.value = next
    return
  }
  // 勾选：先加载子表字段（仅一次）
  if (!linkSubFieldMap.value[info.varKey]) {
    linkBusy.value = true
    try {
      const subs = await getLinkSubFields(info.tableId)
      linkSubFieldMap.value = { ...linkSubFieldMap.value, [info.varKey]: subs }
    } catch (e: any) {
      linkError.value = '读取子表字段失败：' + (e?.message ?? e)
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

// 二级子表字段勾选切换
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

// —— 关联配置持久化（方案 A）：按当前表名存 localStorage，重开插件自动恢复，避免每次重新勾选 ——
const LS_PREFIX = 'vpd-linkcfg:'
function linkCfgKey(): string {
  return LS_PREFIX + (currentTableName.value || 'default')
}
function saveLinkCfg() {
  if (!currentTableName.value) return
  try {
    localStorage.setItem(linkCfgKey(), JSON.stringify(checkedLinks.value))
  } catch {
    /* 忽略存储失败（如隐私模式） */
  }
}
function restoreLinkCfg() {
  if (!currentTableName.value) return
  try {
    const raw = localStorage.getItem(linkCfgKey())
    if (!raw) return
    const cfg = JSON.parse(raw) as Record<string, { fieldName: string; tableName: string; tableId: string; subFields: string[] }>
    // 逐级恢复子表字段映射（用于展开计算与面板展示）
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
  } catch {
    /* 忽略损坏数据 */
  }
}
// 勾选变化即持久化
watch(checkedLinks, () => saveLinkCfg(), { deep: true })

// 判断当前模板是否已含本次关联展开所需的 @<varKey>_rows 表格（避免重复生成覆盖用户自定义排版）
function templateHasLinkTables(specs: LinkExpandSpec[]): boolean {
  if (!specs.length) return true
  const pages = getTemplatePages()
  const need = new Set(specs.map((s) => '@' + s.varKey + '_rows'))
  let found = 0
  for (const p of pages) for (const el of p.elements ?? []) if (el.type === 'table' && need.has(el.variable)) found++
  return found === specs.length
}

// 由当前两级勾选生成「关联明细表」规格（主表字段单据逻辑在 buildFieldTemplate 内）
function buildLinkSpecs(): LinkTableSpec[] {
  const specs: LinkTableSpec[] = []
  for (const vk of Object.keys(checkedLinks.value)) {
    const c = checkedLinks.value[vk]
    const subs = (linkSubFieldMap.value[vk] ?? [])
      .filter((s) => c.subFields.includes(s.varKey))
      .map((s) => ({ fieldName: s.fieldName, varKey: s.varKey }))
    if (subs.length) specs.push({ varKey: vk, tableName: c.tableName, fields: subs })
  }
  return specs
}

// 生成「关联明细单据」：主表字段单据 + 每个勾选关联字段的明细大表，并即时注入数据。
async function generateLinkTemplate() {
  if (notInFeishu()) return
  const specs: LinkTableSpec[] = []
  const expand: LinkExpandSpec[] = []
  for (const vk of Object.keys(checkedLinks.value)) {
    const c = checkedLinks.value[vk]
    const subs = linkSubFieldMap.value[vk] ?? []
    const fields = subs.filter((s) => c.subFields.includes(s.varKey)).map((s) => ({ fieldName: s.fieldName, varKey: s.varKey }))
    if (!fields.length) continue
    specs.push({ varKey: vk, tableName: c.tableName, fields })
    expand.push({ varKey: vk, tableId: c.tableId, subFields: fields.map((f) => f.varKey) })
  }
  if (!specs.length) {
    log('请至少勾选一个关联字段，并勾选至少一个子表字段。', false)
    return
  }
  try {
    const info = await getTableInfo()
    fieldMap.value = info.fieldMap
    lastFieldMap.value = info.fieldMap
    // 主表字段单据 + 关联明细表
    loadTemplateData(buildFieldTemplate(info.fieldMap, { title: info.tableName || '字段单据' }, specs))
    // 注入数据（含 @<varKey>_rows）。currentLinkExpand 已实时同步，这里同步一下即可。
    const { vars, rows, fieldMap: fm } = await getSelectionVariables(expand)
    const data = { ...vars, rows }
    lastData.value = data
    if (fm) fieldMap.value = fm
    applyData(data, { merge: true })
    log(`已生成关联单据并注入：${specs.length} 个关联明细表（共 ${expand.reduce((a, s) => a + s.subFields.length, 0)} 个子字段）。点「从飞书读取」可重新注入。`)
  } catch (e: any) {
    log('生成关联单据失败：' + (e?.message ?? e), false)
  }
}

// getTemplateData 返回结构在不同版本/状态下会变化：{pages}/ {data:{pages}}/ {data:{data:{pages}}} 等。
// 这里做防御性解析，优先取最深层的 pages 数组。
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

// —— 诊断：列出「注入的变量」vs「模板里每个元素实际绑的变量」，暴露错配/空值 ——
function diagnose() {
  const rawTpl = getTemplateData() as any
  const pages = getTemplatePages()
  const injected = lastData.value
  const injectedKeys = Object.keys(injected)
  const lines: string[] = []
  lines.push('【原始模板结构摘要】')
  lines.push('  ' + summarizeTemplate(rawTpl).replace(/\n/g, ' '))
  lines.push('')
  lines.push('【注入的变量（变量名 → 首条值）】共 ' + injectedKeys.length + ' 个')
  for (const k of injectedKeys) {
    const v = injected[k]
    const sample = Array.isArray(v) ? `[数组 ${v.length} 行]` : String(v ?? '').slice(0, 80)
    lines.push(`  @${k} = ${sample}`)
  }
  lines.push('')
  lines.push('【模板元素实际绑定的变量】')
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
          note = key === 'rows' ? `表格→@rows ✓（${cnt} 行）` : `表格→@${key} ✓（关联明细 ${cnt} 行）`
        } else {
          note = key ? `表格变量 @${key} 未匹配（@rows 或 @<关联字段>_rows）` : '表格未绑定变量'
        }
      } else if (t === 'image') {
        ok = !!key && key in injected && typeof val === 'string' && /^https?:\/\//.test(val)
        if (ok) note = `@${key} 是图片 URL ✓`
        else if (key && key in injected) {
          note = `@${key} 已命中，但值不是图片 URL（当前值：${String(val).slice(0, 60) || '(空)'}）`
          mismatch++
        } else {
          note = key ? `变量 @${key} 未在注入列表中` : '图片未绑定变量'
          mismatch++
        }
      } else {
        ok = !!key && key in injected
        if (!ok) {
          // 尝试按显示文字反查字段
          const hit = Object.entries(lastFieldMap.value).find(
            ([fn, vk]) => (content === fn || (content && (content.includes(fn) || fn.includes(content)))),
          )
          note = key ? `变量 @${key} 未在注入列表中` : '未绑定变量'
          if (hit) note += `（显示文字「${content}」疑似字段「${hit[0]}」，应绑 @${hit[1]}）`
          else if (content) note += `（显示文字「${content}」未匹配到任何字段）`
        } else {
          note = val === '' || val == null ? `@${key} 命中但值为空` : `@${key} ✓`
        }
      }
      if (!ok && t !== 'image') mismatch++
      lines.push(`  #${idx} [${t}] 绑定=${rawVar || '(空)'} 显示文字="${content}" → ${note}`)
    }
  }
  if (idx === 0) lines.push('  （未遍历到任何元素。若设计器里有内容，请把本报告顶部的「原始模板结构摘要」贴给我。）')
  lines.push('')
  lines.push(mismatch === 0 ? '结论：所有元素绑定均命中注入变量。若仍空白，请检查字段值本身是否为空。' : `结论：${mismatch} 个元素绑定异常。点「自动修正绑定」可尝试按显示文字自动修正；图片异常请确认字段为附件/图片类型。`)
  diagText.value = lines.join('\n')
  showDiag.value = true
  console.log('[plugin] 诊断报告:\n' + diagText.value)
  log(`诊断完成：${mismatch === 0 ? '全部命中' : mismatch + ' 个绑定异常'}（详见下方诊断面板）`)
}

// —— 自动修正绑定：按元素显示文字匹配飞书字段名，把 variable 改成正确的 @变量名 ——
async function autoBind() {
  const tpl = getTemplateData() as any
  const pages = getTemplatePages()
  if (!pages.length) {
    log('当前没有可导出的模板', false)
    return
  }
  const fm = lastFieldMap.value
  const entries = Object.entries(fm)
  const rowsOk = Array.isArray(lastData.value['rows'])
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
      // 文本：若已正确命中则跳过
      if (key && key in lastData.value) continue
      const content = (el.content ?? '').replace(/@[\w.\-]+/g, '').trim()
      const hit = entries.find(
        ([fn, vk]) =>
          content === fn || (content && (content.includes(fn) || (fn.includes(content) && content.length >= 2))),
      )
      if (hit) {
        const [fn, vk] = hit
        el.variable = '@' + vk
        // 让显示文字成为「字段名：@变量名」，解析后显示「字段名：值」
        el.content = `${fn}：@${vk}`
        fixed++
      }
    }
  }
  loadTemplateData(tpl)
  applyData(lastData.value, { merge: true })
  if (fixed > 0) log(`已自动修正 ${fixed} 个元素绑定，并重新注入数据。可点「诊断」复核。`)
  else log('未找到可修正的元素（元素显示文字未匹配到字段名，或已全部正确）。', false)
}

async function saveTemplate() {
  try {
    const data = getTemplateData()
    await localTemplateRepo.save(TEMPLATE_NAME, data)
    log('模板已保存到本地（' + TEMPLATE_NAME + '）')
  } catch (e: any) {
    log('保存模板失败：' + (e?.message ?? e), false)
  }
}

async function loadTemplate() {
  try {
    const data = await localTemplateRepo.load(TEMPLATE_NAME)
    if (!data) {
      log('本地无已保存模板', false)
      return
    }
    loadTemplateData(data)
    log('已加载本地模板')
  } catch (e: any) {
    log('加载模板失败：' + (e?.message ?? e), false)
  }
}

async function copyDiag() {
  try {
    await navigator.clipboard.writeText(diagText.value)
    log('诊断报告已复制，可粘贴给我排查')
  } catch {
    log('复制失败，请手动选择下方文本复制', false)
  }
}

onMounted(initDesigner)
</script>

<template>
  <div class="layout">
    <header class="toolbar">
      <strong class="brand">记录视图打印</strong>
      <button @click="loadFromFeishu">从飞书读取</button>
      <button @click="loadAllFromFeishu">读取当前表</button>
      <button @click="generateFieldTemplate">生成字段模板</button>
      <button @click="openLinkPanel">关联明细</button>
      <span class="sep" />
      <button @click="showVars = !showVars">变量(@)</button>
      <button @click="diagnose">诊断</button>
      <button @click="autoBind">自动修正绑定</button>
      <span class="sep" />
      <button @click="saveTemplate">保存模板</button>
      <button @click="loadTemplate">加载模板</button>
      <span v-if="noSelection" class="badge">未选中·用第1条</span>
      <span class="status">{{ status }}</span>
    </header>
    <main class="stage">
      <print-designer ref="el"></print-designer>
    </main>
    <section v-if="showVars" class="varpanel">
      <div class="varhint">
        绑定方式（二选一，变量名务必<strong>完全等于</strong>右侧复制出的名）：<br />
        ① 选中元素 → 右侧属性「变量」框填 <code>@变量名</code>；② 直接在元素文本里写 <code>@变量名</code>。<br />
        嫌手工敲易错？点「生成字段模板」可一键生成已绑定好的单据。
      </div>
      <div v-if="Object.keys(fieldMap).length === 0" class="varmpty">暂无变量。请先「从飞书读取」或「生成字段模板」。</div>
      <div v-for="(v, k) in fieldMap" :key="v" class="varrow" @click="copyVar(v)">
        <span class="fld" :title="k">{{ k }}</span>
        <span class="arrow">→</span>
        <code class="vcode">{{ atVar(v) }}</code>
        <span class="copy">复制</span>
      </div>
    </section>
    <section v-if="showLinkPanel" class="linkpanel">
      <div class="linkhead">
        <strong>关联明细（场景 B：展开子表多行，不改动原表）</strong>
        <button class="mini" @click="showLinkPanel = false">收起</button>
      </div>
      <div class="linkhint">
        一级勾选主表的关联字段；展开后二级勾选要在明细表里展示的子表字段。勾选会自动保存（按表记忆），之后日常点「从飞书读取」即自动排版并注入，无需再点此按钮。下方按钮用于强制重新排版。
      </div>
      <div v-if="linkBusy" class="linkmsg">正在读取字段…</div>
      <div v-if="linkError" class="linkerr">{{ linkError }}</div>
      <div v-if="!linkBusy && !linkFields.length && !linkError" class="linkmsg">当前主表没有关联字段。</div>
      <div v-for="lf in linkFields" :key="lf.varKey" class="linkgroup">
        <label class="linklv1">
          <input type="checkbox" :checked="!!checkedLinks[lf.varKey]" @change="toggleLinkField(lf)" />
          <span class="lfname">{{ lf.fieldName }}</span>
          <span class="arrow">→</span>
          <span class="ltname">{{ lf.tableName || '(关联表)' }}</span>
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
          <div v-if="!(linkSubFieldMap[lf.varKey] || []).length" class="linkmsg">该子表暂无可用字段。</div>
        </div>
      </div>
      <div class="linkfoot">
        <button @click="generateLinkTemplate">生成关联单据并注入</button>
        <span class="linkcnt">已选 {{ Object.keys(checkedLinks).length }} 个关联 · {{ Object.values(checkedLinks).reduce((a, c) => a + c.subFields.length, 0) }} 个子字段</span>
      </div>
    </section>
    <section v-if="showDiag" class="diagpanel">
      <div class="diaghead">
        <strong>诊断报告</strong>
        <button class="mini" @click="copyDiag">复制全部</button>
        <button class="mini" @click="showDiag = false">收起</button>
      </div>
      <pre class="diagbody">{{ diagText }}</pre>
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
