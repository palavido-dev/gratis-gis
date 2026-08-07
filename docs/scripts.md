# Scripts

User-authored Python, stored as an item and run on the server.

The gap this fills is narrow and specific: a closed laptop does not run
a nightly job. API keys and the Python client already let you write and
run whatever you like against the portal from your own machine. What
the portal uniquely offers is a machine that is awake at 3am.

**This is not a hosted notebook.** There is no browser IDE, and adding
one is not planned. Authoring belongs in the editor you already use.
The item page is a text area for pasting the result, a Run button, and
a log.

## How a script talks to the portal

Over the public HTTP API, with an API key, through the `gratisgis`
Python client. There is no privileged in-process mode.

That is a deliberate constraint, and it buys three things:

1. The identical file runs on your laptop and on the server. No local
   dialect and hosted dialect to keep in step.
2. Writes go through the engine, so the observation log's bitemporal
   semantics hold. A direct database connection would let a script
   corrupt that model silently.
3. A script's authority is exactly its owner's. It cannot read a layer
   they cannot read, or write one they cannot write.

The runner injects two environment variables, so `from_env()` works
with no configuration:

```python
from gratisgis import GratisGIS

gg = GratisGIS.from_env()
layer = gg.find_items(type="data_layer", query="parcels")[0]
for feature in gg.iter_features(layer["id"], "parcels"):
    ...
```

## The key a run uses

Minted for that run, revoked when the run ends.

Nothing long-lived is stored beside the code. The key carries the
authority of whoever started the run and expires shortly after the
run's time limit, which is the backstop for the worker being killed
between minting and revoking.

A consequence worth knowing: a run's key is not the same key twice, so
a script cannot cache one, and there is nothing in the item to leak.

## What a script can and cannot reach

**Can:** the portal's HTTP API as its owner, and the public internet
(the parcel-refresh case needs to fetch from a county endpoint).

**Cannot:** the portal's database, object storage, or Keycloak
credentials. The child process environment is built from nothing
rather than inherited and filtered, so it holds the run's API key, a
PATH, a HOME, a locale, and a CA bundle path. Nothing else. A secret
added to the deployment later is private by default rather than
exposed until somebody remembers to update a deny list.

### Limitation: network reachability

The runner container sits on the same Docker network as the rest of
the stack, so a script can open a socket to `postgres:5432`,
`minio:9000`, and `keycloak:8080` even though it has no credentials for
any of them.

This is the honest state of the isolation today, and it is why the
feature is off by default and why the guidance below is what it is.
Container-level networking cannot distinguish the runner process
(which legitimately needs the database to claim work) from the script
it spawns. Fixing it properly means either splitting the claimer from
the executor into separate containers, or per-UID egress filtering
inside the container. Neither is in this release.

**Do not enable scripts on a portal where people you do not trust can
create items.** That includes any public or self-serve deployment. The
intended deployment is a portal whose editors are colleagues.

## Turning it on

Two switches, both off by default:

```
# .env.prod
PORTAL_SCRIPTS_ENABLED=1
```

```sh
docker compose --profile scripts up -d script-runner
```

The first makes the API offer the run endpoints and the web app offer
the item type. The second starts the container that executes runs.
Both are needed; either alone does nothing useful, which is
intentional, because turning on the endpoints without a runner would
queue work nothing consumes.

## Dependencies

Frozen. The runner image ships the `gratisgis` client plus `httpx`,
`requests`, `pandas`, `shapely`, `pyproj`, and `python-dateutil`. A
script that needs anything else does not run until the image is
rebuilt with it.

This is limiting on purpose for a first release. No `pip` at run time
means nothing reaches the package index from a scheduled job at 3am,
every run starts from an identical cached environment, and the
libraries people actually want will show up as requests rather than
being guessed at now.

To add one, edit `infra/script-runner/Dockerfile` and rebuild.

## Limits

| Limit | Default | Where |
|---|---|---|
| Wall clock per run | 300s | `SCRIPT_TIMEOUT_SECONDS` |
| Captured log | 256 KB | `SCRIPT_MAX_LOG_BYTES` |
| Memory | 1 GB | `mem_limit` on the compose service |
| Concurrent runs per script | 1 | not configurable |

A run that exceeds its time limit is killed with SIGKILL, not SIGTERM:
a timeout a script can install a handler for is not a timeout.

Output past the log limit is dropped with an explicit marker in the
log. A log that simply stopped would read as a crash.

## Running one

Edit access to the script, not read. A script shared read-only would
otherwise let a viewer execute the author's code under the viewer's
own credentials.

API keys are refused on the run and cancel endpoints. A key that could
start a run could cause more code to run under that same authority,
which is a short walk to a script that keeps itself alive. Starting
execution stays something a signed-in person does.

## Run history

Every run keeps its output, its exit code, and a snapshot of the
source as it was when the run started. The snapshot matters: opening a
month-old failure and seeing today's code is the one thing guaranteed
not to explain it.

The item page marks a run whose snapshot differs from the current
source, so a stale failure does not read as a live one.

## Scheduling

Not in this release. The run rows already carry a `trigger` column
recording `manual` or `schedule`, so history will not need a backfill
when the timer lands.
