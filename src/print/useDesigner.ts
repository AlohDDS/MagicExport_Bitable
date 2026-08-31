import { ref } from 'vue'

// vue-print-designer 的 <print-designer> Web Component 暴露的实例方法（取子集）。
export type DesignerEl = HTMLElement & {
  setBranding: (opts: { title?: string; showLogo?: boolean }) => void
  setTheme: (theme: 'light' | 'dark') => void
  setVariables: (vars: Record<string, unknown>, opts?: { merge?: boolean }) => void
  setTestData: (data: Record<string, unknown>, opts?: { merge?: boolean }) => void
  loadTemplateData: (data: unknown) => void
  getTemplateData: () => unknown
  print: (opts?: { mode?: string }) => Promise<void>
  export: (opts: { type: string; filename?: string }) => Promise<unknown>
}

export function useDesigner() {
  const el = ref<DesignerEl | null>(null)
  const ready = ref(false)

  function ensure(): DesignerEl {
    if (!el.value) throw new Error('设计器尚未就绪')
    return el.value as DesignerEl
  }

  return {
    el,
    ready,
    markReady: () => (ready.value = true),
    setBranding: (opts: { title?: string; showLogo?: boolean }) => ensure().setBranding(opts),
    setTheme: (theme: 'light' | 'dark') => ensure().setTheme(theme),
    setVariables: (vars: Record<string, unknown>, opts?: { merge?: boolean }) =>
      ensure().setVariables(vars, opts),
    setTestData: (data: Record<string, unknown>, opts?: { merge?: boolean }) =>
      ensure().setTestData(data, opts),
    loadTemplateData: (data: unknown) => ensure().loadTemplateData(data),
    getTemplateData: () => ensure().getTemplateData(),
    print: (opts?: { mode?: string }) => ensure().print(opts),
    exportPdf: (filename?: string) =>
      ensure().export({ type: 'pdf', filename: filename ?? 'record.pdf' }),
    /**
     * 同时写入 variables（文本/条码导出时的 @变量 数据源）与 testData（表格行 + 预览数据源）。
     * 经源码确认：文本元素导出时读 variables、预览时回退 testData；表格行始终读 testData。
     * 故同一份完整数据需同时灌入两个池，才能保证「预览」与「打印/导出」一致。
     */
    applyData: (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
      const node = ensure()
      node.setVariables(data, opts)
      node.setTestData(data, opts)
    },
  }
}
