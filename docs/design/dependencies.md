# Dependency updates

Part of [the design](../DESIGN.md).

## Hono Node adapter 2.x and the public SPA fallback (queue DU1)

The server declares `@hono/node-server ^2.1.8`, locked to 2.1.8, the stable npm `latest` on 2026-11-16.
[GHSA-rmxm-3fg6-px4f](https://github.com/advisories/GHSA-rmxm-3fg6-px4f) lists 2.1.3 as the first fix for
`serveStatic` decoding paths a second time. 2.1.8 also includes the later `allowPercentInPath` fix; Nexus does not
enable that option. The [1.19.19 release](https://github.com/honojs/node-server/releases/tag/v1.19.19) describes a
backport, although the advisory still lists that version as affected. Moving to the maintained 2.x line removes
that audit ambiguity. Only this adapter's declaration and lock entry changed; Hono stays at 4.13.18.

The [2.0.0 migration](https://github.com/honojs/node-server/releases/tag/v2.0.0) drops Node 18 and the Vercel adapter.
Nexus already requires Node >=24 and does not use Vercel. `serve`, `HttpBindings`, `serveStatic` and the returned
Node HTTP server remain compatible: the adapter upgrade needed no `main.ts` adjustment, including its `ws` upgrade
listener. Checks ran on Windows with Node 26.13.1. HTTP tests use a temporary home, a free loopback port above 4317 and fake runtimes.
They cover API reads/writes, cookies, Origin/JSON guards, WebSocket acceptance/refusal and, when the dashboard is
built, the actual assets, SPA entry and public installation files. Build first to run the static subtest; it skips
in source-only checkouts. Encoded, repeated and malformed percent escapes cannot bypass the guard on protected
API/asset paths in these tests.

**Policy gap found in DU1, closed by the approved DU1F:** `/icons/` is public. When its static handler found
no file (including rejected encodings), the unrestricted `app.get("*", serveStatic({ path: index }))` returned the
SPA shell without another authorization check. `/icons/missing.png`, `/icons/%252e%252e/index.html` and
`/icons/%%32%65%%32%65/index.html` returned 200 with `index.html`; a double-encoded request aimed at a JS asset also
got the shell, not the JS. An isolated comparison reproduced the shell response with both 1.19.19 and 2.1.8.
DU1 recorded this limitation and stopped for a separate approval; its dependency upgrade is retained.

DU1F moves the static routes into `web-static.ts`, sharing `isPublicFile` with the access guard. The public set is
unchanged. When `serveStatic` rejects or cannot find a public file, the request terminates in 404 text/plain
(`404 Not Found`) before the SPA fallback. This holds for local and signed-in requests too. Nexus
does not decode again: it uses the same routed path at both boundaries and keeps the adapter's default rejection
of residual percent encodings. Paths normalized into protected routes still meet the original access guard first;
their unauthenticated 302/401 responses are preserved. Login, API writes and WebSocket authorization are unchanged.

The HTTP regression replaces DU1's explicit 200/SPA baseline with 404 assertions for the same raw requests, then
adds repeated encodings, encoded separators, malformed escapes and an API target. It checks MIME types and exact
response bytes in remote, signed-in and local modes, with the real dashboard built first. A separate temporary web
root mounts the same production static routes through the Node adapter: it has an index, a JS asset, an icon and an
outside-root sentinel, but no manifest or service worker. Their missing-file responses are proven without deleting
or changing the real build. Both test servers close before the tests finish.

The post-upgrade npm audit no longer reports the Hono advisory. It still reports GHSA-g3hv-75wg-m249 through
`typescript-eslint -> @typescript-eslint/typescript-estree -> minimatch 10.2.6`: seven moderate affected package
entries from one underlying advisory, not seven independent vulnerabilities. That dependency change is outside DU1.

## The lint toolchain's minimatch update (queue DU2)

On 2026-11-16, stable [typescript-eslint 8.73.0](https://github.com/typescript-eslint/typescript-eslint/releases/tag/v8.73.0)
became available with `@typescript-eslint/typescript-estree` depending on `minimatch ^11.0.1`. Nexus upgrades from
8.72.2 to 8.73.0 and locks that minimatch to 11.0.8. This is the upstream fix, so no override is needed.
[GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) lists versions 7 through 11.0.0 as affected.
ESLint's independent minimatch 3.1.5 branch is unchanged, as are the lint configuration and enabled rules. The lock
changes only the eleven synchronized TypeScript ESLint packages, their minimatch and its new nonrecursive matcher.

The actual estree call is `minimatch(relativePath, pattern, { dot: true })`, used for `allowDefaultProject` matching.
Nexus uses `projectService: true` without that allowance; the default path uses TypeScript's project service.
The [minimatch 11 changelog](https://raw.githubusercontent.com/isaacs/minimatch/main/changelog.md) removes `makeRe`,
`regexp`, `AST` and internal methods, and replaces regexp entries in `Minimatch.set` with matcher objects. Estree
uses none of those APIs. Empty trailing path segments no longer match optional/zero-repeat extglobs; those are
directory forms, not the file paths this call receives. Changes to globstar/partial matching and Windows root/UNC
normalization do not change the tested relative-file cases. The new matcher requires Node 20 or >=22, within
Nexus's >=24 requirement. The new optional TypeScript-native backend in 8.73.0 is not enabled or installed.

`scripts/test/lint-dependencies.test.ts` checks the dependency resolved from estree rather than ESLint's 3.x copy.
Small examples cover dot files/directories, relative and Windows-separated paths, single-level glob boundaries,
braces and extglobs. The same cases pass with minimatch 10.2.6 and 11.0.8. A temporary TypeScript project verifies
typed parsing and the actual default-project allowance/rejections (including overly broad patterns); the unchanged
repository ESLint configuration recognizes TS/TSX files and still reports a deliberately unawaited promise as an
error. The final lockfile is also installed with `npm ci` in a separate temporary checkout, where the compatibility
tests and dependency tree are checked again. No access, HTTP or agent protocol changes accompany this update.
