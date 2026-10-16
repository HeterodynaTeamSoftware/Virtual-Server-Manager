# Runtime data

This directory is intentionally empty in the public repository.

Virtual Server Manager creates `data/storage.json` automatically on first run.
Runtime data, backup archives, terminal transcripts and locally configured credentials
must not be committed to Git.

Ignored runtime paths include:

- `data/storage.json`
- `data/backups/`
- `data/terminal-transcripts/`
- `runtime-server.log`
- `runtime-server.pid`
