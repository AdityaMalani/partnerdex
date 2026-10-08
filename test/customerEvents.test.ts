import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { getDb } from "../src/db/index.js";
import { closeDb } from "../src/db/index.js";
import { getCustomer, listCustomers } from "../src/customers/index.js";
import { runMetric } from "../src/metrics/registry.js";
import { rebuildDerivedTables } from "../src/sync/derive.js";
import { APP_ID, resetEnvironment, seed } from "./helpers.js";

/**
 * The acceptance scenarios from the customer-events spec, plus the invariant
 * the whole design rests on: summing `net_change` reproduces the MRR the as-of
 * reconstruction reports. Those are two independent paths through the same
 * facts, so a drift between them is a real bug rather than a rounding artefact.
 */

interface EventRow {
  type: string;
  occurred_at: string;
  net_change: number | null;
  suppressed: number;
  charge_id: string;
  prev_charge_id: string;
  plan_amount: number | null;
}

function eventsFor(
  shopId: string,
  options: { includeSuppressed?: boolean } = {},
): EventRow[] {
  return getDb()
    .prepare(
      `SELECT type, occurred_at, net_change, suppressed, charge_id, prev_charge_id, plan_amount
       FROM customer_events
       WHERE shop_id = ? AND type NOT IN ('payment', 'refund')
         ${options.includeSuppressed ? "" : "AND suppressed = 0"}
       ORDER BY occurred_at, type`,
    )
    .all(shopId) as EventRow[];
}

function typesFor(shopId: string): string[] {
  return eventsFor(shopId).map((row) => row.type);
}

/** The ledger's view of MRR: every delta the install has ever recorded. */
function ledgerTotal(): number {
  const row = getDb()
    .prepare(
      "SELECT COALESCE(SUM(net_change), 0) AS total FROM customer_events WHERE suppressed = 0",
    )
    .get() as { total: number };
  return Math.round(row.total * 100) / 100;
}

