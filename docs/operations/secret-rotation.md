# Secret rotation

Rotating `CREDENTIAL_ENCRYPTION_KEY` (the key for stored application credentials) is not supported yet.

`GRATIS_SIGNING_SECRET` (ArcGIS Pro and QGIS sign-in tokens) can be
changed at any time. Set a new random value (`openssl rand -base64 36`)
in `infra/.env.prod` and run `./infra/deploy.sh`. On a NAS, delete the
`GRATIS_SIGNING_SECRET` line from `env` on the `boot` volume and start
the app again; the bootstrap generates a new one. Tokens signed
with the old value stop working at once. They last at most 60 minutes
anyway, and ArcGIS Pro and QGIS ask the user to sign in again.
