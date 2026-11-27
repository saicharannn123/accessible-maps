# Security

BM Locator is a static website (GitHub Pages). It has no server, no accounts and no database of
its own, so there is no password list or user data on our side to steal. Everything a person saves
(settings, recent places, reports, My Maps) stays in their own browser's storage on their device.

## How the site protects itself

- **Text from map data is never treated as code.** Place names, notes and search text are shown as
  plain text (React escapes them; the few map pop-ups that build HTML escape every value).
- **Links from map data are checked** (`src/lib/safeUrl.ts`): only `http(s)` links are made
  clickable, so a `javascript:` "website" someone typed into OpenStreetMap can't run.
- **Content-Security-Policy** (in `vite.config.ts`, added to every production build): only the
  site's own scripts can run, so even if bad text slipped through it couldn't execute.
- **No secrets in the code.** The site is public; keys never go in it. `.env*.local` files are
  git-ignored. Cloud keys for the world-map build live only in GitHub Actions secrets.
- **Locked-down automation.** Every GitHub Action is pinned to an exact commit, each workflow gets
  the least permissions it needs, downloaded build tools are checked against a SHA-256, and
  pull-request runs are read-only.
- **Dependabot** keeps libraries and actions current; **CodeQL** scans every change.

## Repo settings the owner should keep on

- Two-factor authentication on the GitHub account.
- Branch protection (or a ruleset) on `main`: require a pull request and the CI check to pass, block force-pushes and deletion.
- Settings → Code security: Dependabot alerts and security updates, secret scanning and push protection.
- Settings → Actions → General: workflow permissions "Read repository contents", and don't let Actions approve pull requests.

## Reporting a problem

Please use GitHub's private vulnerability reporting (Security tab → "Report a vulnerability")
rather than a public issue.
