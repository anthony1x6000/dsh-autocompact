import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'

interface Loaded {
  id: string
  factory: (require: (id: string) => unknown) => ClientModule
}

interface CatalogModel {
  id: string
  name: string
}

interface CatalogGroup {
  id: string
  name: string
  models: CatalogModel[]
}

interface Choice {
  value: string
  label: string
  unavailable: boolean
}

interface CatalogState {
  status: 'ready' | 'error'
  groups?: CatalogGroup[]
  error?: string
}

interface ClientModule {
  inject: string[]
  apply(ctx: unknown): void
  KEY: string
  draftFrom(value: unknown): Array<{ provider: string; model: string; minutes: string }>
  draftErrors(rows: Array<{ provider: string; model: string; minutes: string }>): string[]
  rulesToOps(rows: Array<{ provider: string; model: string; minutes: string }>): unknown[]
  providerChoices(groups: CatalogGroup[], current: string): Choice[]
  modelChoices(groups: CatalogGroup[], provider: string, current: string): Choice[]
  loadCatalog(remote: unknown): Promise<CatalogState>
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
  it('registers under the package name and injects the slots, locale and remote services', () => {
    assert.equal(loaded.id, 'dsh-autocompact')
    assert.deepEqual(client.inject, ['slots', 'locale', 'remote', 'remote.session'])
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
    const Page = registered[0]?.component as (props: Record<string, unknown>) => { type: unknown }
    assert.equal(typeof Page, 'function')
    assert.equal(Page({ view: 'summary', t: (key: string) => key }).type, client.RulesPage)
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

const groups: CatalogGroup[] = [
  {
    id: 'opencode-go',
    name: 'opencode-go',
    models: [
      { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
      { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash' },
    ],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    models: [
      { id: 'deepseek-chat', name: 'DeepSeek Chat' },
      { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
    ],
  },
]

describe('providerChoices', () => {
  it('lists every catalog provider by id and display name', () => {
    assert.deepEqual(client.providerChoices(groups, ''), [
      { value: 'opencode-go', label: 'opencode-go', unavailable: false },
      { value: 'deepseek', label: 'DeepSeek', unavailable: false },
    ])
  })

  it('keeps a saved provider that the catalog no longer offers, marked unavailable', () => {
    assert.deepEqual(client.providerChoices(groups, 'Claude Code'), [
      { value: 'opencode-go', label: 'opencode-go', unavailable: false },
      { value: 'deepseek', label: 'DeepSeek', unavailable: false },
      { value: 'Claude Code', label: 'Claude Code', unavailable: true },
    ])
  })
})

describe('modelChoices', () => {
  it('lists one provider models when that provider is selected', () => {
    assert.deepEqual(client.modelChoices(groups, 'deepseek', ''), [
      { value: 'deepseek-chat', label: 'DeepSeek Chat', unavailable: false },
      { value: 'deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash', unavailable: false },
    ])
  })

  it('unions model ids across providers when any provider is selected', () => {
    assert.deepEqual(client.modelChoices(groups, '', ''), [
      { value: 'deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash', unavailable: false },
      { value: 'glm-5.3-flash', label: 'GLM-5.3-Flash', unavailable: false },
      { value: 'deepseek-chat', label: 'DeepSeek Chat', unavailable: false },
    ])
  })

  it('keeps a saved model that the catalog no longer offers, marked unavailable', () => {
    assert.deepEqual(client.modelChoices(groups, 'deepseek', 'retired-model'), [
      { value: 'deepseek-chat', label: 'DeepSeek Chat', unavailable: false },
      { value: 'deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash', unavailable: false },
      { value: 'retired-model', label: 'retired-model', unavailable: true },
    ])
  })

  it('offers only the saved model when its provider is also absent from the catalog', () => {
    assert.deepEqual(client.modelChoices(groups, 'Claude Code', 'claude-sonnet'), [
      { value: 'claude-sonnet', label: 'claude-sonnet', unavailable: true },
    ])
  })
})

describe('loadCatalog', () => {
  it('returns the provider groups from a successful catalog call', async () => {
    const remote = { session: { modelCatalog: async () => ({ ok: true, value: { groups } }) } }
    assert.deepEqual(await client.loadCatalog(remote), { status: 'ready', groups })
  })

  it('returns the failure text when the host rejects the call', async () => {
    const remote = {
      session: {
        modelCatalog: async () => ({ ok: false, error: { code: 'offline', message: 'Host is reconnecting' } }),
      },
    }
    assert.deepEqual(await client.loadCatalog(remote), {
      status: 'error',
      error: 'offline: Host is reconnecting',
    })
  })

  it('returns the thrown error text when the call throws', async () => {
    const remote = { session: { modelCatalog: async () => { throw new Error('network down') } } }
    assert.deepEqual(await client.loadCatalog(remote), { status: 'error', error: 'network down' })
  })
})

describe('RulesPage', () => {
  it('renders the one-liner for the summary view', () => {
    const t = (key: string) => key
    assert.equal(typeof client.RulesPage({ view: 'summary', t }), 'string')
  })
})
