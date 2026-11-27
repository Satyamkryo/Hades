# Spike: `better-sqlite3` on Windows (task 1)

## Environment

- Node: v24.4.1
- npm: 11.4.2
- `better-sqlite3`: 13.2.0 (`-w @hades/engine`)
- `@types/better-sqlite3`: 9.6.0 (dev, `-w @hades/engine`)
- OS: Windows (win32 x64)

## Prebuilt or native build?

Prebuilt binary. Evidence:

- `npm install better-sqlite3 -w @hades/engine --foreground-scripts` completed in
  ~3 s with no `node-gyp` build output.
- `better-sqlite3@13.2.0` has no `install` script (its scripts are only
  `build-release` / `build-debug` / `test` / `benchmark` / `download` / `clean`),
  so npm runs no compilation step; the prebuilt binaries ship inside the npm
  tarball under `prebuilds/`.
- `node_modules/better-sqlite3/prebuilds/win32-x64.node` is present, there is no
  `build/Release` directory, and the module loads and runs on Node 24.

No fallback needed. The Node 22.5+ `node:sqlite` / JSON-file / no-cache options
are not required.

## Test result

`packages/engine/test/spike/sqlite.test.ts` passes: opens
`<os.tmpdir()>/hades-spike-<random>.db`, sets `journal_mode = WAL` (returns
`wal`), creates a table, inserts a row, reads it back, closes, and deletes the
`.db` file plus its `-wal` / `-shm` sidecars (asserted absent afterwards).

- Spike test alone: 1 passed.
- `npm run build` (root): zero errors.
- `npm test` (root): 32 test files passed, 278 tests passed.
