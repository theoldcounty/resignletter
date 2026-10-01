---
name: GitHub connector sync
description: Preserving remote work when GitHub shell access fails but the connected API works
---

Treat workspace Git history and GitHub's branch history as potentially different when the GitHub connector is used to publish code. Compare the remote and local content trees before updating a branch, and never force-update it.

**Why:** Direct Git over HTTPS initially rejected the shell credentials while the connected GitHub account could write through its SDK. The generic SDK request form returned 404; typed Git Data methods worked. An API commit also does not automatically update local Git refs.

**How to apply:** Before a connector-based push, inspect the remote head and existing tree, preserve remote-only files, and confirm the proposed remote tree SHA equals the workspace's staged tree SHA. Prefer typed methods such as `client.rest.git.createTree`, `createCommit`, and `updateRef`; parent the commit to the current remote head and never force-update. Afterward, fetch the branch if shell read access works, verify local/remote tree equality, and only then align the local branch (keeping a backup when moving its history). Do not assume the local branch contains the API-created commit.