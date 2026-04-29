# Initializing git & pushing to GitHub

The scaffolded repo lives in your selected folder. I couldn't run `git init`
inside it for you (the Cowork mount doesn't support git's internal file
renames), but it's a one-liner on your side.

## From your terminal (one-time)

### macOS / Linux / WSL

```bash
cd /path/to/gratis-gis     # wherever you selected this folder

# If a stale .git directory exists (left over from a partial init in
# Cowork), remove it first. It only has default hook samples and no history:
rm -rf .git

git init -b main
git add -A
git commit -m "chore: scaffold GratisGIS monorepo"
```

### Windows (cmd.exe)

```cmd
cd C:\path\to\gratis-gis

:: Clear read-only/system attributes the Cowork mount may have set,
:: then remove the stale .git directory:
attrib -r -h -s .git\*.* /s /d
rmdir /s /q .git

git init -b main
git add -A
git commit -m "chore: scaffold GratisGIS monorepo"
```

### Windows (PowerShell)

```powershell
cd C:\path\to\gratis-gis

Get-ChildItem .git -Recurse -Force | ForEach-Object { $_.Attributes = 'Normal' }
Remove-Item -Recurse -Force .git

git init -b main
git add -A
git commit -m "chore: scaffold GratisGIS monorepo"
```

If Windows still refuses to remove `.git` (unusual ACLs left by the mount):

```cmd
takeown /f .git /r /d y
icacls .git /grant "%USERNAME%":F /t
rmdir /s /q .git
```

### Then, regardless of OS, create the GitHub repo

Option A, with the GitHub CLI:

```bash
gh repo create gratis-gis --public --source=. --remote=origin --push
```

Option B, manually: create https://github.com/palavido-dev/gratis-gis (or your preferred name), then:

```bash
git remote add origin git@github.com:<your-user>/gratis-gis.git
git push -u origin main
```

## Apply repo description and topics for discoverability

Do this right after creating the repo so the About box and topics show up
from day one. See [docs/discoverability.md](./docs/discoverability.md) for
rationale.

### macOS / Linux / WSL (bash)

```bash
gh repo edit palavido-dev/gratis-gis \
  --description "Open-source, self-hosted geospatial portal. Web maps, app builder, offline field collection, notebooks, and a visual tool builder. Built on PostGIS + MapLibre." \
  --homepage "https://github.com/palavido-dev/gratis-gis" \
  --add-topic gis --add-topic geospatial --add-topic mapping --add-topic webgis \
  --add-topic open-source-gis --add-topic open-source --add-topic self-hosted \
  --add-topic postgis --add-topic maplibre --add-topic offline-first \
  --add-topic field-data-collection --add-topic form-builder --add-topic survey \
  --add-topic jupyter --add-topic keycloak --add-topic typescript \
  --add-topic nextjs --add-topic nestjs --add-topic react-native --add-topic monorepo
```

### Windows (cmd.exe) - line continuation is `^`

```cmd
gh repo edit palavido-dev/gratis-gis ^
  --description "Open-source, self-hosted geospatial portal. Web maps, app builder, offline field collection, notebooks, and a visual tool builder. Built on PostGIS + MapLibre." ^
  --homepage "https://github.com/palavido-dev/gratis-gis" ^
  --add-topic gis --add-topic geospatial --add-topic mapping --add-topic webgis ^
  --add-topic open-source-gis --add-topic open-source --add-topic self-hosted ^
  --add-topic postgis --add-topic maplibre --add-topic offline-first ^
  --add-topic field-data-collection --add-topic form-builder --add-topic survey ^
  --add-topic jupyter --add-topic keycloak --add-topic typescript ^
  --add-topic nextjs --add-topic nestjs --add-topic react-native --add-topic monorepo
```

### Windows (PowerShell) - line continuation is backtick `` ` ``

```powershell
gh repo edit palavido-dev/gratis-gis `
  --description "Open-source, self-hosted geospatial portal. Web maps, app builder, offline field collection, notebooks, and a visual tool builder. Built on PostGIS + MapLibre." `
  --homepage "https://github.com/palavido-dev/gratis-gis" `
  --add-topic gis --add-topic geospatial --add-topic mapping --add-topic webgis `
  --add-topic open-source-gis --add-topic open-source --add-topic self-hosted `
  --add-topic postgis --add-topic maplibre --add-topic offline-first `
  --add-topic field-data-collection --add-topic form-builder --add-topic survey `
  --add-topic jupyter --add-topic keycloak --add-topic typescript `
  --add-topic nextjs --add-topic nestjs --add-topic react-native --add-topic monorepo
```

## Verify CI

Once pushed, GitHub Actions will automatically run `.github/workflows/ci.yml` (install, lint, typecheck, test, build). The green check confirms the
scaffold compiles end-to-end in a clean environment.

## Recommended repo settings on GitHub

- **Default branch:** `main`
- **Branch protection on `main`:**
  - Require CI to pass before merging
  - Require at least 1 review
  - Require branches to be up to date before merging
- **Secrets (for later phases):**
  - `DOCKER_HUB_TOKEN`: pushing images
  - `CODECOV_TOKEN`: coverage uploads (optional)

## After push: run everything locally

```bash
pnpm install
pnpm infra:up
pnpm --filter @gratis-gis/portal-api db:generate
pnpm --filter @gratis-gis/portal-api db:migrate
pnpm --filter @gratis-gis/portal-api db:seed
pnpm dev
```

You should then be able to:

- Sign in at http://localhost:3000 as `admin` / `admin`,
  `contributor` / `contributor`, or `viewer` / `viewer` via
  Keycloak (passwords match usernames, dev-only)
- Hit http://localhost:4000/docs for the Swagger UI
- See the seeded Acme org, the Field Team group, and a few example
  items

For more detail on the local dev environment, see
[docs/SETUP.md](./docs/SETUP.md). For a quick orientation to the
features that exist today, see [docs/walkthrough.md](./docs/walkthrough.md).
