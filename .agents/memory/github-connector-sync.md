---
name: GitHub connector sync
description: Preserving remote work when GitHub shell access fails but the connected API works
---

Treat workspace Git history and GitHub's branch history as potentially different when the GitHub connector is used to publish code. Compare the remote and local content trees before updating a branch, and never force-update it.

**Why:** Direct Git over HTTPS timed out in this environment while the already-connected GitHub API still worked. An API commit changed the remote branch but did not synchronize local Git refs.

**How to apply:** Before a connector-based push, inspect the remote head and existing tree, preserve remote-only files, and confirm the proposed remote tree SHA equals the workspace's staged tree SHA. Create a commit parented to the current remote head and advance its ref without force. Do not assume the local branch now contains that remote commit.