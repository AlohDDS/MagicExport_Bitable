import { ref } from 'vue'

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
    if (!el.value) throw new Error('Designer not ready')
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
    applyData: (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
      const node = ensure()
      node.setVariables(data, opts)
      node.setTestData(data, opts)
    },
  }
}
