# SoulStone development

Read [README.md](README.md), [setup](docs/SETUP.md) and [support/limits](docs/STATUS.md) first. This repository is self-contained for installation and normal development. Code belongs in `harness/` and `companion/`; user/developer guides belong here with the code.

The maintainer keeps the active roadmap and dated acceptance record in a private planning archive outside this repository. An external contributor does not need that archive; use the issue or task supplied by the maintainer instead. Keep private plans and raw receipts outside Git.

- Use the repository's configured Git identity. Never change accounts automatically. Ask for the intended project author if none is configured.
- Run `npm test` in `harness/` for relevant harness changes. Lab/integration scripts can mutate a Minecraft world or invoke a model; use only an explicitly authorized disposable test scope.
- Preserve world, request and experience state when replacing the app. Setup work does not authorize gameplay, model usage or account changes.
- Keep credentials, account caches, runtime state, raw results, model weights and generated builds out of Git and packages.
- Distinguish regression results, supplied-material fixtures, natural-world completion and installed-app acceptance. Preserve failures and interventions. Never convert a green build into a broad capability claim.
- Keep setup working from tracked files alone. Default native first run must open the user's connection setup; private-lab mode requires an existing `harness/.env`.
- Run the setup/build from a clean export when changing onboarding or packaging. Check the native deployment target as well as Info.plist.

## Public repository

This repository is public. Everything tracked here (code, comments, tests, fixtures, docs and commit messages) must read cleanly to a stranger.

- No personal names or handles of the maintainer or anyone else. Write "the owner" or "a player". Fixtures use neutral names such as `Player`.
- No family or household details: who plays, their ages, or that they are children. Call the world people play in "the play world" and the lab world "the test world".
- No hostnames, machine names, IP addresses, absolute or home-directory paths, Notion or other private workspace links, internal IDs or account names.
- No pointers into the private planning archive by file name. State the rule itself in the comment or doc.
- Before each commit, grep the staged diff for the items above and fix any hit.
