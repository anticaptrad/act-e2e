# AttoLang conformance candidate snapshots

This folder records reviewable boundary vectors derived from the two AttoLang
candidate PRs, with immutable Git blob SHAs for their `.atto` source fixtures.
The test suite checks the expected classification values and rejects forged
production/compile admission.

These vectors are **not** compiled Atto programs, an external checkout of the
authoritative schemas, or an independent compiler receipt. They intentionally
stay candidate-only. Once a pinned Atto Rust/Wasm compiler can execute both
fixtures, extend this suite to compare real guest outputs with the committed
vectors and record the compiler SHA and complete execution receipt.

Run: `node --test tests/contracts/atto-candidate-boundaries.test.mjs`.
