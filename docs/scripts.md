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

**Cannot:** the portal's database, object storage, or Keycloak. Two
independent reasons, which is the point.

*No credentials.* The child process environment is built from nothing
rather than inherited and filtered, so it holds the run's API key, a
PATH, a HOME, a locale, and a CA bundle path. Nothing else. A secret
added to the deployment later is private by default rather than
exposed until somebody remembers to update a deny list.

*No route.* The container that runs Python joins only `gg-script-net`,
which carries the executor, the claimer, and portal-api. `postgres`,
`minio`, and `keycloak` are not on it. A script cannot open a socket to
them at all, rather than opening one and lacking a password.

### Why two containers

Claiming work needs the database, and anything that needs the database
sits on a network where the database is reachable. Put the claiming
and the executing in one container and the script inherits that
reachability no matter what the environment says.

That was not hypothetical. On the original single-container design a
probe script reported:

```
REACHABLE  postgres:5432
REACHABLE  minio:9000
REACHABLE  keycloak:8080
```

It had no credentials for any of them, but "needs a password" is a
weaker property than "cannot open the socket", and only one of the two
survives a protocol-level CVE in one of those services.

The same probe after the split, deliberately **by raw IP address**
rather than by name:

```
postgres    172.18.0.3:5432  -> TimeoutError
minio       172.18.0.2:9000  -> TimeoutError
cloudflare  1.1.1.1:443      -> OPEN
portal-api                   -> resolves, answers, authenticates
```

By IP on purpose. The obvious version of this test uses hostnames and
reports a name-resolution error, which looks like a pass and is not
evidence of anything: a stopped container produces exactly the same
error as an unreachable one. That distinction is not academic. During
one round of this work the whole app tier happened to be down, every
name failed to resolve, and the isolation result looked perfect while
proving nothing. Addressing the container directly removes DNS from
the answer: the packets go out and nothing comes back.

The portal API still answers, the client still authenticates and reads
features (23,915 on the parcels layer, through the pager), and
outbound internet still works.

So the two responsibilities are two containers:

| | `script-runner` (claimer) | `script-executor` |
|---|---|---|
| Database | yes | **no** |
| Runs Python | **no** | yes |
| Networks | `gratis-net`, `gg-script-net` | `gg-script-net` only |

They talk over HTTP on the script network, authenticated with
`SCRIPT_EXECUTOR_TOKEN`. Network placement is the primary control; the
token is the backstop for the day something else lands on that
network.

Cancel is expressed as the claimer hanging up: aborting the request
makes the executor kill the child. That avoids a second endpoint and a
run-id registry on the executor that could leak entries when a claimer
dies mid-run.

`apps/portal-api/src/scripts/script-isolation.spec.ts` asserts this
topology against the compose file, because the isolation lives in
container configuration rather than in code, and a one-line edit could
undo it with nothing else noticing.

Egress to the public internet stays open. The case this feature exists
for is refreshing a layer from a county REST endpoint, so an
`internal: true` network would remove the reason to have it.

### Still worth knowing

A script runs as its own OS user (uid 10001), separate from the
executor process that supervises it. That separation is not cosmetic:
while the two shared a user, a script could read `/proc/1/environ` and
recover the executor's entire environment, including the token the
claimer authenticates with. Measured, then closed. A different uid
means the kernel refuses that read, and it also means a script cannot
signal or trace the process supervising it.

Each run gets a scratch directory of its own, reachable only by that
user, and the container caps what a runaway can take: 2 CPUs, 1 GB of
memory, 256 processes. Before those caps, a `while True: pass` had
every core on the box and a fork bomb reached roughly 9,000 processes.

Writes are capped too, and that one was missing for a while. CPU,
memory, and processes were limited while disk was not, so a script
could fill the host's root filesystem and take postgres and the site
down with it. Scratch is now a 256 MB tmpfs, which is charged to the
container's own memory cgroup: a run gets 1 GB across memory and
scratch together, and overrunning it kills the run rather than the
machine.

### The egress fence

Putting the executor on its own network stops it reaching postgres,
minio, and keycloak. Probing from inside it showed two things that it
does not stop, neither of them obvious:

- **The host, through the bridge gateway.** `172.19.0.1:22`, `:80` and
  `:443` all answered. No key, so no login, but "it would need a
  password" is the weaker property we already rejected for postgres.
- **`169.254.169.254`, the cloud metadata service.** Harmless on the
  Hetzner box we run the demo on, where user-data is empty and the
  key list is `[]`. Not harmless in general: on AWS, GCP, and Azure
  that address hands out the instance's IAM credentials to anything
  that asks. Since this is software other people self-host, leaving it
  open would mean anybody enabling scripts on a cloud VM gives
  arbitrary user code their instance role.

`infra/script-net-firewall.sh` closes both, applied at boot and
re-asserted every five minutes by `gg-script-firewall.timer`. A timer
rather than a one-time install because restarting Docker rebuilds its
iptables chains, and so does recreating the script network, which also
changes the subnet the rules are written against. The script reads the
subnet from Docker each time rather than hardcoding it, since a rule
pointing at a stale subnet fails open silently.

