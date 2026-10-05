# Security

Keep vulnerability details private. Use GitHub's private vulnerability reporting
on this repository when available. If that option is unavailable, open an issue
asking the maintainers for a private reporting channel without including the
vulnerability, credentials, or personal data.

Provider credentials belong only in an ignored runtime environment file or the
hosting platform's private runtime variables. Never use `VITE_` variables,
Docker build arguments, source files, fixtures, screenshots, issues, or logs for
real keys. The frontend must not receive provider credentials.

Local database files, backups, imagery caches, demo captures, and screen
recordings stay outside source control and public releases. Ignore rules are a
guardrail; inspect the staged diff and release contents before publishing.

If a real credential is exposed, revoke or rotate it at its provider. Removing
the current file does not remove the credential from existing Git history,
clones, or cached commits. Review the provider account's activity before using
a replacement key.

Public deployments require HTTPS and the application's configured access
password. Keep MongoDB on its private network and preserve its spending ledger.
Deterministic tests use sample or mocked providers. The manual live-search
script can incur charges and is not part of the automated checks.
