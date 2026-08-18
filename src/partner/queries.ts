/**
 * Every GraphQL document sent to the Partner API.
 *
 * Two feeds carry everything the reports need:
 *   - `app.events`  — the subscription and install lifecycle (state changes)
 *   - `transactions` — the money actually charged and paid out (cash)
 *
 * The Partner API has no query that lists an organization's apps, so apps are
 * discovered from the `app` field on transactions and confirmed via `app(id:)`.
 */

/** Money is nullable on several transaction types; always request both halves. */
const MONEY = `{ amount currencyCode }`;

const SHOP = `{ id name myshopifyDomain }`;

const SALE_FIELDS = `
  app { id name }
  shop ${SHOP}
  chargeId
  grossAmount ${MONEY}
  netAmount ${MONEY}
  shopifyFee ${MONEY}
`;

export const TRANSACTIONS_QUERY = /* GraphQL */ `
  query PartnerdexTransactions(
    $after: String
    $createdAtMin: DateTime
    $createdAtMax: DateTime
    $types: [TransactionType!]
    $appId: ID
  ) {
    transactions(
      first: 100
      after: $after
      createdAtMin: $createdAtMin
      createdAtMax: $createdAtMax
      types: $types
      appId: $appId
    ) {
      pageInfo {
        hasNextPage
      }
      edges {
        cursor
        node {
          id
          createdAt
          __typename
          ... on AppSubscriptionSale {
            billingInterval
            ${SALE_FIELDS}
          }
          ... on AppOneTimeSale {
            ${SALE_FIELDS}
          }
          ... on AppUsageSale {
            ${SALE_FIELDS}
          }
          ... on AppSaleAdjustment {
            ${SALE_FIELDS}
          }
          ... on AppSaleCredit {
            ${SALE_FIELDS}
          }
        }
      }
    }
  }
`;

export const APP_EVENTS_QUERY = /* GraphQL */ `
  query PartnerdexAppEvents(
    $appId: ID!
    $after: String
    $occurredAtMin: DateTime
    $occurredAtMax: DateTime
    $types: [AppEventTypes!]
  ) {
    app(id: $appId) {
      id
      name
      events(
        first: 100
        after: $after
        occurredAtMin: $occurredAtMin
        occurredAtMax: $occurredAtMax
        types: $types
      ) {
        pageInfo {
          hasNextPage
        }
        edges {
          cursor
          node {
            type
            occurredAt
            __typename
            shop ${SHOP}
            ... on AppSubscriptionEvent {
              charge {
                id
                name
                test
                billingOn
                amount ${MONEY}
              }
            }
          }
        }
      }
    }
  }
`;

export const APP_QUERY = /* GraphQL */ `
  query PartnerdexApp($appId: ID!) {
    app(id: $appId) {
      id
      name
      apiKey
    }
  }
`;

/**
 * The check run before an organization is saved: does this token open this
 * organization, and what does it reach?
 *
 * Five newest transactions, for the apps on them and nothing else. The
 * organization id is in the endpoint path, so a token from elsewhere is refused
 * before this document is even parsed; what the app names add is the other
 * mistake — a working credential for an organization that is not the one the
 * operator meant. See `src/orgs/verify.ts`.
 *
 * Deliberately not `HEALTHCHECK_QUERY`: that one asks for an id and a date, and
 * an id and a date are not something anybody can recognise.
 */
export const ORGANIZATION_PROBE_QUERY = /* GraphQL */ `
  query PartnerdexOrganizationProbe {
    transactions(first: 5) {
      edges {
        node {
          createdAt
          ... on AppSubscriptionSale {
            app { id name }
          }
          ... on AppOneTimeSale {
            app { id name }
          }
          ... on AppUsageSale {
            app { id name }
          }
        }
      }
    }
  }
`;

/** Cheap call used by `partnerdex doctor` to prove credentials and scopes work. */
export const HEALTHCHECK_QUERY = /* GraphQL */ `
  query PartnerdexHealthcheck {
    transactions(first: 1) {
      edges {
        node {
          id
          createdAt
        }
      }
    }
  }
`;

/** Subscription lifecycle event types that move MRR. */
export const SUBSCRIPTION_EVENT_TYPES = [
  'SUBSCRIPTION_CHARGE_ACCEPTED',
  'SUBSCRIPTION_CHARGE_ACTIVATED',
  'SUBSCRIPTION_CHARGE_CANCELED',
  'SUBSCRIPTION_CHARGE_DECLINED',
  'SUBSCRIPTION_CHARGE_EXPIRED',
  'SUBSCRIPTION_CHARGE_FROZEN',
  'SUBSCRIPTION_CHARGE_UNFROZEN',
] as const;

/** Install lifecycle event types, used for active-install and logo churn. */
export const RELATIONSHIP_EVENT_TYPES = [
  'RELATIONSHIP_INSTALLED',
  'RELATIONSHIP_UNINSTALLED',
  'RELATIONSHIP_REACTIVATED',
  'RELATIONSHIP_DEACTIVATED',
] as const;

export const SYNCED_EVENT_TYPES = [
  ...SUBSCRIPTION_EVENT_TYPES,
  ...RELATIONSHIP_EVENT_TYPES,
] as const;

export const SALE_TRANSACTION_TYPES = [
  'APP_SUBSCRIPTION_SALE',
  'APP_ONE_TIME_SALE',
  'APP_USAGE_SALE',
  'APP_SALE_ADJUSTMENT',
  'APP_SALE_CREDIT',
] as const;
