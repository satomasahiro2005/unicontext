# UniContext ChatGPT plugin

A ChatGPT plugin package for UniContext's remote MCP server (`https://uc.nemut.ai`), plus the
scheduled-task prompts and custom instructions that make ChatGPT check UniContext on the
student's behalf.

- Install and set up: [docs/chatgpt-plugin.md](../../docs/chatgpt-plugin.md)
- Why it is built this way: [docs/research/chatgpt-plugin-tasks.md](../../docs/research/chatgpt-plugin-tasks.md)

```
node integrations/chatgpt/scripts/plugin.mjs check
node integrations/chatgpt/scripts/plugin.mjs pack [--app-id plugin_asdk_app_…] [--out file.zip]
```

`check` validates `plugin/unicontext` against the documented manifest, listing and icon limits,
the skill front matter, and the task prompts. `pack` writes `dist/unicontext-<version>.zip`;
`--app-id` adds `.app.json` for a personal install mapped to an existing developer-mode app.
Tests: `tests/chatgpt-plugin.test.ts`.
