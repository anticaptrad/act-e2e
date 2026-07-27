# act-e2e agent instructions

## Repository restrictions and test invariants

- Do not run `git reset`, `git filter-repo`, or `git clean`.
- Do not run `rm` except when explicitly deleting known temporary or scratch files.
- `dotenv` is blacklisted. Do not install or use it; test configuration comes from explicit environment variables.
- Preserve layered platform, service, browser-engine, cluster, lifecycle, and security tests. Do not weaken an assertion merely to match a product defect; fix the owning repository or document a precise expected failure.
- Protected `/api/*` and `/mcp` routes must reject missing, empty, and incorrect shared secrets without echoing secret material, accept the correct secret, and keep health/readiness probes public.
- Distinguish authentication success from downstream provider readiness: an authenticated route may still return a legitimate provider-configuration `503`.
- Keep Playwright, Puppeteer, and Selenium coverage behaviorally equivalent while retaining engine-specific lifecycle and in-page execution paths.
- Never place secrets in URLs, snapshots, screenshots, traces, logs, failure messages, or CI artifacts. Inject test secrets explicitly and redact diagnostic output.
- Preserve deterministic setup, bounded waits, isolated service instances, graceful teardown, and a clean final process/container state.

## Instruction discovery

Resolve `$PWD`, walk upward through every parent directory to the filesystem root, read every readable lowercase `agents.md` on that ancestor chain, and apply them root-to-leaf. Do not search siblings. Deduplicate resolved paths/inodes, avoid symlink cycles, and report unreadable files.

## Synchronize with the remote

Before editing, inspect `git status`, current branch, configured remotes, and the default branch. Run `git fetch --all --prune` and create the feature branch from the latest remote default branch. Fetch again before pushing and incorporate upstream changes using repository merge policy. Never discard remote commits, force-push, rewrite shared history, bypass review, or bypass required CI.

## Resolve Git conflicts semantically

Resolve conflicts by understanding and combining both sides' intent. Do not mechanically choose `ours`, `theirs`, current, or incoming changes. Produce the conceptually correct result while preserving test-layer ownership, authentication boundaries, secret redaction, provider-readiness distinctions, three-browser parity, determinism, teardown, assertions, fixtures, documentation, configuration, and CI behavior. Do not collapse independent browser implementations merely to eliminate duplicate-looking code. If intentions are incompatible, make the smallest explicit design decision and document it in the pull request.

After resolving, reread every affected file from the top, run the complete relevant local and cluster test matrix, verify no process/container leaks remain, and search the entire worktree for conflict markers:

```sh
grep -RInE '^(<<<<<<<|=======|>>>>>>>)' --exclude-dir=.git .
```

If any marker or suspicious partial resolution remains, repeat semantic resolution from the top and rerun validation. A conflict is resolved only when the test system is conceptually coherent and verified, not merely accepted by Git.
