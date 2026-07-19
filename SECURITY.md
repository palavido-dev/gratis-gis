# Security Policy

GratisGIS is an open-source, self-hosted GIS portal. We take security
seriously and want to work with the community to keep the project safe
for everyone who runs it.

## Reporting a vulnerability

Please report suspected security issues privately, by email, to:

    mmatthew.palavido@gmail.com

If your finding involves data that should not be sent in cleartext
(credentials, exploit proofs, screenshots of private data), say so in
your first email and we will set up an encrypted channel before you
share details.

Please do not file a public GitHub issue, post to Reddit or Twitter, or
mention the issue in a community Discord/forum before we have had a
chance to look at it. See "Coordinated disclosure" below.

## What to include

A useful report typically has:

1. A short description of the issue and the impact you observed.
2. The affected component (e.g. `portal-api`, `portal-web`, the
   Keycloak realm, the Docker stack).
3. A reproducer: URL, request, payload, or steps. A `curl` command or
   a small script is ideal.
4. Versions involved (the public preview at gratisgis.org is on the
   latest `main`; if you tested a self-hosted install, the commit
   hash helps).
5. Any suggested mitigation if you have one.

## Our response timeline

- We will acknowledge your report within 72 hours.
- Within 14 days we will give you a status update: either a fix has
  shipped, a fix is in progress with an ETA, or we have decided not
  to act (and why).
- Once a fix is public, we will credit you in the hall of fame below
  unless you ask to stay anonymous.

GratisGIS is currently maintained by a single developer; we will not
always be able to ship a fix as fast as a larger project would. We
will be honest about the timeline.

## Scope

In scope:

- The hosted public preview at `gratisgis.org` and its subdomains.
- The `portal-api` (NestJS backend) source in this repository.
- The `portal-web` (Next.js frontend) source in this repository.
- The Docker stack under `infra/` as published (Postgres + PostGIS,
  Keycloak, MinIO, `pg_tileserv`).
- Misconfigurations in the documented self-hosted deployment that
  would expose data or escalate privileges.

Out of scope:

- Third-party services we depend on but do not operate. If the
  vulnerability is in Keycloak, MinIO, PostgreSQL, or pg_tileserv
  itself, please report it upstream to those projects; if it is a
  misconfiguration in how we ship them, that is in scope.
- The ArcGIS Online mirror endpoints exposed via the
  `arcgis_service` item type. These point at Esri-operated services
  we do not control.
- Demo accounts (any user matching `tester-*`). They reset nightly,
  carry no real data, and are intentionally low-privilege test
  fixtures. Findings against them are not eligible for credit unless
  they reveal a portal-wide issue.
- Social engineering, physical attacks, denial-of-service via raw
  traffic volume (we are a small project on modest hardware; DoS
  resilience is not a goal for the public preview).
- Reports generated solely by automated scanners with no manual
  validation. We are happy to look at scanner output if you can
  point at a specific finding and explain why it matters in our
  context.

## Safe harbor

We want good-faith security research and will not pursue legal action
against researchers who:

- Make a good-faith effort to avoid privacy violations, data
  destruction, and service disruption.
- Only access data that is necessary to demonstrate the
  vulnerability, and do not exfiltrate, retain, or share it.
- Give us reasonable time to respond before public disclosure (see
  below).
- Do not engage in extortion or demand payment as a condition of
  disclosure.

If you are not sure whether something falls inside safe harbor,
email and ask. We would rather have the conversation than have you
sit on a finding.

## Coordinated disclosure

We ask that you do not publish details (including on Reddit, Twitter,
Mastodon, Bluesky, personal blogs, or conference talks) until either:

- A fix has shipped, or
- 90 days have passed since your initial report, whichever comes
  first.

If the issue is being actively exploited and we are slow to
respond, please tell us; we will work with you on a faster
disclosure window.

## Hall of fame

Thank you to the researchers who have responsibly disclosed issues
in GratisGIS:

- Anonymous reporter on Reddit, 2026-05-17. Flagged that the
  Keycloak master realm administrative console was reachable on the
  public edge. Fixed by locking down the master realm at the Caddy
  reverse proxy.
