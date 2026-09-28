# anti-slop provenance

- Source: https://github.com/dmmulroy/anti-slop
- Commit: c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b
- Copied from: `src/` without the `*.test.ts` files
- Installed path: `.agents/tools/anti-slop/` (generic `index.ts`, Effect `effect/index.ts`)
- Deviations: installed under `.agents/tools/anti-slop/` instead of the default `tools/oxlint/anti-slop/`. No rule changes.

## Updating

1. Diff local changes against the recorded commit:
   `git clone https://github.com/dmmulroy/anti-slop /tmp/anti-slop && git -C /tmp/anti-slop checkout <commit above>`
   `diff -r /tmp/anti-slop/src .agents/tools/anti-slop` (ignore `*.test.ts` and this file, which are not vendored).
2. Review upstream changes: `git -C /tmp/anti-slop log --oneline <commit above>..origin/main -- src`.
3. Port wanted changes into `.agents/tools/anti-slop/`, keeping local edits and `vendor/eslint-stylistic/{LICENSE,UPSTREAM.md}`.
4. Enable any new rules in `.oxlintrc.json`; keep `@oxlint/plugins` pinned to the exact `oxlint` version.
5. Run `pnpm lint && pnpm typecheck`, then update the commit above.
