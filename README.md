# github-core-clone

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/daring-otter-85/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/daring-otter-85/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node.js process, built on the standard library only — no git binary, no database, no outside service. It implements the git object model and smart HTTP in-process (protocol v2 upload-pack with shallow/deepen fetch, v0 receive-pack with report-status in sideband framing, fast-forward enforcement), the REST v3 resources (repositories, contents API backed by real git trees, branches, commits, labels, issues, comments, pull requests with three-way squash merges), GraphQL v4 (viewer/repository queries, issue and pull-request connections with cursor pagination, the create/close/merge mutations, node(id:) and __type introspection, batched operations) and an MCP endpoint (server/discover, tools/list, tools/call) whose six tools act on the same store as the REST surface. All state is in memory and every API-created commit uses a deterministic logical clock, so a replayed trial rebuilds byte-identical objects.

## Run it

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 MAKEFUN_SHOP_TOKEN=dev-token node --experimental-strip-types main.ts
```

<sub>Entered on [make.fun](https://make.fun/?ref=wfs35fam&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
