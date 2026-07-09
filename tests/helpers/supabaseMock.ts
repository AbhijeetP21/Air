/* eslint-disable @typescript-eslint/no-explicit-any */
// Chainable Supabase client mock. Query builders are thenable (like the real
// ones), so `await from().update().eq()` and `.maybeSingle()` both work.
// Results are configured per table; reads and writes resolve independently so
// a test can make a select succeed while an update fails.

import { vi } from 'vitest'

export type TableResult = {
  /** Resolved by `.maybeSingle()` / awaited select chains. */
  select?: { data: unknown; error?: unknown }
  /** Resolved by awaited update/insert chains. */
  write?: { error?: unknown }
}

export type MockUser = {
  id: string
  email?: string
  user_metadata?: Record<string, unknown>
} | null

export type SupabaseMockState = {
  user?: MockUser
  tables?: Record<string, TableResult>
}

export function createSupabaseMock(state: SupabaseMockState) {
  // Every from() call creates a fresh chain and records it here, so tests can
  // assert on the exact filters and payloads used.
  const chains: Record<string, any[]> = {}

  const client = {
    auth: {
      getUser: vi.fn(async () => ({ data: { user: state.user ?? null } })),
    },
    from: vi.fn((table: string) => {
      const tableResult = () => state.tables?.[table]
      const c: any = { _write: false }
      const ret = () => c
      c.select = vi.fn(ret)
      c.eq = vi.fn(ret)
      c.order = vi.fn(ret)
      c.returns = vi.fn(ret)
      c.update = vi.fn(() => {
        c._write = true
        return c
      })
      c.insert = vi.fn(() => {
        c._write = true
        return c
      })
      c.maybeSingle = vi.fn(async () => ({
        data: tableResult()?.select?.data ?? null,
        error: tableResult()?.select?.error ?? null,
      }))
      c.then = (resolve: any, reject: any) => {
        const t = tableResult()
        const result = c._write
          ? { data: null, error: t?.write?.error ?? null }
          : { data: t?.select?.data ?? null, error: t?.select?.error ?? null }
        return Promise.resolve(result).then(resolve, reject)
      }
      ;(chains[table] ??= []).push(c)
      return c
    }),
  }

  return { client, chains }
}
