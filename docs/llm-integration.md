# LLM integration

GratisGIS stays AGPL. Connecting a model is optional, and it is
off until an organization admin saves a provider and an API key.
The API does not call a model before that save.

An earlier note in this file required self-hosted models only and
ruled out OpenAI and Anthropic. That decision is superseded.
Operators may connect a commercial model or a local
OpenAI-compatible server. The portal does not ship a default
provider, and it does not phone home on its own.

## Providers

| id | What it calls |
| --- | --- |
| `openai` | `https://api.openai.com/v1/chat/completions` |
| `anthropic` | `https://api.anthropic.com/v1/messages` |
| `xai` | `https://api.x.ai/v1/chat/completions` |
| `openai-compatible` | The admin's base URL, for Ollama or a proxy. Example: `http://127.0.0.1:11434/v1` |

Commercial providers always use those official hosts. A base URL
is accepted only for `openai-compatible`. Link-local and
cloud-metadata addresses are refused. A local or private address
is allowed on purpose so Ollama on the same machine, or another
container, can be used.

## What this slice does

Authenticated users who can already read an item can ask for a
**draft**. The model sees the item title, description, and
schema or field names. A draft does not include feature
geometries or row attribute values. Asking a layer, documented
below, is the separate call that sends a bounded sample of
attribute text. The draft response is structured JSON: a
suggested map filter, a short layer summary, and/or a
form-field list.

The server does not write the item. The user copies the draft.

| Method | Path | Who |
| --- | --- | --- |
| `GET` | `/api/admin/ai` | Org admin. Config only: provider, model, base URL, and whether a key is saved. The key itself is never returned. |
| `PUT` | `/api/admin/ai` | Org admin. Save or replace the provider. Omit the key to keep the one already stored. |
| `DELETE` | `/api/admin/ai` | Org admin. Remove the provider and the key. |
| `GET` | `/api/ai/status` | Any signed-in user. `{ "configured": true \| false }`. |
| `POST` | `/api/ai/draft` | Any signed-in user who can read the item. Body: `{ "itemId", "instruction" }`. |
| `POST` | `/api/ai/build` | A contributor or admin. Body: `{ "instruction" }`. Creates layers, a map, a form, and a viewer app from the description. |
| `POST` | `/api/ai/features` | Any signed-in user who can read the data layer. Body: `{ "itemId", "question", "layerId"? }`. Answers from a sample of attribute text. |

Viewers and contributors cannot save a provider. API keys cannot
call `/api/admin/*` (the same `AdminGuard` as the rest of the
admin API). When nothing is saved, `/api/ai/draft` returns 409
with `code: "ai_not_configured"`. An item the caller cannot read
is a 404 from the same sharing check as `GET /api/items/:id`.

The key is encrypted with `CREDENTIAL_ENCRYPTION_KEY`, the same
AES-256-GCM cipher used for other stored credentials.

## Configuring a key

1. The API process needs `CREDENTIAL_ENCRYPTION_KEY` (32 bytes,
   base64). Generate one with
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
   if this deployment does not already have one. The same value
   has to stay stable or previously saved secrets will not decrypt.
2. Sign in as an organization admin.
3. Open **Admin → AI** (`/admin/ai`).
4. Choose a provider and type the model id from that provider.
   For Ollama or another local server, choose
   OpenAI-compatible and set the base URL. If that server does
   not check a key, any non-empty placeholder still has to be
   saved: no model call runs until a secret is stored.
5. Save. Clear removes the row. Leaving the key field blank on
   a later save keeps the stored key.

## Building from a description

`POST /api/ai/build` asks the model for a plan, checks it, and
then creates the items. The model sees the titles, geometry, and
field names of up to 30 data layers the caller can already read.
It does not see feature rows. A plan may reuse one of those
layers by id. Any other id is refused. New layers are empty:
the builder does not invent geometries.

The portal page is **Build** (`/assistant`). The Speak button uses
the browser's speech recognition and only fills the text box.
Choose **Build it** to create the items.

A viewer cannot call this endpoint. When no provider is saved
the response is 409 `ai_not_configured`, the same as drafts.

## Asking a layer

`POST /api/ai/features` answers a question about rows on a data
layer the caller can already read. The same page, **Build**
(`/assistant`), has an **Ask a layer** section. Speak fills the
question box the same way it fills a build description.

The server does not embed the layer. It searches attribute text
for a few words from the question, adds a short sample of rows
the caller can read (row scope and any geographic limit
included), and sends that attribute text to the provider.
Geometries are left out. The model may only name ids from that
sample; any other id is dropped. A layer with no readable rows
is answered without a model call.

This is a bounded sample, not a search of every row. A question
about a value that is not in the matched sample will not see
that row.

## Not in this slice

Vector embeddings are not stored, and a draft of an existing
item is still a suggestion the server does not write back.
