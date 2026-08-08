---
id: reference-scripts
title: Scripts
summary: Run Python on the portal, by hand or on a schedule, with a run history you can read afterwards.
category: reference
order: 47
complexity: intermediate
tags:
  - api
  - python
  - automation
  - scheduling
related:
  - reference-python-client
  - reference-api-keys
---

A **script** is an item that holds Python. The portal runs it on the
server, on demand or on a schedule, and keeps a history of every run
with its output.

The point is not the editor. Everyone running GratisGIS already has a
machine and an editor they prefer. The point is a computer that is
awake at 3am, so a layer that should be refreshed weekly actually is.

Scripts are off unless an administrator has turned them on. If you do
not see the item type, that is why.

## Writing one

Create a **Script** item, paste Python into the box, and press **Run
now**. Output appears in the run history below the editor, and each run
keeps a copy of the code exactly as it was when it started, so a
failure from last month is readable against the code that actually
failed.

The [`gratisgis`](/help/reference/python-client) client is installed
and already pointed at this portal:

```python
from gratisgis import GratisGIS

gg = GratisGIS.from_env()
print("running as", gg.whoami()["username"])
```

`from_env()` works because the portal puts a key for this run in the
environment. That key is created when the run starts, carries the
permissions of whoever the run acts as, and is revoked the moment the
run ends.

## Scheduling

Set **Run this script** to hourly, daily, weekly, or monthly, pick a
time, and save. Three things are worth knowing:

**Times are the server's clock**, which may not be yours.

**A scheduled run acts as the script's owner**, not as whoever last
edited the schedule. If the owner's account is deactivated, the
schedule stops and the history says so.

**Runs do not overlap.** One at a time per script. If a run is still
going when the next is due, the new one is recorded as *Skipped* rather
than queued. Seeing skipped runs pile up means the script takes longer
than the gap between runs.

A schedule change takes up to a minute to take effect.

## What a script can reach

**Your portal**, as its owner. Anything you can do through the API by
hand, a script can do: read layers, add and edit features, create
items. It cannot do more than its owner can.

**The internet**, so a script can fetch from a county REST endpoint or
any other public source. Some portals turn this off; if outbound
requests fail, ask your administrator.

**Nothing else.** A script cannot reach the database, object storage,
or the login server. It runs in a separate container, as its own user,
on a network where those are not routable, and none of their
credentials exist in its environment. Its scratch space, memory, CPU,
and process count are all capped.

## Libraries

Fixed, and deliberately so. Available:

`gratisgis`, `httpx`, `requests`, `pandas`, `shapely`, `pyproj`,
`python-dateutil`

There is no `pip` at run time, which means nothing reaches out to a
package index from a job at 3am and every run starts from an identical
environment. A script that worked last month works this month. If you
need something else, ask your administrator to add it to the image.

## Limits

- One run at a time per script.
- A time limit per run, five minutes by default, set on the item.
- 256 MB of scratch space, shared with the run's memory budget.
- Output is captured up to a size cap and then truncated, with a line
  saying so.

Exceeding the time limit stops the run and marks it failed. That is not
a suggestion the script can decline: it is killed outright, along with
anything it started.

## Reading a run

Each row in the history shows how it finished:

| | |
|---|---|
| **Succeeded** | Exited 0 |
| **Failed** | Exited non-zero, timed out, or crashed |
| **Cancelled** | Someone pressed Cancel |
| **Skipped** | A scheduled run that found the previous one still going |

Expand a row for the full output and the code that ran.

Make failures loud. Exit non-zero when something is wrong, so the
history shows a failure rather than a green row with a disappointing
log:

```python
import sys
from gratisgis import GratisGIS, PortalError

try:
    gg = GratisGIS.from_env()
    ...
except PortalError as err:
    print(f"failed: {err}", file=sys.stderr)
    sys.exit(1)
```

## For administrators

Two switches, both off by default:

```
PORTAL_SCRIPTS_ENABLED=1
SCRIPT_EXECUTOR_TOKEN=<a long random string>
```

```sh
docker compose --profile scripts up -d script-runner script-executor
```

Before you turn this on, the question to ask is not whether the sandbox
holds. It is **who can create a script item**, because a run carries its
owner's permissions and can make outbound requests from your server's
address. That is the contributor role. On a portal where strangers can
sign up, leave scripts off, or run with outbound access disabled.

## See also

- [Python client](/help/reference/python-client) — the library scripts use
- [API keys](/help/reference/api-keys) — for running the same code elsewhere