describe("customer events: the raw feed compiled into a lifecycle", () => {
  before(() => resetEnvironment());
  after(() => closeDb());

  it("records a first subscription once, at the monthly rate", () => {
    resetEnvironment();
    seed(
      [
        {
          chargeRef: "c1",
          shopId: "1",
          amount: 50,
          activatedAt: "2024-01-10T00:00:00Z",
          firstSaleAt: "2024-01-10T00:00:00Z",
        },
      ],
      { installs: [{ shopId: "1", at: "2024-01-09T00:00:00Z" }] },
    );

    assert.deepEqual(typesFor("1"), ["installed", "subscribed"]);
    const subscribed = eventsFor("1").find((row) => row.type === "subscribed")!;
    assert.equal(subscribed.net_change, 50);
  });

  it("normalizes an annual plan to its monthly contribution", () => {
    resetEnvironment();
    seed([
      {
        chargeRef: "c1",
        shopId: "1",
        amount: 1200,
        activatedAt: "2024-01-10T00:00:00Z",
        firstSaleAt: "2024-01-10T00:00:00Z",
        billingInterval: "ANNUAL",
      },
    ]);

    const subscribed = eventsFor("1").find((row) => row.type === "subscribed")!;
    // 1200 a year is 100 a month, not 1200.
    assert.equal(subscribed.net_change, 100);
    assert.equal(subscribed.plan_amount, 100);
  });

  it("reads a monthly-to-annual switch on the normalized amount, not the sticker price", () => {
    resetEnvironment();
    seed([
      {
        chargeRef: "old",
        shopId: "1",
        amount: 14,
        activatedAt: "2024-01-10T00:00:00Z",
        firstSaleAt: "2024-01-10T00:00:00Z",
        churnedAt: "2024-03-01T00:00:00Z",
      },
      {
        chargeRef: "new",
        shopId: "1",
        amount: 140,
        billingInterval: "ANNUAL",
        activatedAt: "2024-03-01T00:00:00Z",
        firstSaleAt: "2024-03-01T00:00:00Z",
      },
    ]);

    // $140 a year is $11.67 a month, down from $14, so the direction follows the
    // MRR: spec §0 invariant 3 decides upgrade vs downgrade on the normalized
    // amount, and §5.4 keeps the label consistent with the sign of net_change.
    // The Slack layer rewords this one for humans without touching either.
    const types = typesFor("1");
    assert.equal(types.filter((type) => type === "downgraded").length, 1);
    assert.equal(types.filter((type) => type === "upgraded").length, 0);

    const move = eventsFor("1").find((row) => row.type === "downgraded")!;
    assert.equal(move.plan_amount, 140 / 12);
    assert.ok(move.net_change! < 0, "the sign agrees with the label");
    assert.ok(Math.abs(move.net_change! - (140 / 12 - 14)) < 0.005);
  });

  it("reads a mid-cycle upgrade as one event and zero churn", () => {
    resetEnvironment();
    seed([
      {
        chargeRef: "old",
        shopId: "1",
        amount: 20,
        activatedAt: "2024-01-10T00:00:00Z",
        firstSaleAt: "2024-01-10T00:00:00Z",
        churnedAt: "2024-03-01T00:00:00Z",
      },
      {
        chargeRef: "new",
        shopId: "1",
        amount: 60,
        activatedAt: "2024-03-01T00:00:00Z",
        firstSaleAt: "2024-03-01T00:00:00Z",
      },
    ]);

    const types = typesFor("1");
    assert.equal(types.filter((type) => type === "unsubscribed").length, 0);
    assert.equal(types.filter((type) => type === "upgraded").length, 1);

    const upgrade = eventsFor("1").find((row) => row.type === "upgraded")!;
    assert.equal(upgrade.net_change, 40); // 60 - 20
    assert.ok(upgrade.prev_charge_id.endsWith("old"));

    // The cancel is kept on the record, marked as the plan change it was.
    const suppressed = eventsFor("1", { includeSuppressed: true }).filter(
      (row) => row.suppressed === 1,
    );
    assert.equal(suppressed.length, 1);
    assert.equal(suppressed[0]!.type, "unsubscribed");
  });

  /**
   * The reported failure. A merchant started a Starter trial and moved to Pro
   * two minutes later; Shopify cancelled the one and activated the other a
   * second apart, carrying the trial's end date across. Nothing had been paid
   * on Starter, and the fold read that as a trial abandoned followed by a
   * return. It was one upgrade.
   */
  it("reads a plan change made mid-trial as an upgrade, not an abandoned trial and a return", () => {
    resetEnvironment();
    seed([
      {
        chargeRef: "starter",
        shopId: "1",
        amount: 14,
        activatedAt: "2024-03-01T10:57:45Z",
        billingOn: "2024-03-15T00:00:00Z",
        churnedAt: "2024-03-01T11:00:09Z",
      },
      {
        chargeRef: "pro",
        shopId: "1",
        amount: 29,
        activatedAt: "2024-03-01T11:00:10Z",
        billingOn: "2024-03-15T00:00:00Z",
        firstSaleAt: "2024-03-15T00:00:00Z",
      },
    ]);

    const types = typesFor("1");
    assert.equal(types.filter((type) => type === "upgraded").length, 1);
    for (const wrong of ["trial_abandoned", "charge_abandoned", "resubscribed", "unsubscribed"]) {
      assert.equal(types.includes(wrong), false, `no ${wrong}`);
    }

    // A trial is still running, so the move carries no money until it converts.
    const upgrade = eventsFor("1").find((row) => row.type === "upgraded")!;
    assert.ok(upgrade.prev_charge_id.endsWith("starter"));
    assert.equal(upgrade.net_change, 0);
    assert.equal(ledgerTotal(), 29);

    const suppressed = eventsFor("1", { includeSuppressed: true }).filter(
      (row) => row.suppressed === 1,
    );
    assert.deepEqual(suppressed.map((row) => row.type), ["unsubscribed"]);
  });

  it("reads a downgrade as a negative move, still without churn", () => {
    resetEnvironment();
    seed([
      {
        chargeRef: "old",
        shopId: "1",
        amount: 80,
        activatedAt: "2024-01-10T00:00:00Z",
        firstSaleAt: "2024-01-10T00:00:00Z",
        churnedAt: "2024-03-01T00:00:00Z",
      },
      {
        chargeRef: "new",
        shopId: "1",
        amount: 30,
        activatedAt: "2024-03-01T00:00:00Z",
        firstSaleAt: "2024-03-01T00:00:00Z",
      },
    ]);

    const downgrade = eventsFor("1").find((row) => row.type === "downgraded")!;
    assert.equal(downgrade.net_change, -50);
    assert.equal(typesFor("1").includes("unsubscribed"), false);
  });

  it("records a real cancellation as churn", () => {
    resetEnvironment();
    seed([
      {
        chargeRef: "c1",
        shopId: "1",
        amount: 45,
        activatedAt: "2024-01-10T00:00:00Z",
        firstSaleAt: "2024-01-10T00:00:00Z",
        churnedAt: "2024-05-01T00:00:00Z",
      },
    ]);

    const churn = eventsFor("1").find((row) => row.type === "unsubscribed")!;
    assert.equal(churn.suppressed, 0);
    assert.equal(churn.net_change, -45);
    assert.equal(ledgerTotal(), 0);
  });

  it("calls a return a win-back rather than a first subscription", () => {
    resetEnvironment();
    seed([
      {
        chargeRef: "first",
        shopId: "1",
        amount: 25,
        activatedAt: "2024-01-10T00:00:00Z",
        firstSaleAt: "2024-01-10T00:00:00Z",
        churnedAt: "2024-02-10T00:00:00Z",
      },
      {
        chargeRef: "again",
        shopId: "1",
        amount: 25,
        activatedAt: "2024-09-01T00:00:00Z",
        firstSaleAt: "2024-09-01T00:00:00Z",
      },
    ]);

    const types = typesFor("1");
    assert.equal(types.filter((type) => type === "subscribed").length, 1);
    assert.equal(types.filter((type) => type === "resubscribed").length, 1);
  });

  /**
   * The reported failure. A merchant dropped a trial and signed up again a
   * couple of minutes later, and the fold called the second charge an upgrade:
   * an abandonment left the running state sitting on the charge nobody was
   * paying for, so the return looked like a merchant who had never left moving
   * tier. They did leave. It is a win-back.
   *
   * Outside the plan-change window, that is. A return inside 60 seconds is
   * spec §4.a's plan change, and is covered by the mid-trial upgrade above.
   */
  it("calls a return after an abandoned trial a win-back, not a plan change", () => {
    resetEnvironment();
    seed([
      {
        chargeRef: "dropped",
        shopId: "1",
        amount: 14,
        activatedAt: "2024-01-10T00:00:00Z",
        billingOn: "2024-01-24T00:00:00Z",
        churnedAt: "2024-01-14T00:00:00Z",
      },
      {
        chargeRef: "again",
        shopId: "1",
        amount: 14,
        activatedAt: "2024-01-14T00:02:00Z",
        billingOn: "2024-01-28T00:00:00Z",
        firstSaleAt: "2024-01-28T00:00:00Z",
      },
    ]);

    const types = typesFor("1");
    assert.equal(types.filter((type) => type === "trial_abandoned").length, 1);
    assert.equal(types.filter((type) => type === "resubscribed").length, 1);
    assert.equal(types.filter((type) => type === "upgraded").length, 0);
    assert.equal(types.filter((type) => type === "downgraded").length, 0);

    // Nothing was ever paid on the first charge, so the relabel moves no money.
    const back = eventsFor("1").find((row) => row.type === "resubscribed")!;
    assert.equal(back.net_change, 0);
    assert.equal(back.prev_charge_id, "");
    assert.equal(ledgerTotal(), 14);
  });

  /**
   * The reported failure. A merchant's store was paused, and the channel heard
   * both "Subscription cancelled" and "Subscription frozen" a second apart. Only
   * the freeze happened: Shopify does not cancel a charge when a shop is
   * deactivated, it freezes it, and spec §3.1 puts no MRR movement on the
   * deactivation at all.
   */
  it("treats a deactivation the platform answered with a freeze as frozen, not churned", () => {
    resetEnvironment();
    seed(
      [
        {
          chargeRef: "c1",
          shopId: "1",
          amount: 4.99,
          activatedAt: "2024-01-10T00:00:00Z",
          firstSaleAt: "2024-01-10T00:00:00Z",
          frozenAt: "2024-06-01T00:00:01Z",
        },
      ],
      { closes: [{ shopId: "1", at: "2024-06-01T00:00:00Z" }] },
    );

    const types = typesFor("1");
    assert.deepEqual(types, [
      "subscribed",
      "deactivated",
      "subscription_frozen",
    ]);
    assert.equal(types.filter((type) => type === "unsubscribed").length, 0);

    // The freeze carries the whole drop. It used to read zero, because the
    // phantom cancellation a second earlier had already taken the money.
    const frozen = eventsFor("1").find(
      (row) => row.type === "subscription_frozen",
    )!;
    assert.equal(frozen.net_change, -4.99);
    assert.equal(ledgerTotal(), 0);

    // And the subscription is not on the churn books at all — a paused store
    // can reopen, and this one is still theirs.
    const row = getDb()
      .prepare(
        "SELECT churn_at, churn_reason FROM subscriptions WHERE shop_id = ?",
      )
      .get("1") as { churn_at: string | null; churn_reason: string | null };
    assert.equal(row.churn_at, null);
    assert.equal(row.churn_reason, null);
  });

  /**
   * The other half: a shop that was deactivated and whose charge was never
   * frozen really is gone. It still must not be filed as an uninstall — spec
   * §7.1 keeps store closure out of product churn, because the merchant never
   * passed judgement on the app.
   */
  it("still ends a subscription when a deactivation was not answered by a freeze", () => {
    resetEnvironment();
    seed(
      [
        {
          chargeRef: "c1",
          shopId: "1",
          amount: 30,
          activatedAt: "2024-01-10T00:00:00Z",
          firstSaleAt: "2024-01-10T00:00:00Z",
        },
      ],
      { closes: [{ shopId: "1", at: "2024-06-01T00:00:00Z" }] },
    );

    const churn = eventsFor("1").find((row) => row.type === "unsubscribed")!;
    assert.equal(churn.net_change, -30);
    assert.equal(ledgerTotal(), 0);

    const row = getDb()
      .prepare("SELECT churn_reason FROM subscriptions WHERE shop_id = ?")
      .get("1") as { churn_reason: string | null };
    assert.equal(row.churn_reason, "deactivated");
  });

  /**
   * A trial that settles after the shop was already paused. The freeze has taken
   * the subscription to nothing, so the conversion cannot hand the money back —
   * doing so put the ledger $19.99 ahead of what `asOfPredicate` reports.
   */
  it("withholds a conversion that lands while the charge is frozen", () => {
    resetEnvironment();
    seed(
      [
        {
          chargeRef: "c1",
          shopId: "1",
          amount: 20,
          activatedAt: "2024-01-10T00:00:00Z",
          billingOn: "2024-01-24T00:00:00Z",
          firstSaleAt: "2024-01-24T00:00:00Z",
          frozenAt: "2024-01-20T00:00:01Z",
        },
      ],
      { closes: [{ shopId: "1", at: "2024-01-20T00:00:00Z" }] },
    );

    const converted = eventsFor("1").find(
      (row) => row.type === "trial_converted",
    )!;
    assert.equal(converted.net_change, 0, "frozen subscriptions bill nothing");
    assert.equal(ledgerTotal(), 0);
  });

  it("drops MRR on a freeze and restores it on a thaw, without churning", () => {
    resetEnvironment();
    seed([
      {
        chargeRef: "c1",
        shopId: "1",
        amount: 40,
        activatedAt: "2024-01-10T00:00:00Z",
        firstSaleAt: "2024-01-10T00:00:00Z",
        frozenAt: "2024-03-01T00:00:00Z",
        unfrozenAt: "2024-04-01T00:00:00Z",
      },
    ]);

    const rows = eventsFor("1");
    assert.equal(
      rows.find((row) => row.type === "subscription_frozen")!.net_change,
      -40,
    );
    assert.equal(
      rows.find((row) => row.type === "subscription_unfrozen")!.net_change,
      40,
    );
    assert.equal(typesFor("1").includes("unsubscribed"), false);
    assert.equal(ledgerTotal(), 40);
  });

  it("holds the money back until a trial converts", () => {
    resetEnvironment();
    seed([
      {
        chargeRef: "c1",
        shopId: "1",
        amount: 30,
        activatedAt: "2024-01-01T00:00:00Z",
        // Fourteen days later: a trial, not a same-day purchase.
        firstSaleAt: "2024-01-15T00:00:00Z",
      },
    ]);

    const rows = eventsFor("1");
    // Subscribing during a trial is real, but worth nothing yet.
    assert.equal(rows.find((row) => row.type === "subscribed")!.net_change, 0);
    assert.ok(rows.some((row) => row.type === "trial_started"));

    const converted = rows.find((row) => row.type === "trial_converted")!;
    assert.equal(converted.net_change, 30);
    assert.equal(converted.occurred_at, "2024-01-15T00:00:00.000Z");
    assert.equal(ledgerTotal(), 30);
  });

  it("reports a trial the merchant walked out of at the moment they left", () => {
    resetEnvironment();
    seed([
      {
        chargeRef: "c1",
        shopId: "1",
        amount: 30,
        activatedAt: "2024-01-01T00:00:00Z",
        billingOn: "2024-01-15T00:00:00Z",
        churnedAt: "2024-01-10T00:00:00Z",
      },
    ]);

    const types = typesFor("1");
    assert.ok(types.includes("trial_started"));
    assert.ok(types.includes("trial_abandoned"));
    // Spec 6.2: nothing expired here. The window never closed — the merchant
    // left five days short of it, and dating an expiry at the 15th would report
    // them as still trialling for five days after they had gone.
    assert.equal(types.includes("trial_expired"), false);
    const left = eventsFor("1").find((row) => row.type === "trial_abandoned")!;
    assert.equal(left.occurred_at, "2024-01-10T00:00:00.000Z");
    // A charge that never billed was abandoned, not churned: no MRR to lose.
    assert.equal(types.includes("unsubscribed"), false);
    assert.equal(ledgerTotal(), 0);
  });

  it("expires a trial that reached the end of its window still running", () => {
    resetEnvironment();
    seed([
      {
        chargeRef: "c1",
        shopId: "1",
        amount: 30,
        activatedAt: "2024-01-01T00:00:00Z",
        billingOn: "2024-01-15T00:00:00Z",
        churnedAt: "2024-01-20T00:00:00Z",
      },
    ]);

    const types = typesFor("1");
    assert.ok(
      types.includes("trial_expired"),
      "the window closed before they left",
    );
    assert.equal(types.includes("trial_abandoned"), false);
    const expired = eventsFor("1").find((row) => row.type === "trial_expired")!;
    assert.equal(expired.occurred_at, "2024-01-15T00:00:00.000Z");
    assert.equal(ledgerTotal(), 0);
  });

  it("does not call a charge with no trial window an abandoned trial", () => {
    resetEnvironment();
    seed([
      {
        chargeRef: "c1",
        shopId: "1",
        amount: 30,
        // Approved and gone the same instant, and no billing date to define a
        // free period: there was never a trial to walk out of.
        activatedAt: "2024-01-01T00:00:00Z",
        churnedAt: "2024-01-01T00:00:00Z",
      },
    ]);

    const types = typesFor("1");
    assert.equal(types.includes("trial_abandoned"), false);
    assert.ok(types.includes("charge_abandoned"));
  });

  it("does not invent a trial for a returning merchant who paid up front", () => {
    resetEnvironment();
    seed(
      [
        // The first run: a real 14-day trial that converted and later churned.
        {
          chargeRef: "first",
          shopId: "1",
          amount: 14,
          activatedAt: "2025-07-21T07:09:49Z",
          billingOn: "2025-08-04T00:00:00Z",
          firstSaleAt: "2025-08-25T11:43:16Z",
          churnedAt: "2025-08-21T11:11:40Z",
        },
        // A year on they come back. Shopify does not re-run a trial it has
        // already given this shop, so it bills at once and sets the next date a
        // full cycle out. Two days later they leave, before the payout batch
        // carrying that charge has settled.
        {
          chargeRef: "return",
          shopId: "1",
          amount: 14,
          activatedAt: "2026-08-27T12:01:32Z",
          billingOn: "2026-09-26T00:00:00Z",
          churnedAt: "2026-08-29T04:16:31Z",
        },
      ],
      {
        installs: [
          { shopId: "1", at: "2025-07-21T06:37:07Z" },
          { shopId: "1", at: "2026-08-26T06:18:39Z" },
        ],
        uninstalls: [
          { shopId: "1", at: "2025-08-21T11:11:39Z" },
          { shopId: "1", at: "2026-08-29T04:16:30Z" },
        ],
      },
    );

    const returning = eventsFor("1").filter(
      (row) => row.occurred_at >= "2026-01-01",
    );
    const types = returning.map((row) => row.type);

    // The whole point: a cancellation is not evidence of a trial. Reading it as
    // one announced this merchant's return as a trial start and their departure
    // as a trial cancellation, neither of which happened.
    assert.equal(types.includes("trial_started"), false);
    assert.equal(types.includes("trial_abandoned"), false);
    assert.ok(types.includes("resubscribed"));
    assert.ok(types.includes("unsubscribed"));

    // And they were a paying customer for those two days, which the old reading
    // erased: with no trial there is money to lose, so the loss is booked.
    assert.equal(
      returning.find((row) => row.type === "resubscribed")!.net_change,
      14,
    );
    assert.equal(
      returning.find((row) => row.type === "unsubscribed")!.net_change,
      -14,
    );
    assert.equal(ledgerTotal(), 0);
  });

  it("does not read a billing date inherited from a paid cycle as a trial", () => {
    resetEnvironment();
    seed(
      [
        {
          chargeRef: "first",
          shopId: "1",
          amount: 14,
          activatedAt: "2025-07-21T07:09:49Z",
          billingOn: "2025-08-04T00:00:00Z",
          firstSaleAt: "2025-08-25T11:43:16Z",
          churnedAt: "2025-08-21T11:11:40Z",
        },
        {
          chargeRef: "paid",
          shopId: "1",
          amount: 14,
          activatedAt: "2026-08-27T12:01:32Z",
          billingOn: "2026-09-26T00:00:00Z",
          churnedAt: "2026-08-29T04:16:31Z",
        },
        // Signing up a third time inside the cycle they have already paid for.
        // Shopify keeps the anchor, so `billingOn` is now only 26 days out —
        // shorter than a cycle, and indistinguishable from a part-cycle trial
        // unless you know this shop has paid before.
        {
          chargeRef: "again",
          shopId: "1",
          amount: 14,
          activatedAt: "2026-08-30T13:04:50Z",
          billingOn: "2026-09-26T00:00:00Z",
          churnedAt: "2026-09-02T02:16:13Z",
        },
      ],
      {
        installs: [
          { shopId: "1", at: "2025-07-21T06:37:07Z" },
          { shopId: "1", at: "2026-08-26T06:18:39Z" },
          { shopId: "1", at: "2026-08-30T12:48:36Z" },
        ],
        uninstalls: [
          { shopId: "1", at: "2025-08-21T11:11:39Z" },
          { shopId: "1", at: "2026-08-29T04:16:30Z" },
          { shopId: "1", at: "2026-09-02T02:16:13Z" },
        ],
      },
    );

    const last = eventsFor("1").filter(
      (row) => row.occurred_at >= "2026-08-30",
    );
    const types = last.map((row) => row.type);
    assert.equal(types.includes("trial_started"), false);
    assert.equal(types.includes("trial_abandoned"), false);
    assert.ok(types.includes("resubscribed"));
  });

  it("still reads a genuine part-cycle trial on a shop that never paid", () => {
    resetEnvironment();
    seed([
      {
        chargeRef: "c1",
        shopId: "1",
        amount: 14,
        // No history behind this shop, and Shopify is visibly waiting a
        // fortnight before it charges: the one shape that is a trial.
        activatedAt: "2026-08-27T12:01:32Z",
        billingOn: "2026-09-10T00:00:00Z",
        churnedAt: "2026-08-29T04:16:31Z",
      },
    ]);

    const types = typesFor("1");
    assert.ok(types.includes("trial_started"));
    assert.ok(types.includes("trial_abandoned"));
    assert.equal(types.includes("unsubscribed"), false);
    assert.equal(ledgerTotal(), 0);
  });

  it("records the loss once when a merchant uninstalls instead of cancelling", () => {
    resetEnvironment();
    seed(
      [
        {
          chargeRef: "c1",
          shopId: "1",
          amount: 35,
          activatedAt: "2024-01-10T00:00:00Z",
          firstSaleAt: "2024-01-10T00:00:00Z",
        },
      ],
      {
        installs: [{ shopId: "1", at: "2024-01-09T00:00:00Z" }],
        uninstalls: [{ shopId: "1", at: "2024-06-01T00:00:00Z" }],
      },
    );

    const churns = eventsFor("1").filter((row) => row.type === "unsubscribed");
    assert.equal(
      churns.length,
      1,
      "exactly one loss, not one per feed that noticed it",
    );
    assert.equal(churns[0]!.net_change, -35);
    assert.ok(typesFor("1").includes("uninstalled"));
    assert.equal(ledgerTotal(), 0);
  });

  it("is idempotent: rebuilding produces the identical event set", () => {
    resetEnvironment();
    const db = seed([
      {
        chargeRef: "c1",
        shopId: "1",
        amount: 20,
        activatedAt: "2024-01-10T00:00:00Z",
        firstSaleAt: "2024-01-10T00:00:00Z",
      },
    ]);

    const snapshot = () =>
      db
        .prepare(
          "SELECT event_id, type, net_change FROM customer_events ORDER BY event_id",
        )
        .all();
    const first = snapshot();

    rebuildDerivedTables(db);

    assert.deepEqual(snapshot(), first);
  });
});

