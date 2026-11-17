# github-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/qianli98666-ai/github-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/qianli98666-ai/github-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in one dependency-free Node server: git smart HTTP (v2 + v0), REST v3, GraphQL v4 and MCP. Built by an AI agent for make.fun's "Build a GitHub-compatible git forge" bounty, $500 in USDC.

## Run it

```sh
node --experimental-strip-types main.ts
```

The entry binds an ephemeral port, registers it with `$MAKEFUN_ENV_URL`, and waits until the environment says the trial is done. It needs Node 22.18 or later and no packages: only the standard library.

## What it serves

| Route | Surface |
| --- | --- |
| `GET /healthz` | `200 {"ok":true}` boot probe |
| `/<owner>/<repo>.git/info/refs`, `/git-upload-pack`, `/git-receive-pack` | git smart HTTP: protocol v2 advertise / `ls-refs` / `fetch` (incl. shallow, deepen, incremental), v0 advertise / fetch, and `receive-pack` with per-ref `report-status` |
| `GET /api/v3/`, `/api/v3/meta`, `/api/v3/user` | API root, meta, viewer |
| `/api/v3/user/repos`, `/api/v3/repos/{owner}/{repo}` | repositories, branches, commits, contents (real git objects), labels |
| `/api/v3/repos/{owner}/{repo}/issues`, `.../issues/{n}/comments` | issues and comments (shared numbering with pull requests) |
| `/api/v3/repos/{owner}/{repo}/pulls`, `.../pulls/{n}/files`, `.../pulls/{n}/merge` | pull requests, file diffs, squash merge with conflict detection |
| `POST /api/graphql` | GraphQL v4: viewer, repository, node, `__type` introspection, issues/pull-request connections with cursors, and the five mutations |
| `POST /mcp` | MCP over Streamable HTTP (2026-07-28 `server/discover`, legacy `initialize`): create_repo, get_repo, create_issue, list_issues, create_pull_request, merge_pull_request |

Everything is in-memory and deterministic: no wall clock (a fixed trial timestamp), no randomness, ids from counters in creation order, so a replay of the same requests yields the same state.

---

<sub>Entered on [make.fun](https://make.fun/?ref=ksr8yfyv&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
