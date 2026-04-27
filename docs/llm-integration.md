# LLM integration: design doc

A phased plan for adding local-first, open-source LLM features to
GratisGIS. The goal is to make the portal substantially more
useful for non-developers (semantic search, schema authoring help,
natural-language Q&A) without breaking the project's "your
hardware, your data" promise.

This doc is the design we're agreeing to before any code lands.
Phase 1 is small enough to ship as a working MVP; later phases
build on the same infrastructure.

## Why this is a fit, specifically

GratisGIS already differs from ArcGIS Online on one axis the
market is currently moving toward: **everything runs on your
hardware.** ArcGIS Online's AI features are increasingly cloud-
only and meter your tokens against a vendor account, which
inverts the same data-residency story we tell against them. If
we add AI features, they should align with the existing pillars,
not contradict them.

That means:

- **Self-hosted inference.** No OpenAI / Anthropic / Google
  Vertex calls. Models run in the same Docker compose stack as
  Postgres and Keycloak.
- **Permissive licensing.** Default models must be MIT or
  Apache 2.0 so we can redistribute without legal footnotes.
  Llama-licensed models can be opt-in alternatives but never
  the default.
- **Opt-in.** An org admin who doesn't want LLMs in their stack
  flips a single env flag and the feature is gone. The compose
  file ships them disabled by default.
- **Auth-bounded.** Every LLM call goes through the same
  `visibleWhere` gate as the rest of the API. A sharee asking
  "what data do I have on parcels" can only get answers from
  items they could already see.
- **Drafts, not commits.** LLM-generated content lands as a
  proposal the user reviews and accepts. We never auto-apply
  schema changes, never auto-write data, never auto-share.
- **Reproducible.** Model versions are pinned. "Last week the
  LLM said X" means the same thing today.


## Use cases, scoped

Four discrete features, listed by increasing scope and increasing
hallucination risk. Phase numbers are commitments to ourselves;
each phase ships independently.

### Phase 1: Semantic search over items

The items page's search bar today does substring matching against
title / description / tags. Phase 1 adds **meaning-aware** search:
"bird surveys" matches an item titled "Avian Point Count Survey
2025" without the literal word overlap.

Mechanics:

- Every item gets an **embedding** computed from
  `title + description + tags + (for data layers) field names +
  sample values`. Stored in a new pgvector column on `item`.
- The search bar fires both a substring query AND a vector
  similarity query, merges results, ranks by reciprocal-rank
  fusion. Substring still wins on exact name matches; vector
  fills in the long tail.
- The vector query honours `visibleWhere`, so a sharee never
  gets vector hits for items they cannot see.