describe("the ledger reconciles with the MRR reconstruction", () => {
  after(() => closeDb());

  /**
   * The load-bearing invariant. `net_change` accumulates forward from events
   * while MRR is rebuilt backwards from subscription state — if a classification
   * rule is wrong, these two disagree, which is precisely what makes the check
   * worth running.
   */
  it("sums every delta to the MRR the reports show", () => {
    resetEnvironment();
    seed([
      // Paid from day one.
      {
        chargeRef: "plain",
        shopId: "1",
        amount: 50,
        activatedAt: "2024-01-10T00:00:00Z",
        firstSaleAt: "2024-01-10T00:00:00Z",
      },
      // Trialled, then converted.
      {
        chargeRef: "trial",
        shopId: "2",
        amount: 30,
        activatedAt: "2024-02-01T00:00:00Z",
        firstSaleAt: "2024-02-20T00:00:00Z",
      },
      // Upgraded mid-life.
      {
        chargeRef: "up-old",
        shopId: "3",
        amount: 20,
        activatedAt: "2024-01-05T00:00:00Z",
        firstSaleAt: "2024-01-05T00:00:00Z",
        churnedAt: "2024-04-01T00:00:00Z",
      },
      {
        chargeRef: "up-new",
        shopId: "3",
        amount: 90,
        activatedAt: "2024-04-01T00:00:00Z",
        firstSaleAt: "2024-04-01T00:00:00Z",
      },
      // Churned for real.
      {
        chargeRef: "gone",
        shopId: "4",
        amount: 45,
        activatedAt: "2024-01-01T00:00:00Z",
        firstSaleAt: "2024-01-01T00:00:00Z",
        churnedAt: "2024-05-01T00:00:00Z",
      },
      // Still frozen.
      {
        chargeRef: "cold",
        shopId: "5",
        amount: 60,
        activatedAt: "2024-01-01T00:00:00Z",
        firstSaleAt: "2024-01-01T00:00:00Z",
        frozenAt: "2024-03-01T00:00:00Z",
      },
    ]);

    const mrr = runMetric(
      "mrr",
      { period: "all_time" },
      { now: new Date("2024-12-01T00:00:00Z") },
    );

    // 50 (plain) + 30 (converted trial) + 90 (upgraded) = 170.
    // Churned and frozen subscriptions contribute nothing.
    assert.equal(Math.round(mrr.value * 100) / 100, 170);
    assert.equal(ledgerTotal(), Math.round(mrr.value * 100) / 100);
  });
});

