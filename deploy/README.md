# Deploy

The real deployment tooling lives in [`/infra`](../infra/), not here.
This directory only carries the placeholder for the future
`get.gratisgis.org` one-liner endpoint.

What actually exists today:

| Path | Purpose |
| --- | --- |
| `../infra/docker-compose.prod.yml` | Production Compose stack (single-host deploy behind Caddy) |
| `../infra/deploy.sh` | Idempotent build-and-roll deploy script |
| `../infra/install.sh` | Working single-command installer (clone, guided setup, deploy) |
| `../infra/setup.sh` | Guided first-run configuration (writes `.env.prod`) |
| `../infra/doctor.sh` | Read-only deployment diagnostics |
| `../infra/systemd/` | Host-side units (docker cleanup, demo reset) |
| `installer/install.sh` | `get.gratisgis.org` placeholder; exits 1, see below |

There is no `docker-compose/` or `helm/` directory here. A Kubernetes
Helm chart is a possible future addition (tracked on the roadmap), but
nothing ships yet, and this README should only ever describe what
exists.

`installer/install.sh` is intentionally inert: if it is ever served at
`get.gratisgis.org` before being finished, it must refuse loudly
rather than half-install a stack. Until it is implemented, point
people at:

```sh
curl -fsSL https://raw.githubusercontent.com/palavido-dev/gratis-gis/main/infra/install.sh | bash
```

See [../docs/deployment.md](../docs/deployment.md) for admin-facing
documentation.