RFC1918 generally is deliberately left alone: a self-hosted portal may
well need to reach an internal server at 10.x, and blanket private-range
blocking would break that while adding little.

### Egress modes, and how to demo this safely

Public internet access is on by default, because refreshing a layer from
a county endpoint is the case the feature exists for.

`SCRIPT_EGRESS=portal-only` turns it off. Scripts keep the whole portal
API and lose everything else.

```
# .env.prod
SCRIPT_EGRESS=portal-only
```

This exists so a public demo can offer scripts at all. The reason not to
hand script authoring to strangers was never that they might escape the
sandbox: it is that open egress lets them make requests from your
server's address, and the abuse report arrives with your name on it.
Remove the egress and the objection goes with it.

What survives is most of what people actually write:

```
read a layer -> compute something -> write a new layer -> read the log
```

Measured on the demo box in `portal-only`: a script read 200 real
parcels, buffered them 100 m through shapely and pyproj, reported the
area, and got `URLError` on `https://example.com`. Same script in
`open` mode reaches the internet normally.

### Still true, and worth being clear about

- **A script can make arbitrary outbound requests from your server's
  IP.** That is the feature working as intended (fetching from a county
  endpoint is the whole point) and it is also the thing to weigh
  hardest before giving the ability to someone you do not trust.
- A script can read the executor image's contents. Nothing sensitive is
  there by construction, but it is a shared image, not a per-run
  sandbox, and `$HOME` persists between runs.
- Runs are serialised, one at a time, so a script that uses its whole
  time limit delays the next one.
- **The credential a script holds is a short-lived key carrying its
  owner's permissions**, so a script can do anything through the API
  that its owner could do by hand. This is the control that actually
  matters, and it is not a sandbox property: it is who you let create a
  script item. That is the contributor role.

On a portal where strangers can get accounts, including a public demo,
leave scripts off.

## Turning it on

Two switches, both off by default:

```
# .env.prod
PORTAL_SCRIPTS_ENABLED=1
# Shared secret between the claimer and the executor. Any long random
# string; `openssl rand -hex 32` is fine. The executor refuses every
# request when this is unset rather than defaulting to open.
SCRIPT_EXECUTOR_TOKEN=...
```

```sh
docker compose --profile scripts up -d script-runner script-executor
```

The first makes the API offer the run endpoints and the web app offer
the item type. The second starts the pair of containers. Both are
needed; either alone does nothing useful, which is intentional,
because turning on the endpoints with nothing consuming the queue
would just accumulate work.

## Dependencies

Frozen. The executor image ships the `gratisgis` client plus `httpx`,
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
| Memory | 1 GB | `mem_limit` on `script-executor` |
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

A script can run on its own: hourly, daily, weekly, or monthly, set on
the item page. The schedule lives on the item alongside the source, so
it versions with the code and restoring an old version restores the
cadence that version ran at.

Structured fields rather than a cron box, matching the backup and
housekeeping schedules. `0 3 * * 1` is not something a county GIS
technician should have to learn in order to refresh a layer on Monday
mornings. There is deliberately no custom-cron escape hatch yet; if
someone needs "every six hours" we would rather hear that as a request
than put a cron parser in front of everybody.

Three things worth knowing before you rely on it:

**Times are the server's clock.** Not the viewer's, and not UTC unless
the server is on UTC.

**A scheduled run acts as the item's owner**, not as whoever last
edited the schedule. Otherwise anyone with edit access could arrange
for code to run with the owner's permissions on a timer. If the owner's
account is deactivated the run does not happen, and the history says
so rather than failing quietly.

**Overlapping runs are skipped, visibly.** One run per script at a
time, so a fire that arrives while the previous run is still going is
recorded as `Skipped` instead of queued. That row exists on purpose: a
script whose schedule is tighter than its runtime loses most of its
runs, and a history showing nothing but successes would hide it.

### How it is wired

`ScriptScheduleService` runs in portal-api behind the cron leader lock,
registers one `CronJob` per scheduled script through `SchedulerRegistry`,
and only enqueues. The claimer in portal-worker picks the row up exactly
as it does for the Run button, so a scheduled run and a manual one are
the same code from that point on.

It re-reads schedules from the database once a minute rather than
hooking every path that could change one. The alternatives all had to
be notified by the generic item PATCH, the trash and restore endpoints,
the bulk housekeeping actions, and the nightly golden restore that
swaps the whole items table under a running process. That is more code,
and it is the kind that breaks the day someone adds an eleventh path.
A sweep cannot drift. The cost is that a change takes up to a minute to
apply, which is not worth engineering around for something whose finest
granularity is hourly.

`ScriptScheduleService` lives in its own module, imported by the API
graph only. It needs `SchedulerRegistry`, which the two worker graphs
have no reason to carry, and a provider that resolves at typecheck but
not at boot is how this project has taken production down twice.