describe("the customer read model", () => {
  after(() => closeDb());

  before(() => {
    resetEnvironment();
    seed(
      [
        {
          chargeRef: "c1",
          shopId: "7",
          amount: 75,
          activatedAt: "2024-01-10T00:00:00Z",
          firstSaleAt: "2024-01-10T00:00:00Z",
          extraSales: [
            { at: "2024-02-10T00:00:00Z", gross: 75 },
            { at: "2024-03-10T00:00:00Z", gross: 75 },
          ],
        },
        {
          chargeRef: "c2",
          shopId: "8",
          amount: 25,
          activatedAt: "2024-02-01T00:00:00Z",
          firstSaleAt: "2024-02-01T00:00:00Z",
          churnedAt: "2024-04-01T00:00:00Z",
        },
      ],
      { installs: [{ shopId: "7", at: "2024-01-09T00:00:00Z" }] },
    );
  });

  it("finds a merchant by their myshopify domain", () => {
    const found = listCustomers({ search: "s7.example" });
    assert.equal(found.total, 1);
    assert.equal(found.customers[0]!.shopId, "7");
  });

  it("finds a merchant by name", () => {
    const found = listCustomers({ search: "Shop 8" });
    assert.equal(found.total, 1);
    assert.equal(found.customers[0]!.shopId, "8");
  });

  it("separates a paying merchant from one who left", () => {
    const paying = listCustomers({ search: "s7.example" }).customers[0]!;
    assert.equal(paying.status, "paying");
    assert.equal(paying.mrr, 75);
    assert.equal(paying.lifetimeGross, 225); // three charges of 75

    const churned = listCustomers({ search: "s8.example" }).customers[0]!;
    assert.equal(churned.status, "churned");
    assert.equal(churned.mrr, 0);
  });

  it("opens a merchant with their plan, their money and their history", () => {
    const detail = getCustomer("7")!;
    assert.equal(detail.domain, "s7.example");
    assert.equal(detail.mrr, 75);
    assert.equal(detail.lifetimeGross, 225);
    assert.equal(detail.paymentCount, 3);

    const active = detail.subscriptions.filter(
      (sub) => sub.status === "active",
    );
    assert.equal(active.length, 1);
    assert.equal(active[0]!.appId, APP_ID);
    assert.equal(active[0]!.monthlyAmount, 75);

    // The timeline is newest first and carries both lifecycle and money.
    assert.ok(detail.events.some((event) => event.type === "subscribed"));
    assert.equal(
      detail.events.filter((event) => event.type === "payment").length,
      3,
    );
    assert.ok(
      detail.events[0]!.occurredAt >=
        detail.events[detail.events.length - 1]!.occurredAt,
    );
  });

  it("reports nothing for a shop that was never seen", () => {
    assert.equal(getCustomer("does-not-exist"), null);
  });

  /**
   * The App Store shows the day a review was posted and never the time, so a
   * review is stored at that day's midnight. Ordered on that alone it lands
   * ahead of everything else that day — including the install that had to come
   * first for the merchant to have anything to review.
   */
  it("places a same-day review after the install it must have followed", () => {
    resetEnvironment();
    seed(
      [
        {
          chargeRef: "c1",
          shopId: "20",
          amount: 25,
          activatedAt: "2024-05-10T09:15:00Z",
          firstSaleAt: "2024-05-10T09:15:00Z",
        },
      ],
      { installs: [{ shopId: "20", at: "2024-05-10T09:14:00Z" }] },
    );

    getDb()
      .prepare(
        `INSERT INTO customer_events (
           event_id, app_id, shop_id, type, occurred_at, charge_id, prev_charge_id,
           plan_name, plan_amount, billing_interval, currency, net_change, amount,
           suppressed, detail
         ) VALUES ('review:r1:posted', ?, '20', 'review_posted', '2024-05-10T00:00:00.000Z',
                   '', '', NULL, NULL, NULL, NULL, NULL, NULL, 0, ?)`,
      )
      .run(APP_ID, JSON.stringify({ rating: 5, storeName: "Shop 20" }));

    // Newest first, so the review must appear above — not below — the install.
    const order = getCustomer("20")!.events.map((event) => event.type);
    assert.ok(
      order.indexOf("review_posted") < order.indexOf("installed"),
      `review should follow the install, got ${order.join(" → ")}`,
    );
    assert.ok(order.indexOf("review_posted") < order.indexOf("subscribed"));

    // The stamp itself is left alone: the day is all anyone ever knew.
    const review = getCustomer("20")!.events.find(
      (event) => event.type === "review_posted",
    )!;
    assert.equal(review.occurredAt, "2024-05-10T00:00:00.000Z");
  });
});
