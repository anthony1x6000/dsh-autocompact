import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'

interface Loaded {
  id: string
  factory: (require: (id: string) => unknown) => ClientModule
}

interface ClientModule {
  inject: string[]
  apply(ctx: unknown): void
  KEY: string
  draftFrom(value: unknown): Array<{ provider: string; model: string; minutes: string }>
  draftErrors(rows: Array<{ provider: string; model: string; minutes: string }>): string[]
  rulesToOps(rows: Array<{ provider: string; model: string; minutes: string }>): unknown[]
  RulesPage(props: Record<string, unknown>): unknown
}

const react = {
  createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
  useState: <T>(initial: T) => [initial, () => {}] as const,
  useEffect: () => {},
  Fragment: 'fragment',
}
const primitives = { Button: 'Button' }

function fakeRequire(id: string): unknown {
  if (id === 'react') return react
  if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives
  throw new Error(`unexpected require ${id}`)
}

let client: ClientModule
let loaded: Loaded

before(async () => {
  ;(globalThis as { window?: unknown }).window = {
    __ModuleLoader__: { load: (entry: Loaded) => { loaded = entry } },
  }
  await import('./client/client.js')
  client = loaded.factory(fakeRequire)
})

describe('client module', () => {
  it('registers under the package name and injects slots and locale', () => {
    assert.equal(loaded.id, 'dsh-autocompact')
    assert.deepEqual(client.inject, ['slots', 'locale'])
  })

  it('registers a configuration page for the idle-autocompact row', () => {
    const registered: Array<{ slot: string; options: Record<string, unknown>; component: unknown }> = []
    const dictionaries: string[] = []
    const ctx = {
      effect: (factory: () => unknown) => factory(),
      locale: {
        register: (ns: string) => { dictionaries.push(ns) },
        bind: () => (key: string) => key,
      },
      slots: {
        inject: (slot: string, register: () => unknown) => register(),
        register: (options: Record<string, unknown>, component: unknown) => {
          registered.push({ slot: String(options.name), options, component })
        },
      },
    }
    client.apply(ctx)
    assert.equal(registered.length, 1)
    assert.equal(registered[0]?.slot, 'plugins.row.config')
    assert.equal(registered[0]?.options.key, 'dsh-autocompact#idle-autocompact')
    assert.equal(registered[0]?.component, client.RulesPage)
    assert.equal(dictionaries.length, 1)
  })
})

describe('draft helpers', () => {
  it('turns saved rules into editable text rows', () => {
    assert.deepEqual(
      client.draftFrom({ rules: [{ provider: 'deepseek', minutes: 5 }, { model: 'm', minutes: 0 }] }),
      [
        { provider: 'deepseek', model: '', minutes: '5' },
        { provider: '', model: 'm', minutes: '0' },
      ],
    )
  })

  it('yields no rows when nothing is saved yet', () => {
    assert.deepEqual(client.draftFrom(undefined), [])
    assert.deepEqual(client.draftFrom({}), [])
  })

  it('writes the whole rules array with one set op, trimmed, blank selectors omitted', () => {
    assert.deepEqual(
      client.rulesToOps([
        { provider: ' deepseek ', model: '', minutes: '10' },
        { provider: '', model: 'm', minutes: '2.5' },
      ]),
      [{ op: 'set', path: ['rules'], value: [{ provider: 'deepseek', minutes: 10 }, { model: 'm', minutes: 2.5 }] }],
    )
  })

  it('accepts a well-formed draft', () => {
    assert.deepEqual(client.draftErrors([{ provider: 'p', model: '', minutes: '5' }]), [])
  })

  it('rejects a row with neither provider nor model', () => {
    assert.match(client.draftErrors([{ provider: ' ', model: '', minutes: '5' }]).join(), /provider or model/)
  })

  it('rejects blank, non-numeric and negative minutes', () => {
    for (const minutes of ['', 'abc', '-1']) {
      assert.match(client.draftErrors([{ provider: 'p', model: '', minutes }]).join(), /minutes/, minutes)
    }
  })

  it('rejects duplicate selectors', () => {
    const rows = [
      { provider: 'p', model: 'm', minutes: '1' },
      { provider: 'p ', model: ' m', minutes: '2' },
    ]
    assert.match(client.draftErrors(rows).join(), /duplicate/)
  })
})

describe('RulesPage', () => {
  it('renders the one-liner for the summary view', () => {
    const t = (key: string) => key
    assert.equal(typeof client.RulesPage({ view: 'summary', t }), 'string')
  })
})
