---
name: pdfmake browser imports
description: Runtime import behavior and browser verification for pdfmake PDF downloads
---

When using pdfmake's browser build through Vite, the runtime module is default-wrapped even if TypeScript permits accessing the imported namespace directly. Verify a real browser download and its PDF header when changing PDF dependencies or download code; document-definition tests alone do not exercise the runtime import.

**Why:** A document-definition test and production build both passed while the download button failed at runtime because the namespace did not expose `addVirtualFileSystem` directly.

**How to apply:** After pdfmake or bundler changes, check the browser download path in addition to unit tests. Inspect module interop at runtime if a method exists in types but not in the loaded module.