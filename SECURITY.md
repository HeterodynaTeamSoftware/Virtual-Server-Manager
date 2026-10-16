# Security

Virtual Server Manager contains administrative functionality such as SSH terminal access, service management, Docker operations and credential-backed integrations.

For deployments beyond a local test environment:

- change the default administrator password before first start,
- set `VSM_SESSION_SECRET`,
- set `VSM_AGENT_SHARED_TOKEN` if agents are used,
- use HTTPS and a trusted reverse proxy,
- restrict network access to the management panel,
- never commit `data/storage.json`, backups or terminal transcripts,
- keep Node.js and npm dependencies updated.
