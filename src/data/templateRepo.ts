// 模板持久化抽象。
// 当前用 localStorage 实现（无需飞书环境即可本地验证保存/加载）；
// P2 阶段会新增「多维表格字段」实现（通过 @lark-base-open/js-sdk 读写），
// 并预留可切 Supabase 团队共享的 Repository 接口。

export interface TemplateRepo {
  readonly kind: string
  save(name: string, data: unknown): Promise<void>
  load(name: string): Promise<unknown | null>
  list(): Promise<string[]>
  remove(name: string): Promise<void>
}

const PREFIX = 'vpd-template:'

export const localTemplateRepo: TemplateRepo = {
  kind: 'localStorage',
  async save(name, data) {
    localStorage.setItem(PREFIX + name, JSON.stringify(data))
  },
  async load(name) {
    const raw = localStorage.getItem(PREFIX + name)
    return raw ? JSON.parse(raw) : null
  },
  async list() {
    return Object.keys(localStorage)
      .filter((k) => k.startsWith(PREFIX))
      .map((k) => k.slice(PREFIX.length))
  },
  async remove(name) {
    localStorage.removeItem(PREFIX + name)
  },
}
