# Contributing

Install JavaScript dependencies with `npm ci`. The project launcher and backend
scripts use uv for Python dependencies and execution, with a project-local
virtual environment and cache. See the README for local startup.

Use **Sample data** for interface development. Tests use fixtures or mocked
provider requests; never add real API credentials or private imagery to a test.
The manually invoked live-search script is separate because it can spend the
configured provider budget.

Before submitting changes, run the checks appropriate to the change:

```sh
npm run build
npm test
npm run test:backend
```

Keep Cesium behavior in the map layer, network requests in the service layer,
and conventional interface controls in the existing shadcn components. Preserve
source attribution and third-party license notices when adapting code or data.

Inspect the staged diff before committing. Environment files, key material,
database backups, local demos, and screen recordings must remain private. Use a
GitHub-provided `noreply` commit address if you do not want a personal address in
new commits; existing history is preserved. See SECURITY.md for private reports.
