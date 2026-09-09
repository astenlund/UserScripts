# Userscript checks

Use Node.js satisfying `^22.22.2 || ^24.15.0 || >=26.0.0`, as required by jsdom.

Run these commands from the repository root in PowerShell 7:

```powershell
npm ci --prefix tests --ignore-scripts
npm test --prefix tests
node --check trakt_improved.user.js
```

The test-only jsdom dependency is locked in `package-lock.json`. The
userscripts themselves have no runtime dependencies or build step.

The season-list tests cover URL identity, response validation, pagination,
menu insertion, add/remove payloads, pending writes across picker reopen,
and read-before-retry after an uncertain write. They also cover cached catalog
rendering, minimal row reconciliation, account isolation, and bounded fresh
membership reads. The DOM fixture models the
observed Trakt menu markup and stubs API calls. It does not write to Trakt.
Browser layout and native app integration still require live verification.
