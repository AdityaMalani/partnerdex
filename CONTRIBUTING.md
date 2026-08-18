# Contributing

Thanks for being here. PartnerDex is maintained by one person for now and self hosted by others. That shapes everything below.

## Scope

**PartnerDex exists to give a Shopify partner what they can't get anywhere
else.** That's the test.

**In scope:** metrics Shopify doesn't surface or gets wrong, the correctness of the
ones already here, and data a partner owns but has nowhere to put. Fixing a
wrong number beats adding a new one.

**Harder sell:** whole new product surfaces, anything a dedicated tool already does
well, and anything assuming more than one process or a hosted component.
PartnerDex is a single process with an embedded SQLite file, on purpose.

**Integrations:** If your tool needs to talk to
PartnerDex, propose a generic endpoint any comparable tool could use, not a
module named after one vendor. Otherwise this project maintains someone else's
API forever.

## Before you build

Small fix, failing test, typo, doc correction — just send it.

Anything else, open an issue first: new metrics, tables, pages, env vars,
dependencies, changes to how a metric is defined, or roughly 300+ lines. There's
one reviewer. An issue costs you five minutes and can save you a weekend.

## Pull requests

**One idea per PR.** If describing it needs an "and", it's probably two.

**Don't stack PRs unless we've agreed.** A chain where each branch carries the
last one's commits can't be reviewed or merged independently, and every merge
rebases everything above it.

**Bring evidence.** This reports people's revenue. If you change a number, show
how you know the new one is right. A test that fails before and passes after,
or a query with the result quoted.

## Running it

```bash
npm ci
npm test
npm run typecheck
npm run dev
```

Node 20, matching the Dockerfile. CI runs typecheck and tests on every PR; both
must pass. The suite is hermetic - no `.env`, no credentials.

## Gotchas

- `src/sync/derive.ts` diffs as binary and `grep` skips it - it uses NUL bytes
  as key separators. Use `grep -a`.
- Derivation reads the wall clock. Fixtures testing a date boundary must be
  relative to now; fixed dates change meaning as the calendar moves.
- `test/helpers.ts` pins every reporting env var. Add yours there, or it leaks
  into the next test.
- Derived tables rebuild every sync. Durable ones need a migration in
  `src/db/migrate.ts` — `CREATE TABLE IF NOT EXISTS` won't add a column.

## Metrics

Implement the definition, not the nearby column that's easier. If the data can't
tell two situations apart, report `unknown` rather than the tidier guess. Update
the README table and pin the definition with a test.

## Don't commit

`.env`, `fly.toml`, database files, or real shop domains and tokens - including
in issue and PR text.

## Security

Don't open a public issue. Use "Report a vulnerability" under the Security tab.
Deployments hold Partner API tokens and revenue data.

## What to expect

I'll acknowledge within a few days. Small PRs move fastest. Big unsolicited ones
take longer and may be declined on scope. That's about what one maintainer can
carry, not about your work.

Quiet for two weeks? Nudge the thread.

## Licence

GPL-3.0, inbound equals outbound. No CLA, you keep your copyright.
