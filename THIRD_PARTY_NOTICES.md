# Third-party notices

UniContext itself is MIT licensed (see LICENSE). It is built on the open-source packages below.
This list covers the direct dependencies declared by the packages in this repository; their own
transitive dependencies carry their own licenses (see `pnpm licenses list` for the complete tree).
Versions are those resolved in `pnpm-lock.yaml` when this file was generated.

| Package                                                                                                      | Version  | License    | Use         |
| ------------------------------------------------------------------------------------------------------------ | -------- | ---------- | ----------- |
| [@eslint/js](https://eslint.org)                                                                             | 10.0.1   | MIT        | development |
| [@fastify/static](https://github.com/fastify/fastify-static)                                                 | 10.1.5   | MIT        | runtime     |
| [@modelcontextprotocol/sdk](https://modelcontextprotocol.io)                                                 | 1.31.0   | MIT        | runtime     |
| [@napi-rs/keyring](https://github.com/Brooooooklyn/keyring-node)                                             | 2.1.0    | MIT        | runtime     |
| [@tanstack/react-router](https://tanstack.com/router)                                                        | 1.170.40 | MIT        | runtime     |
| [@types/better-sqlite3](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/better-sqlite3) | 9.6.0    | MIT        | development |
| [@types/node](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/node)                     | 22.20.4  | MIT        | development |
| [@types/node-notifier](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/node-notifier)   | 8.0.5    | MIT        | development |
| [@types/react](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/react)                   | 19.3.0   | MIT        | development |
| [@types/react-dom](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/react-dom)           | 19.3.0   | MIT        | development |
| [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/tree/main/packages/plugin-react#readme)   | 6.1.1    | MIT        | development |
| [better-sqlite3](http://github.com/WiseLibs/better-sqlite3)                                                  | 13.0.3   | MIT        | runtime     |
| [commander](https://github.com/tj/commander.js)                                                              | 15.0.0   | MIT        | runtime     |
| [drizzle-orm](https://orm.drizzle.team)                                                                      | 0.45.3   | Apache-2.0 | runtime     |
| [eslint](https://eslint.org)                                                                                 | 10.11.0  | MIT        | development |
| [fastify](https://fastify.dev/)                                                                              | 5.12.5   | MIT        | runtime     |
| [node-notifier](https://github.com/mikaelbr/node-notifier#readme)                                            | 10.0.1   | MIT        | runtime     |
| [prettier](https://prettier.io)                                                                              | 3.9.9    | MIT        | development |
| [react](https://react.dev/)                                                                                  | 19.3.0   | MIT        | runtime     |
| [react-dom](https://react.dev/)                                                                              | 19.3.0   | MIT        | runtime     |
| [typescript](https://www.typescriptlang.org/)                                                                | 6.0.3    | Apache-2.0 | development |
| [typescript-eslint](https://typescript-eslint.io/packages/typescript-eslint)                                 | 8.71.0   | MIT        | development |
| [vite](https://vite.dev)                                                                                     | 8.3.1    | MIT        | development |
| [vitest](https://vitest.dev)                                                                                 | 4.1.11   | MIT        | runtime     |
| [yaml](https://eemeli.org/yaml/)                                                                             | 2.9.1    | ISC        | runtime     |
| [zod](https://zod.dev)                                                                                       | 4.6.5    | MIT        | runtime     |

## License summary

- MIT: 23
- Apache-2.0: 2
- ISC: 1

## Notes

- `@modelcontextprotocol/sdk` implements the Model Context Protocol (MIT).
- `@napi-rs/keyring` provides OS keychain access (Windows Credential Manager, macOS Keychain, Linux Secret Service).
- `node-notifier` is an optional dependency used only for desktop notifications; UniContext runs without it.
- GPL or other copyleft tools must be connected as separate processes (MCP, HTTP or CLI adapters) and are never vendored here (spec sections 56-58).
- Connector packages written by third parties keep their authors licenses and are not listed here.
