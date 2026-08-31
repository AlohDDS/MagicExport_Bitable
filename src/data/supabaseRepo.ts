import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../config'
import type { TemplateRepo } from './templateRepo'

// Returns true when real Supabase credentials are configured.
export function supabaseConfigured(): boolean {
  return (
    SUPABASE_URL.startsWith('https://') &&
    !SUPABASE_URL.includes('YOUR-PROJECT') &&
    SUPABASE_ANON_KEY !== '' &&
    !SUPABASE_ANON_KEY.includes('YOUR-ANON-KEY')
  )
}

interface TplRow {
  tenant_key: string
  table_id: string
  name: string
  data: unknown
}

// Builds a TemplateRepo backed by Supabase, scoped by Feishu tenant + table.
// Templates are team-shared: every member of the same tenant+table sees them.
export function createSupabaseRepo(tenantKey: string, tableId: string): TemplateRepo {
  const sb: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

  return {
    kind: 'supabase',
    async save(name: string, data: unknown) {
      const row: TplRow = { tenant_key: tenantKey, table_id: tableId, name, data }
      const { error } = await sb
        .from('print_templates')
        .upsert(row, { onConflict: 'tenant_key,table_id,name' })
      if (error) throw new Error(error.message)
    },
    async load(name: string) {
      const { data, error } = await sb
        .from('print_templates')
        .select('data')
        .eq('tenant_key', tenantKey)
        .eq('table_id', tableId)
        .eq('name', name)
        .maybeSingle()
      if (error) return null
      return (data as TplRow | null)?.data ?? null
    },
    async list() {
      const { data, error } = await sb
        .from('print_templates')
        .select('name')
        .eq('tenant_key', tenantKey)
        .eq('table_id', tableId)
        .order('name', { ascending: true })
      if (error) return []
      return (data as Pick<TplRow, 'name'>[]).map((r) => r.name)
    },
    async remove(name: string) {
      const { error } = await sb
        .from('print_templates')
        .delete()
        .eq('tenant_key', tenantKey)
        .eq('table_id', tableId)
        .eq('name', name)
      if (error) throw new Error(error.message)
    },
  }
}
