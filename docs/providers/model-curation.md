# Provider model curation storage

Providers may store a per-provider "visible models" curation in the
`config_json` column of their `providers` record:

```json
{
  "models": [{ "id": "kimi-k3", "name": "Kimi K3" }]
}
```

The list uses the `CuratedModel` shape (`{ id, name? }`, exported from
`@hyperneo/shared/provider`). Any writer may add provider-specific fields
next to `models` (ACP stores `command`, Kimi stores `region`) — writers must
MERGE their field into the parsed object instead of replacing `config_json`
wholesale, or they silently erase a stored curation. The Kimi region editor
and the ACP editor both merge on save; a nonempty `models` array whose
entries are all invalid parses as absent (no curation), never as `[]`.

## Storage semantics: empty ≠ absent

- `models: []` — deliberate "no visible models". The provider exposes no
  models to pickers.
- `models` absent (or not an array) — no curation. The provider's default /
  discovered model list applies unchanged.

Parsing and application happen in the provider-sync path
(`packages/daemon/src/lib/providers/provider-sync.ts`): `parseProviderConfig`
reads the field, and `syncProviderToRegistry` stores it centrally in the
`ProviderRegistry` for every provider, so the model-service read and
validation seams enforce it regardless of provider support. Providers that
implement the optional `Provider.setCuratedModels` method additionally
receive the parsed list for provider-local behavior such as model synthesis;
`AcpProvider` is the reference implementation.

## Session-write gates (create/update)

Curation also gates the session-write RPCs. `session.create` rejects a
requested model that a configured curation filters out for the explicit
provider (`SessionLifecycle.getValidatedModelId` throws before resolving),
and `session.update` rejects a `config.model` write that would move a session
onto a curated-out model. Both gates use `isCuratedOutModel`
(`packages/daemon/src/lib/model-service.ts`): a model counts as curated-out
only when the provider has a configured curation, the model fails the
filtered `isValidModel`, and the model is still known to that provider
through the unfiltered raw cache or unfiltered static metadata. A model the
daemon does not know at all (for example an arbitrary model ID for a custom
provider) is not treated as curated-out — explicit-provider passthrough for
unknown models is unchanged, with or without curation.

`session.update` additionally permits rewriting the session's own current
model and provider verbatim, so read-modify-write clients round-tripping a
pinned session's config keep working (see below).

### Existing sessions on curated-out models: pin-and-keep

When a model that existing sessions already use becomes curated out, those
sessions are pinned, not invalidated: they keep running on the configured
model, `session.model.get` keeps resolving its metadata through the
unfiltered seams, and `session.update` calls that do not touch `config.model`
succeed. Curation only gates new writes — creating a session on the model,
switching onto it, or updating a session's `config.model` to it. Switching
away and back is blocked by the same `isValidModel` seam as any other switch.

## Migration note: existing empty-`models` ACP configs

Before this contract was defined, `AcpProvider` mapped a persisted empty
curation back to its synthetic default model (`acp-default`). A config saved
with `"models": []` therefore meant "use the default", matching how the ACP
editor reset its model list whenever the command changed.

With the generalized contract, `models: []` now means "no visible models".
Existing ACP records that store an empty `models` array will show no models
after upgrading. To restore the previous behavior, clear the field entirely
(absent = no curation → the `acp-default` model applies) — in the ACP editor,
change and re-save the command without touching the model list, or edit the
record's `config_json` to remove the `models` key. The ACP editor itself no
longer writes `models: []` when a command change resets the list; it only
persists an empty array when the user deliberately removes every model for an
unchanged command.
