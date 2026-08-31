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
