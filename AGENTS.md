# SoulStone development

Read [README.md](README.md), [setup](docs/SETUP.md) and [support/limits](docs/STATUS.md) first. This repository is self-contained for installation and normal development. Code belongs in `harness/` and `companion/`; user/developer guides belong here with the code.

For maintainers using the owner's Sovereign Signal archive, `workstreams/minecraft/overview.md`, `WORKING-STATE.md` and `log.md` hold the active roadmap and dated acceptance record. They normally sit at `../../workstreams/minecraft/` from this checkout. An external contributor does not need that archive; use the issue or task supplied by the maintainer instead. Keep private plans and raw receipts outside Git.

- Use the repository's configured Git identity. Never change accounts automatically. Ask for the intended project author if none is configured.
- Run `npm test` in `harness/` for relevant harness changes. Lab/integration scripts can mutate a Minecraft world or invoke a model; use only an explicitly authorized disposable test scope.
- Preserve world, request and experience state when replacing the app. Setup work does not authorize gameplay, model usage or account changes.
- Keep credentials, account caches, runtime state, raw results, model weights and generated builds out of Git and packages.
- Distinguish regression results, supplied-material fixtures, natural-world completion and installed-app acceptance. Preserve failures and interventions. Never convert a green build into a broad capability claim.
- Keep setup working from tracked files alone. Default native first run must open the user's connection setup; private-lab mode requires an existing `harness/.env`.
- Run the setup/build from a clean export when changing onboarding or packaging. Check the native deployment target as well as Info.plist.
