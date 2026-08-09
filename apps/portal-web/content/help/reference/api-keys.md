---
id: reference-api-keys
title: API keys
summary: Connect scripts, notebooks, and scheduled jobs to your portal without signing in through a browser.
category: reference
order: 45
complexity: intermediate
tags:
  - api
  - integration
  - automation
  - python
related:
  - reference-mcp-server
  - reference-item-types
---

An API key lets something other than a browser talk to your portal:
a Python notebook on your laptop, a nightly script on a server, a
continuous-integration job, or the MCP server.

A key acts as **you**. It sees exactly the items you can see, honours
the same sharing rules and geographic limits, and can change only what
you could change in the portal. Nothing about a key widens your access.

## Create one

1. Open **Profile**, then **API keys**.
2. Give the key a name that says what it is for, like
   `nightly parcel refresh`. Future you will be glad.
3. Choose when it expires. A bounded key is the safer default; pick
   **Until revoked** only when re-keying a job on a schedule is worse
   than the risk of a long-lived credential.
4. Leave **Read only** ticked unless the script needs to write.
5. Copy the key. **This is the only time it is shown.** The portal
   stores a one-way hash, so nobody, including an administrator, can
   recover it later. Lose it and you make a new one.

## Use one

Send it as a bearer token:

```bash
curl -H "Authorization: Bearer ggk_your_key_here" \
  https://your-portal.org/api/users/me
```

From Python, use the client package. See
[Python client](/help/reference/python-client) for the full guide.

```bash
pip install gratisgis
```

```python
from gratisgis import GratisGIS

gg = GratisGIS("https://your-portal.org", api_key="ggk_...")
layer = gg.find_items(type="data_layer", query="parcels")[0]
fc = gg.read_features(layer["id"], "parcels", limit=500)
```

Keep the key out of your source. Set `GRATISGIS_URL` and
`GRATISGIS_API_KEY` in the environment and call
`GratisGIS.from_env()` instead, which also means the same script runs
unchanged on your laptop and on a server.

## What a key cannot do

Three limits are deliberate:

- **Admin pages are off limits.** Even a key made by an administrator
  is refused on admin endpoints. Automation needs data, not user
  management, and this keeps a leaked key from becoming an
  administrative one.
- **Keys cannot manage keys.** A key cannot create or revoke keys,
  because minting a credential from a credential would let a leaked
  read-only key promote itself.
- **Read-only means read-only.** A key marked read-only is refused on
  anything that creates, changes, or deletes.

## Revoking

Revoke from the same page. It takes effect immediately: the next
request using that key fails. Revoked keys stay listed so you keep the
record of what existed.

Keys also stop working the moment the owning account is disabled or
deleted, without any extra step.

## Good practice

- One key per job, named for the job. When something misbehaves you
  can revoke exactly it, and the **last used** column tells you what
  is actually still in service.
- Read-only wherever the work allows.
- Rotate anything that has been pasted into a chat, a ticket, or a
  screenshot. Minting a replacement takes seconds.
- Treat a key like a password in your secret store, not like a
  configuration value in a repository.
