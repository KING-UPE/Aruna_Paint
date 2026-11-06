# Developer helpers (the owner's Windows PC)

These are not part of the app and never go into the installer.

- `run.bat` / `run.ps1`: start the WSL PostgreSQL bridge and `pnpm dev` from the project folder.
- `bridge.js` + `worker.py`: forward PostgreSQL in WSL to Windows (`127.0.0.1:54320`).
- `push.bat`: push `main` to GitHub from the owner's own folder.
- `add_dummy_data.js`: fill a local server (`http://localhost:3000`) with demo data. Never run it
  against a real shop.
