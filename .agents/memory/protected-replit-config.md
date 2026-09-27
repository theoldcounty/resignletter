---
name: Protected Replit config edits
description: Platform-validated procedure for changing the project's protected .replit configuration
---

Direct patches to `.replit` are blocked by the workspace even when other hunks in the same patch succeed.

**Why:** Replit validates its configuration schema before accepting changes; an ordinary patch can fail only for `.replit` while partially applying unrelated hunks.

**How to apply:** Read the full current TOML, write the intended full replacement to a temporary file inside the workspace, then call `verifyAndReplaceDotReplit` with its absolute path. Check the returned success status and the resulting config; do not commit the temporary file.