Why this is the obvious first slice: zero hallucination risk
(it's a ranking change, not a generation step), small surface
area (one column + one query path), high quality-of-life win.

### Phase 2: Schema / form / editor authoring assistant

Free-text input → proposed item config the user reviews and
accepts. Examples:

- "I want to track tree health surveys with species, condition,
  and photos" → a proposed `data_layer` schema with three fields
  (species as a pick list ref, condition as a pick list, photos
  as a string field with attachment hint), plus a proposed
  `editor` item exposing it.
- "Add a column for surveyor initials" → a proposed migration
  on an existing data layer.
- "Build me a map of all the inspection items" → a proposed
  `map` item composing the layers the user has access to.

Mechanics:

- Each surface (data-layer wizard, editor wizard, map wizard)
  gets a **"Describe what you want" textarea** above the manual
  fields.
- The LLM emits structured JSON matching the wizard's existing
  schema (we already have these types in `packages/shared-types`).
- The wizard fills in from that JSON; the user can accept,
  edit, or discard.
- Output validation: the LLM's JSON is parsed against the
  schema before any UI mutation. Invalid output gets retried
  once with the schema error in the system prompt; second
  failure shows "couldn't generate, please try rephrasing".

Hallucination risk: medium, but bounded. The user reviews
everything; the LLM never persists.

### Phase 3: Natural-language Q&A over portal data

"Show me all parcels in Beaumont over 5 acres updated this month."
Translates to a safe filter chain against the user's accessible
data layers, runs the query, returns a feature collection +
narrative summary.

Mechanics:

- A **deterministic query planner** sits between the LLM and
  the database. The LLM emits a structured filter expression
  (already a shape we support, see `MapLayerFilter` in
  `shared-types`). The planner refuses anything outside that
  shape: no raw SQL, no `JOIN`s the planner doesn't already
  know about.
- The planner executes through the same v3 features service
  the editor uses, which already enforces share + geo-limit
  + row-scope.
- The LLM also generates a one-paragraph natural-language
  summary of the results, grounded in the actual returned
  features.

Hallucination risk: this is where things get real. We mitigate
with the planner's strict whitelist + showing the user the
generated filter before running ("we're going to query parcels
with `acres > 5 AND city = 'Beaumont' AND updated_at > 2026-04-01`,
proceed?"). The user can edit the filter before execution.

### Phase 4: RAG-grounded in-product help

"Ask the docs" pane that knows about GratisGIS itself. The user
asks "how do I do per-row sharing", the LLM retrieves the
relevant `docs/*` sections via embedding similarity and answers
in the user's own words.

Same stack as Phase 1 (embeddings) + Phase 2 (small LLM). The
docs are part of the repo so the embedding index is built at
deploy time, not user-time.

Hallucination risk: medium. Mitigated by always citing the docs
section the answer came from, with a deep link.


## Tech choices

### Inference runtime

| Runtime | Where | Why |
| --- | --- | --- |
| **Ollama** | Local dev (Mac, Linux, Windows) | One-line install, pulls models like Docker images, OpenAI-shaped API, native Apple Silicon. |
| **vLLM** | Production servers with NVIDIA GPUs | High throughput, batched inference, OpenAI-shaped API. |
| **llama.cpp** | Edge / no-GPU servers | Bare metal, smallest footprint, runs on CPU when needed. |

All three expose the OpenAI chat-completion API shape, so we
write one client (`@gratis-gis/portal-api/src/llm/llm.client.ts`)
and configure the base URL per deployment.

### Models

The defaults must be MIT or Apache 2.0. Llama / Gemma models can
be opt-in alternatives via env config but never the default.

| Slot | Default | Alternative |
| --- | --- | --- |
| Embeddings | `nomic-embed-text` (Apache 2.0, ~270 MB, 768-dim, top-tier on retrieval) | `bge-small-en-v1.5` (MIT, ~33 MB, fastest) |
| Chat (small) | `phi-3.5-mini-instruct` (MIT, 3.8B, runs on CPU) | `qwen2.5:7b-instruct` (Apache 2.0) |
| Chat (medium) | `mistral-7b-instruct` (Apache 2.0, 7B) | `qwen2.5:14b-instruct` (Apache 2.0, 14B) |

Phase 1 (semantic search) only needs the embedding model, which
is small and fast. Phases 2-4 use the chat models.

### Vector store

`pgvector`. Already a one-line Postgres extension; we already use
Postgres. No new infrastructure to operate.

```sql
CREATE EXTENSION IF NOT EXISTS vector;
ALTER TABLE "item" ADD COLUMN embedding vector(768);
CREATE INDEX item_embedding_hnsw_idx
  ON "item" USING hnsw (embedding vector_cosine_ops);
```

768 dimensions matches the default embedding model's output.
HNSW is the right index for our scale (tens of thousands of
items per org, not billions).

### Where the code lives

```
apps/portal-api/src/llm/
├── llm.module.ts
├── llm.controller.ts        REST: /llm/search, /llm/chat, /llm/embed
├── llm.service.ts           Top-level orchestration
├── embedding.service.ts     Phase 1: embed + similarity
├── authoring.service.ts     Phase 2: structured-output assistant
├── query-planner.service.ts Phase 3: NL -> safe filter
├── rag.service.ts           Phase 4: docs RAG
└── llm.client.ts            Thin OpenAI-shape HTTP client
```

```
infra/docker-compose.yml
└── ollama service (opt-in via OLLAMA_ENABLED=1, off by default)
```

The `llm` feature flag in env determines whether
`/llm/*` routes are mounted at all. Off by default; admins flip
it on after deciding which models to pull.

### Frontend surface

A sidebar pane that lives at the right edge of the layout, opens
from a small **Ask** icon next to the user menu. The pane:

- Shows recent semantic-search results (Phase 1)
- Has a chat input for free-text questions (Phases 2-4)
- Always renders sources / citations for any LLM-generated
  content
- Disabled (icon hidden) when `LLM_ENABLED` is false

The pane is implemented in `apps/portal-web/src/components/llm-pane.tsx`
and mounted in the root layout.


## Phase 1 implementation slice

Concrete enough to start implementing without further design.

### Schema migration

```sql
-- migrations/<timestamp>_add_item_embeddings.sql
CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE "item"
  ADD COLUMN embedding vector(768),
  ADD COLUMN embedding_model text,
  ADD COLUMN embedding_text_hash text,
  ADD COLUMN embedding_updated_at timestamp(3);

CREATE INDEX item_embedding_hnsw_idx
  ON "item" USING hnsw (embedding vector_cosine_ops);
```

`embedding_model` records which model produced the vector so we
can re-embed when we swap. `embedding_text_hash` is a SHA256 of
the source text; we skip re-embedding if the source hasn't
changed. `embedding_updated_at` lets the housekeeping job find
items that need re-embedding (new fields, new sample data).

### Embedding pipeline

A `BackfillEmbeddingsJob` runs on api boot (idempotent) plus on
a 15-minute interval:

1. Find items where `embedding_text_hash` doesn't match the
   current source-text hash, in batches of 50.
2. Build the source text:
   - Always: `title + "\n" + description + "\n" + tags.join(", ")`
   - For `data_layer`: append `field names + first 5 distinct values per field`
   - For `map`: append `layer titles + their data sources' titles`
   - For `editor`: append `target layer titles + the referenced map's title`
3. Hash the source text. If the hash matches stored, skip.
4. POST to the embedding endpoint, get a vector.
5. Update the row.

This is the same pattern the existing `lastUsageAt` and
`recompute-extents` jobs use, so the operational shape is
familiar.

### Search query

`/api/portal/items` already accepts `q=`. We extend it:

```typescript
// In items.service.ts list()
if (opts.q) {
  // Existing substring search builds where.OR clauses.
  // ADD: a parallel embedding query, then merge.
  const queryEmbedding = await this.llm.embed(opts.q);
  const vectorHits = await this.prisma.$queryRaw<{ id: string; score: number }[]>`
    SELECT id, 1 - (embedding <=> ${queryEmbedding}::vector) AS score
    FROM "item"
    WHERE embedding IS NOT NULL
      AND deleted_at IS NULL
      AND ${visibleWhereSql}
    ORDER BY embedding <=> ${queryEmbedding}::vector
    LIMIT 50
  `;
  const vectorIds = vectorHits.map((r) => r.id);

  // Reciprocal-rank fusion: combine with substring-rank order.
  // Items that hit both rank highest. Pure-vector hits surface
  // below pure-substring on tied scores so an exact title match
  // always wins.
}
```

Single round-trip overhead: ~30-50 ms on a Mac Mini once the
embedding service is warm.

### Failure modes

- **LLM service down**: fall back to the existing substring search.
  Log a warning, don't block the page.
- **Embedding model swapped**: the backfill job re-embeds every
  item. Log progress. Old vectors stay queryable with a stale
  `embedding_model` until they're rewritten.
- **pgvector extension missing**: detected at boot; the LLM
  module refuses to start with a clear error. Admins enable the
  extension once.

### Observability

- `/api/portal/admin/llm-stats` (admin-only) shows: items
  embedded vs total, last backfill run, average embedding latency,
  search calls per hour.
- Server logs include a `llm:` prefix on every embedding /
  inference call with timings.


## Risks and how we handle them

### Hallucinations on schema or data

The mitigation is structural, not just prompt engineering:

- **Phase 2** outputs are validated against TypeScript types
  before any UI mutation. Invalid output is retried with the
  schema error included; a second failure surfaces "couldn't
  generate" rather than guessing.
- **Phase 3** uses a deterministic query planner. The LLM emits
  a structured filter expression, not SQL. Anything outside the
  whitelist is refused.
- **Every** generated artifact is a draft the user accepts.
  We never auto-apply schema changes, never auto-write data,
  never auto-share.

### Resource budget

A 7B model in 4-bit quant needs ~5-6 GB of RAM for inference
plus ~4 GB for the embedding model staying loaded. We surface
this in `docs/SETUP.md` and in the deployment doc:

| Stack | RAM floor | What you give up |
| --- | --- | --- |
| GratisGIS without LLM | 4 GB | LLM features off |
| LLM enabled, embeddings only (Phase 1) | 6 GB | No chat features yet |
| LLM enabled, full chat (Phases 2-4) | 12 GB | None |

The single-VM installer detects available RAM and recommends an
LLM mode at install time.

### Auth boundary

Every `/llm/*` endpoint runs through the existing JwtAuthGuard +
sharing checks. Concretely:

- The embedding-search query is filtered by `visibleWhere(user)`
  before the vector ANN runs (filtered top-K, not post-filtered).
- The Phase 3 query planner runs through the v3 features
  service, which enforces share + geo-limit + row-scope as it
  already does for the editor.
- The Phase 4 RAG retriever indexes only the public `docs/*`
  files; user data never enters the docs index.

### Reproducibility

Model versions are pinned. The `LLM_DEFAULT_MODEL` env var
includes a version tag (`mistral-7b-instruct:0.3`); deployments
that change models record an audit event. Admins can configure
"freeze on" so production never auto-updates.


## Open questions

- **Streaming?** Phase 2-4 will benefit from streamed responses
  (the user sees the schema-draft populate token by token). The
  Ollama / vLLM API supports SSE; we'll wire it from day one.
- **GPU passthrough in Docker on Mac?** Apple Silicon has Metal
  but no Docker GPU passthrough today. Ollama runs natively on
  the host on Mac (not in a container) for that reason; the
  compose file points the api at `host.docker.internal:11434`
  on Mac. Linux deployments with NVIDIA GPUs use the standard
  `--gpus all` setup.
- **Multi-tenancy.** A single LLM instance serving multiple orgs
  is fine for inference (stateless), but we need to make sure
  one org's prompt never includes another org's data. The auth-
  bounded retrieval handles this on the input side; the model
  itself has no cross-org memory.
- **Cost reporting.** Local LLMs have no per-token cost, but
  they have a real RAM / electricity cost. We'll surface a
  rough "this org used ~X embeddings, ~Y chat tokens this week"
  number on the housekeeping dashboard so admins can plan.


## Roadmap commitment

| Phase | Scope | Why this order |
| --- | --- | --- |
| **1** | Semantic search + pgvector + nomic-embed | Smallest slice with the highest user-visible win. No hallucination surface. Validates the operational shape of running an LLM service. |
| **2** | Schema / form / editor authoring assistant | Real generation, but bounded by structured output + user review. Pairs with the existing wizards. |
| **3** | NL query over portal data | Higher hallucination risk; needs the deterministic query planner. Builds on Phase 1's embeddings + Phase 2's structured-output discipline. |
| **4** | RAG-grounded help pane | Lowest risk of the generation phases (we control the corpus). Ships once Phase 1's embedding pipeline is mature. |

Phase 1 is sized at ~1 week. Phases 2-4 are larger; we'll
re-design each at the slice boundary based on what we learn from
the previous one.


## Out of scope for this design

- **Image / multimodal models.** The "describe a satellite tile"
  use case is interesting but out of scope until we know we have
  a real audience asking for it.
- **Fine-tuning.** All initial use cases are well-served by
  prompt engineering + RAG against off-the-shelf models. We'll
  revisit if a specific use case clearly needs adapter weights.
- **Voice.** Speech-to-text / text-to-speech is a real
  field-collection accessibility win; out of scope here, may
  come up in a separate doc when the mobile field app lands.
- **Cross-portal federation.** Asking one GratisGIS instance
  about another org's items is explicitly never a feature; the
  data-residency promise is the whole point.
