import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { fetchSessions } from "../_shared/shopify-sessions.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { hasCronSecret, isServiceRoleAuthorization, requireStaffUserId } from "../_shared/auth.ts";
import { decryptString } from "../_shared/crypto.ts";
import { normalizeShopDomain, shopifyRest, shopifyGraphql, mapShopifyErrorCode, exchangeClientCredentials } from "../_shared/shopify-api.ts";
import {
  BULK_WINDOW_DAYS, currentBulk, ingestBulkOrders, pollBulk, startBulkOrders, type BulkOrderRow } from "../_shared/shopify-bulk.ts";
import { computeRepeat, repeatHistory, repeatRate } from "../_shared/repeat-rate.ts";
import { isCustomerAccessError } from "./customer-access.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const PERIOD_DAYS = 30;
const ORDERS_PAGE_SIZE = 250;
const ORDERS_MAX_PAGES = 8; // cap at 2000 orders across the fetched window
const TOP_PRODUCTS_SAMPLE = 100; // recent current-period orders sampled for top-products ranking
const DAY_MS = 24 * 60 * 60 * 1000;

/** Basket analysis (what sells together, how many items an order holds) needs
 * ORDERS, not days. lazyleaf takes 9 orders in 30 days, and "these two products
 * are bought together" off 9 orders is noise dressed as insight. So the KPI
 * comparison stays 30d vs prior 30d, while the basket stats widen to the
 * narrowest window that clears BASKET_MIN_ORDERS, and the window used is
 * reported alongside every number so nobody reads a 180-day pattern as this
 * month's behaviour. */
const BASKET_WINDOWS = [30, 90, 180];
const BASKET_MIN_ORDERS = 40;
/** Below this a co-occurrence is coincidence, not a pattern worth a bundle. */
const MIN_PAIR_ORDERS = 3;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function pctDelta(current: number, previous: number): number | null {
  if (!Number.isFinite(previous) || previous === 0) return null;
  return round2(((current - previous) / previous) * 100);
}

type PeriodAgg = { order_count: number; gross_revenue: number; returning_orders: number };

function emptyPeriod(): PeriodAgg {
  return { order_count: 0, gross_revenue: 0, returning_orders: 0 };
}

function summarizePeriod(p: PeriodAgg) {
  return {
    order_count: p.order_count,
    gross_revenue: round2(p.gross_revenue),
    aov: p.order_count > 0 ? round2(p.gross_revenue / p.order_count) : 0,
    returning_customer_rate: p.order_count > 0 ? round2((p.returning_orders / p.order_count) * 100) : 0,
  };
}

const corsHeaders: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers":
    "authorization, x-client-info, apikey, content-type, accept, origin, referer, user-agent",
  "access-control-allow-methods": "POST, OPTIONS",
};

function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    headers: {
      ...corsHeaders,
      "content-type": "application/json; charset=utf-8",
      ...(init.headers ?? {}),
    },
    ...init,
  });
}

function assertServiceClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function authorize(req: Request) {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (token && isServiceRoleAuthorization(token)) return;
  // The web pipeline's own secret, as the capture and analysis steps accept:
  // lets a backfill re-read the store data without a signed-in user.
  if (await hasCronSecret(req, "web_pipeline_cron_secret")) return;
  // A session alone is not enough: we act with the service role, so only staff
  // with audit access may drive this.
  await requireStaffUserId(req, "audits");
}

/** Sample recent current-period orders' line items to rank top products by revenue. */
async function fetchTopProducts(shopDomain: string, token: string, currentSince: string) {
  try {
    const res = await shopifyGraphql(
      shopDomain,
      token,
      `query TopProducts($first: Int!, $query: String!) {
        orders(first: $first, sortKey: CREATED_AT, reverse: true, query: $query) {
          nodes {
            lineItems(first: 5) {
              nodes { title discountedTotalSet { shopMoney { amount } } }
            }
          }
        }
      }`,
      { first: TOP_PRODUCTS_SAMPLE, query: `created_at:>='${currentSince}'` },
    );
    if (!res.ok) return { items: [], sampled: 0, note: "unavailable" };
    const nodes: any[] = res.body?.data?.orders?.nodes ?? [];
    const byTitle = new Map<string, number>();
    for (const order of nodes) {
      for (const li of order?.lineItems?.nodes ?? []) {
        const title = String(li?.title ?? "").trim();
        if (!title) continue;
        const amount = Number.parseFloat(li?.discountedTotalSet?.shopMoney?.amount ?? "0");
        if (Number.isFinite(amount)) byTitle.set(title, (byTitle.get(title) ?? 0) + amount);
      }
    }
    const items = [...byTitle.entries()]
      .map(([title, revenue]) => ({ title, revenue: round2(revenue) }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5);
    return { items, sampled: nodes.length, note: nodes.length >= TOP_PRODUCTS_SAMPLE ? "sample" : "full" };
  } catch {
    return { items: [], sampled: 0, note: "error" };
  }
}

/** Shopify's sourceName codes, as a merchant would name them. Anything not
 * listed is either an app (named via order.app) or a channel we pass through
 * as-is; a bare numeric id is an app we could not name, and "Other app" beats
 * printing the id at a client. */
const SOURCE_LABELS: Record<string, string> = {
  web: "Online store",
  pos: "Point of sale",
  shopify_draft_order: "Draft order",
  draft_order: "Draft order",
  iphone: "Shopify mobile",
  android: "Shopify mobile",
  shopify_payments_checkout: "Online store",
  subscription_contract: "Subscriptions",
};

export function channelLabel(sourceName: unknown, appName?: unknown): string {
  const src = String(sourceName ?? "").trim();
  const mapped = SOURCE_LABELS[src.toLowerCase()];
  if (mapped) return mapped;
  const app = String(appName ?? "").trim();
  if (app) return app;
  if (!src) return "Unknown";
  // An id, not a name. Never show it.
  if (/^\d+$/.test(src)) return "Other app";
  return src.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

/** Paginate the orders window and aggregate. `includeCustomer` pulls the
 * protected customer field (needed for returning-customer rate); when the app
 * lacks protected-customer-data access, that field is dropped. Throws on a hard
 * API error so the caller can retry without the customer field. */
async function aggregateOrders(
  shopDomain: string,
  token: string,
  priorSince: string,
  currentSinceMs: number,
  includeCustomer: boolean,
  /** Start of the PRIOR comparison period. Orders older than this are kept for
   * basket analysis but counted in neither KPI bucket: the fetch window is much
   * wider than the comparison window, and lumping six months into "previous"
   * would make every delta nonsense. */
  priorStartMs: number,
) {
  const current = emptyPeriod();
  const previous = emptyPeriod();
  const channels = new Map<string, { revenue: number; orders: number }>();
  let currency: string | null = null;
  let cursor: string | null = null;
  let pages = 0;
  let truncated = false;

  const customerField = includeCustomer ? "customer { id }" : "";
  // sourceName is a code, and for orders placed through an app it is that app's
  // numeric id: the report was printing "3890849" as if it were a sales channel.
  // The app's own name is the readable version. Dropped and retried without it
  // if the field is ever refused, since a channel label is not worth losing the
  // whole orders pass over.
  let includeApp = true;
  // Per-order records for the basket work, collected in the same pass as the
  // KPI buckets: one Shopify page-through, not two. Line items and discounts
  // both come under read_orders, which every connection already grants, so none
  // of this needs a new scope.
  const orders: BasketOrder[] = [];

  while (pages < ORDERS_MAX_PAGES) {
    const res = await shopifyGraphql(
      shopDomain,
      token,
      `query Orders($first: Int!, $after: String, $query: String!) {
        orders(first: $first, after: $after, sortKey: CREATED_AT, reverse: true, query: $query) {
          pageInfo { hasNextPage endCursor }
          nodes {
            createdAt
            sourceName
            ${includeApp ? "app { name }" : ""}
            currentTotalPriceSet { shopMoney { amount currencyCode } }
            totalDiscountsSet { shopMoney { amount } }
            lineItems(first: 25) {
              nodes {
                quantity
                title
                originalTotalSet { shopMoney { amount } }
                variant { price }
                product { handle featuredImage { url } priceRangeV2 { minVariantPrice { amount } } }
              }
            }
            ${customerField}
          }
        }
      }`,
      { first: ORDERS_PAGE_SIZE, after: cursor, query: `created_at:>='${priorSince}'` },
    );
    if (!res.ok) {
      const message = res.body?.errors?.[0]?.message ?? `Orders query failed (${res.status})`;
      if (includeApp && /(^|[^a-z])app([^a-z]|$)/i.test(message)) {
        includeApp = false;
        continue;
      }
      throw Object.assign(new Error(message), { code: mapShopifyErrorCode(res.status) });
    }
    const conn = res.body?.data?.orders;
    const nodes: any[] = conn?.nodes ?? [];
    for (const node of nodes) {
      const money = node?.currentTotalPriceSet?.shopMoney;
      const amount = Number.parseFloat(money?.amount ?? "0");
      const rev = Number.isFinite(amount) ? amount : 0;
      if (!currency && money?.currencyCode) currency = money.currencyCode;
      const createdMs = new Date(node?.createdAt ?? 0).getTime();
      const isCurrent = createdMs >= currentSinceMs;
      // Older than the prior period: basket data only, no KPI bucket.
      const bucket = isCurrent ? current : (createdMs >= priorStartMs ? previous : null);
      if (bucket) {
        bucket.order_count += 1;
        bucket.gross_revenue += rev;
        // returning_orders is filled in afterwards by computeRepeat: whether an
        // order is a repeat depends on the customer's OTHER orders, so it cannot
        // be decided while walking one order at a time.
      }
      if (isCurrent) {
        const channel = channelLabel(node?.sourceName, node?.app?.name);
        const c = channels.get(channel) ?? { revenue: 0, orders: 0 };
        c.revenue += rev;
        c.orders += 1;
        channels.set(channel, c);
      }
      const liNodes: any[] = node?.lineItems?.nodes ?? [];
      const discount = Number.parseFloat(node?.totalDiscountsSet?.shopMoney?.amount ?? "0");
      const customerNodeId = node?.customer?.id;
      orders.push({
        created_ms: new Date(node?.createdAt ?? 0).getTime(),
        customerId: typeof customerNodeId === "string" ? customerNodeId : null,
        revenue: rev,
        discount: Number.isFinite(discount) ? discount : 0,
        units: liNodes.reduce((s, li) => s + (Number(li?.quantity) || 0), 0),
        items: liNodes.map((li) => ({
          title: String(li?.title ?? "").trim(),
          revenue: Number.parseFloat(li?.originalTotalSet?.shopMoney?.amount ?? "0") || 0,
          units: Number(li?.quantity) || 0,
          // Handle, image and unit price so the report can show a real product
          // card that links to the live storefront page, instead of a title in a
          // list. Read off the line item rather than a separate products fetch:
          // these are exactly the products that sell.
          handle: String(li?.product?.handle ?? "").trim() || null,
          image: String(li?.product?.featuredImage?.url ?? "").trim() || null,
          unit_price: Number.parseFloat(li?.variant?.price ?? "0") || null,
          // The price of whichever variant sold is not the list price: a pair or a
          // 14k version put Thin Hoop Earrings at $74 against a $37 list (Hugo).
          from_price: Number.parseFloat(li?.product?.priceRangeV2?.minVariantPrice?.amount ?? "") || null,
        })).filter((i) => i.title),
      });
    }
    pages += 1;
    if (conn?.pageInfo?.hasNextPage && conn?.pageInfo?.endCursor) {
      cursor = conn.pageInfo.endCursor;
      if (pages >= ORDERS_MAX_PAGES) truncated = true;
    } else {
      break;
    }
  }

  return { current, previous, channels, currency, truncated, orders };
}

type BasketOrder = {
  created_ms: number;
  revenue: number;
  discount: number;
  units: number;
  /** Null on guest checkouts and when read_customers is absent. */
  customerId?: string | null;
  items: Array<{
    title: string;
    revenue: number;
    units: number;
    handle: string | null;
    image: string | null;
    unit_price: number | null;
    from_price?: number | null;
  }>;
};

/** Shipping protection, insurance, packaging and free-gift lines: things that
 *  ride along on an order rather than products the shopper picked. */
const ADD_ON_TITLE = /shipping protection|package protection|order protection|shipping insurance|package insurance|navidium|route\b.*protect|\bseel\b|\bcorso\b|extend protection|carbon (offset|neutral)|green shipping|gift (wrap|wrapping|note|message|box)\b|jewelry pouch|\bfree gift\b/i;
export function isAddOnLine(item: { title: string; revenue: number; unit_price: number | null; handle?: string | null }): boolean {
  if (ADD_ON_TITLE.test(item.title)) return true;
  if (item.handle && /freegift|free-gift|shipping-protection|package-protection/i.test(item.handle)) return true;
  // A $0 line is a gift or a freebie, never a product someone chose to buy.
  return item.revenue <= 0 && (item.unit_price ?? 0) <= 0;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return round2(sorted[idx]);
}

/** Everything the AOV, margin and catalog plays are built from.
 *
 * Deliberately facts only, no advice: the analysis step turns these into plays.
 * Each number carries the window and the order count behind it so a play can say
 * "over 180 days" and a reader can judge the weight of it. */
function analyzeBaskets(
  all: BasketOrder[],
  nowMs: number,
  /** Why a short window might be short, so the report never blames the wrong
   * thing. "truncated" means WE stopped fetching at the page cap; "hasAllOrders"
   * is whether the app actually holds read_all_orders. */
  cause: { truncated: boolean; hasAllOrders: boolean | null },
) {
  const inWindow = (days: number) => all.filter((o) => o.created_ms >= nowMs - days * DAY_MS);
  // Narrowest window with enough orders to mean something; the widest if none.
  let days = BASKET_WINDOWS[BASKET_WINDOWS.length - 1];
  for (const d of BASKET_WINDOWS) {
    if (inWindow(d).length >= BASKET_MIN_ORDERS) { days = d; break; }
  }
  const orders = inWindow(days);
  const n = orders.length;
  if (n === 0) {
    return { window_days: days, orders_analyzed: 0, confident: false };
  }

  // NEVER claim a window wider than the data. Shopify returns only the last 60
  // days of orders unless the app holds read_all_orders, so asking for 180 days
  // can quietly return 60 and the section would print "over 180 days" about two
  // months of data. Report the span actually covered, and flag when the history
  // was cut short so the audit can say what to switch on.
  const oldestMs = Math.min(...orders.map((o) => o.created_ms));
  const spanDays = Math.max(1, Math.ceil((nowMs - oldestMs) / DAY_MS));
  const effectiveDays = Math.min(days, spanDays);
  const shortWindow = days - spanDays > 2;
  // A busy store hits our own 2000-order cap long before Shopify's history cap:
  // Pipeliners came back with 2000 orders spanning 7 days and the report told
  // them to switch on a scope they already had. Only blame the scope when the
  // fetch was NOT capped and the scope is genuinely absent. With no scope
  // reading available, fall back to the old guess rather than asserting either.
  const ordersTruncated = shortWindow && cause.truncated;
  const historyLimited = shortWindow && !cause.truncated
    && (cause.hasAllOrders === null ? true : !cause.hasAllOrders);

  // Add-ons are not products the shopper chose: Simple & Dainty's Shipping
  // Protection rides on 2,715 of 3,477 orders, so it topped every "bought
  // together" pair and made 85% of baskets look multi-item (Hugo, Oct 2). Free
  // gifts ($0 clones) inflate the same numbers. Baskets are measured on the
  // real products only; what was left out is reported alongside.
  const addOnCounts = new Map<string, number>();
  const real = orders.map((o) => {
    const items = o.items.filter((i) => {
      const addOn = isAddOnLine(i);
      if (addOn) addOnCounts.set(i.title, (addOnCounts.get(i.title) ?? 0) + 1);
      return !addOn;
    });
    return { ...o, items, units: items.reduce((s, i) => s + i.units, 0) };
  });
  const withItems = real.filter((o) => o.items.length > 0);
  const singleLine = withItems.filter((o) => o.items.length === 1).length;
  const unitsTotal = withItems.reduce((s, o) => s + o.units, 0);

  // What actually gets bought together. Unordered pairs, counted per order, so
  // buying two of the same thing is not a "pair".
  const pairCounts = new Map<string, { a: string; b: string; orders: number; revenue: number }>();
  for (const o of withItems) {
    const titles = [...new Set(o.items.map((i) => i.title))].sort();
    for (let i = 0; i < titles.length; i++) {
      for (let j = i + 1; j < titles.length; j++) {
        const key = titles[i] + " || " + titles[j];
        const cur = pairCounts.get(key) ?? { a: titles[i], b: titles[j], orders: 0, revenue: 0 };
        cur.orders += 1;
        cur.revenue += o.revenue;
        pairCounts.set(key, cur);
      }
    }
  }
  const pairs = [...pairCounts.values()]
    .filter((p) => p.orders >= MIN_PAIR_ORDERS)
    .sort((a, b) => b.orders - a.orders)
    .slice(0, 5)
    .map((p) => ({ products: [p.a, p.b], orders: p.orders, revenue: round2(p.revenue) }));

  // Revenue concentration, from line items rather than a sample of orders. Each
  // product carries its handle, image and price so the report can render it as a
  // real card linking to the live product page.
  const byProduct = new Map<string, {
    revenue: number; units: number; orders: number;
    handle: string | null; image: string | null; unit_price: number | null; from_price: number | null;
  }>();
  for (const o of withItems) {
    for (const i of o.items) {
      const cur = byProduct.get(i.title) ??
        { revenue: 0, units: 0, orders: 0, handle: null, image: null, unit_price: null, from_price: null };
      cur.revenue += i.revenue;
      cur.units += i.units;
      cur.orders += 1;
      cur.handle = cur.handle ?? i.handle;
      cur.image = cur.image ?? i.image;
      cur.unit_price = cur.unit_price ?? i.unit_price;
      cur.from_price = cur.from_price ?? i.from_price ?? null;
      byProduct.set(i.title, cur);
    }
  }
  const ranked = [...byProduct.entries()]
    .map(([title, v]) => ({
      title,
      revenue: round2(v.revenue),
      units: v.units,
      orders: v.orders,
      handle: v.handle,
      image: v.image,
      unit_price: v.unit_price,
      from_price: v.from_price,
    }))
    .sort((a, b) => b.revenue - a.revenue);
  const totalItemRevenue = ranked.reduce((s, p) => s + p.revenue, 0);
  const topShare = (k: number) =>
    totalItemRevenue > 0 ? round2((ranked.slice(0, k).reduce((s, p) => s + p.revenue, 0) / totalItemRevenue) * 100) : 0;

  const discounted = orders.filter((o) => o.discount > 0);
  const discountDepth = discounted.length > 0
    ? round2((discounted.reduce((s, o) => s + o.discount / Math.max(o.revenue + o.discount, 0.01), 0) / discounted.length) * 100)
    : 0;

  const values = orders.map((o) => o.revenue).sort((a, b) => a - b);

  return {
    window_days: effectiveDays,
    orders_analyzed: n,
    confident: n >= BASKET_MIN_ORDERS,
    // True when Shopify's 60-day order history cap (no read_all_orders scope)
    // stopped us reaching further back than the analysis wanted.
    order_history_limited: historyLimited,
    // True when the window is short because the store is busy enough to fill
    // our page cap, which is a fact about volume, not a missing permission.
    orders_truncated: ordersTruncated,
    units_per_order: withItems.length > 0 ? round2(unitsTotal / withItems.length) : null,
    /** Lines left out of the basket figures (shipping protection, free gifts),
     *  most frequent first, so the report can say what was excluded. */
    excluded_add_ons: [...addOnCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([title, orders]) => ({ title, orders })),
    single_item_order_share: withItems.length > 0 ? round2((singleLine / withItems.length) * 100) : null,
    multi_item_order_share: withItems.length > 0 ? round2(((withItems.length - singleLine) / withItems.length) * 100) : null,
    frequent_pairs: pairs,
    /** Full records for the products named in frequent_pairs.
     *
     *  A pairing play names two products and the report could never show them,
     *  because pair entries carry a title and nothing else while the card needs
     *  a photo, a price and a link. Those products are usually just outside the
     *  top six, so the records already exist here: they were simply never sent.
     *  Kept separate from top_products so the best seller wall is unchanged. */
    pair_products: (() => {
      const wanted = new Set<string>();
      for (const p of pairs) for (const t of p.products) wanted.add(t);
      return ranked.filter((r) => wanted.has(r.title)).slice(0, 12);
    })(),
    distinct_products_sold: ranked.length,
    top_product_revenue_share: topShare(1),
    top3_product_revenue_share: topShare(3),
    // Ranked by REVENUE, which is why the key is no longer called
    // ...by_units: it was, the cards showed only units, and a product with 3
    // units at $200 sat above one with 5 units at $15, which reads as a broken
    // sort. Both figures travel with each product so the card can show the
    // revenue it is ranked on. Old key kept for the snapshots already stored.
    top_products: ranked.slice(0, 6),
    top_products_by_units: ranked.slice(0, 6),
    discounted_order_share: round2((discounted.length / n) * 100),
    avg_discount_depth_pct: discountDepth,
    order_value_percentiles: { p25: percentile(values, 25), p50: percentile(values, 50), p75: percentile(values, 75), p90: percentile(values, 90) },
  };
}

/** Wall clock we are willing to spend waiting for Shopify to finish the job.
 *
 * Measured on a high-volume store: a 180-day read is 150k objects and 53MB, and
 * Shopify took 55s to build it. The 90-day read it replaced took 11s, which is
 * why a 75s ceiling looked generous and then silently was not. The fetch gave up,
 * fell back to the paginated numbers, and put a report back on the truncated
 * 7-day figure it had just been fixed out of.
 *
 * 110s leaves headroom over the measured 55s while still fitting the 150s function
 * budget alongside the other stages, which take about 15s together. It is a
 * ceiling, not a cost: the usual path is 55s of waiting and 2s of ingest. */
const BULK_WAIT_MS = 110_000;
const BULK_POLL_MS = 3_000;

/**
 * Read the whole window with a bulk operation.
 *
 * Only called when the paginated fetch truncated, which is the exact signal that
 * the store is too busy for it: Pipeliner's Cloud filled 8 pages in 7 days, so
 * the report published a quarter of their real month as if it were all of it.
 * Bulk has no page cap, so the window is decided by the window rather than by
 * volume. Returns null on any failure, and the caller keeps the paginated
 * numbers, because degraded data beats a failed audit.
 */
async function bulkOrders(
  shopDomain: string,
  token: string,
  includeCustomer: boolean,
): Promise<{ orders: BulkOrderRow[]; windowDays: number; objectCount: number; fileSize: number } | null> {
  const sinceIso = new Date(Date.now() - BULK_WINDOW_DAYS * DAY_MS).toISOString();
  let operationId: string | null = null;

  // Adopt an operation already in flight rather than colliding with it: only one
  // query operation runs per shop on older API versions, and a previous audit
  // may still be finishing.
  const running = await currentBulk(shopDomain, token).catch(() => null);
  if (running && (running.status === "CREATED" || running.status === "RUNNING")) {
    operationId = running.id;
  } else {
    const started = await startBulkOrders(shopDomain, token, sinceIso, includeCustomer);
    if (!started.ok) return null;
    operationId = started.id;
  }

  const deadline = Date.now() + BULK_WAIT_MS;
  while (Date.now() < deadline) {
    const status = await pollBulk(shopDomain, token, operationId);
    if (status.state === "failed") return null;
    if (status.state === "complete") {
      if (!status.url) return null;
      const ingested = await ingestBulkOrders(status.url);
      if (!ingested.ok) return null;
      return {
        orders: ingested.orders,
        windowDays: BULK_WINDOW_DAYS,
        objectCount: status.objectCount,
        fileSize: status.fileSize,
      };
    }
    await new Promise((r) => setTimeout(r, BULK_POLL_MS));
  }
  return null;
}

async function fetchOrdersRollup(
  shopDomain: string,
  token: string,
  storeUrlBase: string | null,
  /** From the Stage 0 scope probe. null when the probe could not answer. */
  hasAllOrders: boolean | null,
) {
  const nowMs = Date.now();
  const currentSince = new Date(nowMs - PERIOD_DAYS * DAY_MS).toISOString();
  const currentSinceMs = nowMs - PERIOD_DAYS * DAY_MS;
  // Fetch far enough back for the widest basket window. The KPI buckets still
  // only count the last 60 days (anything older simply falls in neither), so
  // widening the fetch changes no headline number; it only gives the basket
  // analysis enough orders to say something true on a low-volume store. The page
  // cap still bounds the work for a busy one.
  const priorSince = new Date(nowMs - BASKET_WINDOWS[BASKET_WINDOWS.length - 1] * DAY_MS).toISOString();
  const priorStartMs = nowMs - 2 * PERIOD_DAYS * DAY_MS;

  // The customer field needs protected-customer-data access. If the app doesn't
  // have it, the whole query 4xxs — so retry once without it (revenue/AOV/orders
  // still work; only returning-customer rate is unavailable).
  let customerDataUnavailable = false;
  // WHY it failed, kept rather than swallowed. This silently nulled the
  // returning-customer rate on every audit and the reason was unknowable from
  // the data, which cost an argument about whether Shopify approval was needed
  // (it is not: custom apps always have protected customer data, levels 1 and 2,
  // per shopify.dev/docs/apps/launch/protected-customer-data). Almost always the
  // real cause is the custom app missing the read_customers access scope, which
  // the merchant can add in one click, so the message has to reach us.
  let customerDataError: string | null = null;
  let agg;
  try {
    agg = await aggregateOrders(shopDomain, token, priorSince, currentSinceMs, true, priorStartMs);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // Only a customer-field failure is fixed by dropping the field. Anything
    // else (throttling, a timeout) used to be mislabelled as missing customer
    // access; now it surfaces as itself.
    if (!isCustomerAccessError(message)) throw e;
    customerDataUnavailable = true;
    customerDataError = message.slice(0, 300);
    agg = await aggregateOrders(shopDomain, token, priorSince, currentSinceMs, false, priorStartMs);
  }
  let { current, previous, channels, currency, truncated, orders } = agg;
  let bulkMeta: { object_count: number; file_size: number; window_days: number } | null = null;

  if (truncated) {
    const bulk = await bulkOrders(shopDomain, token, !customerDataUnavailable);
    if (bulk) {
      // Rebuild every bucket from the full window. Same arithmetic as the
      // paginated pass, just over orders it could never have reached.
      const rebuiltCurrent = emptyPeriod();
      const rebuiltPrevious = emptyPeriod();
      const rebuiltChannels = new Map<string, { revenue: number; orders: number }>();
      for (const o of bulk.orders) {
        const isCurrent = o.created_ms >= currentSinceMs;
        const bucket = isCurrent ? rebuiltCurrent : (o.created_ms >= priorStartMs ? rebuiltPrevious : null);
        if (bucket) {
          bucket.order_count += 1;
          bucket.gross_revenue += o.revenue;
        }
        if (isCurrent) {
          const name = channelLabel(o.channel, o.appName);
          const c = rebuiltChannels.get(name) ?? { revenue: 0, orders: 0 };
          c.revenue += o.revenue;
          c.orders += 1;
          rebuiltChannels.set(name, c);
        }
      }
      current = rebuiltCurrent;
      previous = rebuiltPrevious;
      channels = rebuiltChannels;
      orders = bulk.orders.map((o) => ({
        created_ms: o.created_ms,
        customerId: o.customerId,
        revenue: o.revenue,
        discount: o.discount,
        units: o.units,
        items: o.items,
      }));
      truncated = false;
      bulkMeta = { object_count: bulk.objectCount, file_size: bulk.fileSize, window_days: bulk.windowDays };
    }
  }

  const basket = analyzeBaskets(orders, nowMs, { truncated, hasAllOrders });

  // The fetch stops at ORDERS_MAX_PAGES. A store doing more than that inside the
  // comparison window therefore returns only its most recent slice, and the
  // prior period is never reached at all. Publishing that as "last 30 days"
  // understated Pipeliner's Cloud by roughly 4x in a client-facing report, with
  // an empty baseline beside it. So say what was actually covered, and drop a
  // comparison we cannot make rather than showing zeroes as if they were real.
  const currentSpanDays = truncated && orders.length > 0
    ? Math.max(1, Math.ceil((nowMs - Math.min(...orders.map((o) => o.created_ms))) / DAY_MS))
    : PERIOD_DAYS;
  const comparisonUsable = !truncated && previous.order_count > 0;

  // Repeat purchase, on identical footing for both periods. Runs over every
  // order retained for the window, including the history months that are never
  // reported on their own but are exactly what makes the lookback possible.
  // $0 orders are exchanges and replacements (Happy Returns, staff draft
  // orders), placed for someone who already bought: counted, they read as
  // repeat purchases that nobody paid for.
  const paid = orders.filter((o) => o.revenue > 0);
  // How far back the orders really go: 60 days without read_all_orders, which
  // is too little to judge the prior period on the same lookback.
  const historyDays = paid.length > 0
    ? (nowMs - Math.min(...paid.map((o) => o.created_ms))) / DAY_MS
    : 0;
  const repeatWindow = repeatHistory(historyDays, PERIOD_DAYS);
  const repeat = computeRepeat(paid, currentSinceMs, priorStartMs, repeatWindow.lookbackDays);
  current.returning_orders = repeat.current.returning;
  previous.returning_orders = repeat.previous.returning;

  const cur = summarizePeriod(current);
  const prev = summarizePeriod(previous);
  const curRate = repeatRate(repeat.current);
  const prevRate = repeatRate(repeat.previous);
  // Without customer data we can't compute the returning-customer rate; null it
  // out (rather than reporting a misleading 0%).
  const curReturning = customerDataUnavailable ? null : curRate;
  // Now comparable: both periods are measured with the same fixed lookback over
  // per-order customer identity, so this is a like-for-like trend rather than the
  // artefact the lifetime counter produced.
  // ...but only when the history gave the prior period that same lookback.
  const prevReturning = customerDataUnavailable || !repeatWindow.comparable ? null : prevRate;
  const topProducts = await fetchTopProducts(shopDomain, token, currentSince);
  // Traffic and the checkout funnel, over the same window the order data used so
  // the two halves of the section describe one period. Needs read_analytics; a
  // store without it comes back with an error string and the report says the
  // figures are unavailable rather than inventing them.
  const sessions = await fetchSessions(shopDomain, token, currentSpanDays).catch(() => null);

  return {
    // Two-period comparison for the Data & Analytics section.
    timeframe_key: "30d_vs_prior_30d",
    period_days: currentSpanDays,
    /** True when period_days is the span we could reach, not the 30 asked for. */
    period_truncated: truncated,
    /** How the repeat rate was measured, so the number is never read as something
     * it is not. Both periods use this same lookback. */
    repeat_basis: customerDataUnavailable ? null : {
      lookback_days: repeatWindow.lookbackDays,
      /** False when the order history was too short to give the prior period
       *  the same lookback, so no repeat trend is reported. */
      comparable: repeatWindow.comparable,
      history_days: Math.round(historyDays),
      current_identified_orders: repeat.current.identified,
      previous_identified_orders: repeat.previous.identified,
    },
    /** Present when a bulk operation supplied the orders instead of the paginated
     * fetch, with the size of the read for the record. */
    bulk: bulkMeta,
    current: { ...cur, returning_customer_rate: curReturning },
    previous: comparisonUsable ? { ...prev, returning_customer_rate: prevReturning } : null,
    deltas: !comparisonUsable ? {
      gross_revenue: null,
      order_count: null,
      aov: null,
      returning_customer_rate: null,
    } : {
      gross_revenue: pctDelta(cur.gross_revenue, prev.gross_revenue),
      order_count: pctDelta(cur.order_count, prev.order_count),
      aov: pctDelta(cur.aov, prev.aov),
      // Both rates are nullable: a period with no attributable orders has no rate,
      // and therefore no trend either.
      returning_customer_rate: curReturning != null && prevReturning != null
        ? pctDelta(curReturning, prevReturning)
        : null,
    },
    /** Sessions, conversion rate and the device split. Null when the scope is
     *  missing or the store has no traffic data; the error inside says which. */
    sessions,
    returning_customer_rate_available: !customerDataUnavailable,
    returning_customer_rate_error: customerDataError,
    basket,
    top_products: topProducts.items,
    top_products_note: topProducts.note,
    channels: [...channels.entries()]
      .map(([name, v]) => ({ name, revenue: round2(v.revenue), orders: v.orders }))
      .sort((a, b) => b.revenue - a.revenue),
    currency,
    truncated,
    // The customer-facing domain, so the report can link a product card straight
    // to its live page. Prefer the storefront domain the shopper sees over the
    // myshopify one, which redirects and looks wrong in a client report.
    store_url_base: storeUrlBase,
    // Legacy fields (combined 60-day window) so the existing Store Metrics card keeps working.
    timeframe_days: 2 * PERIOD_DAYS,
    order_count: current.order_count + previous.order_count,
    gross_revenue: round2(current.gross_revenue + previous.gross_revenue),
    aov: cur.aov,
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: { code: "method_not_allowed" } }, { status: 405 });

  const correlationId = crypto.randomUUID();
  try {
    await authorize(req);

    const input = (await req.json()) as { audit_id?: string; client_id?: string };
    const auditId = (input.audit_id ?? "").trim();
    const clientId = (input.client_id ?? "").trim();
    if (!auditId || !clientId) {
      return json({ ok: false, error: { code: "bad_request", message: "Missing audit_id or client_id" }, correlationId }, { status: 400 });
    }

    const sb = assertServiceClient();

    const { data: conn, error: connErr } = await sb
      .from("shopify_connections")
      .select("shop_domain, api_version, auth_method, app_client_id")
      .eq("client_id", clientId)
      .maybeSingle();
    if (connErr) throw connErr;

    const { data: sec, error: secErr } = await sb
      .from("client_secrets")
      .select("shopify_admin_token_ciphertext, shopify_admin_token_iv")
      .eq("client_id", clientId)
      .maybeSingle();
    if (secErr) throw secErr;

    const shopDomain = normalizeShopDomain(conn?.shop_domain ?? "");
    if (!shopDomain || !sec?.shopify_admin_token_ciphertext || !sec?.shopify_admin_token_iv) {
      return json({ ok: true, skipped: "no_connection", correlationId }, { status: 200 });
    }
    const storedSecret = await decryptString(sec.shopify_admin_token_ciphertext, sec.shopify_admin_token_iv);
    // For client_credentials connections the stored secret is the app client
    // secret; exchange it for a fresh short-lived token. Legacy connections
    // stored the admin token directly.
    let token = storedSecret;
    if (conn?.auth_method === "client_credentials") {
      const grant = await exchangeClientCredentials(shopDomain, conn.app_client_id ?? "", storedSecret);
      if (!grant.ok) {
        return json({ ok: false, error: { code: "token_exchange_failed", message: `Shopify token exchange failed (${grant.status}): ${grant.error}`, status: grant.status }, correlationId }, { status: 200 });
      }
      token = grant.token;
    }

    const now = new Date().toISOString();
    const results: Record<string, unknown> = {};
    // null until the probe answers: "unknown" must stay distinguishable from
    // "checked and absent", or a failed probe silently becomes an accusation.
    let hasAllOrders: boolean | null = null;

    // Stage 0: which scopes the client's custom app actually granted us. Without
    // this, a missing scope shows up only as a mysteriously absent metric, and
    // the fix ("tick read_customers in your app's config") is one click for the
    // merchant once somebody knows to ask. Recorded on the connection so any
    // audit can explain what it could not see and why. Best effort.
    try {
      // Not under /admin/api/{version}: access_scopes lives at /admin/oauth/,
      // unversioned, so shopifyRest's versioned prefix 404s here.
      const scopeRes = await fetch(`https://${shopDomain}/admin/oauth/access_scopes.json`, {
        headers: { "X-Shopify-Access-Token": token, "Accept": "application/json" },
      });
      if (scopeRes.ok) {
        const body = await scopeRes.json().catch(() => ({}));
        const granted = ((body?.access_scopes ?? []) as Array<{ handle?: string }>)
          .map((s) => String(s.handle ?? "")).filter(Boolean).sort();
        await sb.from("shopify_connections").update({
          scopes: { granted, checked_at: now },
          updated_at: now,
        }).eq("client_id", clientId);
        results.scopes = granted.length;
        hasAllOrders = granted.includes("read_all_orders");
      }
    } catch { /* non-fatal */ }

    // Stage 1: shop info
    let storeUrlBase: string | null = null;
    const shopRes = await shopifyRest(shopDomain, token, "/shop.json");
    if (shopRes.ok) {
      const shop = shopRes.body?.shop ?? {};
      const publicDomain = String(shop.domain ?? "").trim();
      if (publicDomain) storeUrlBase = `https://${publicDomain.replace(/^https?:\/\//, "").replace(/\/$/, "")}`;
      await sb.from("shopify_data_snapshots").insert({
        audit_id: auditId,
        client_id: clientId,
        snapshot_kind: "shop",
        computed: {
          name: shop.name ?? null,
          currency: shop.currency ?? null,
          timezone: shop.iana_timezone ?? null,
          plan: shop.plan_display_name ?? null,
          domain: shop.domain ?? null,
        },
        raw: shop,
        fetched_at: now,
      });
      results.shop = "ok";
    } else {
      results.shop = `error_${shopRes.status}`;
    }

    // Stage 2: orders rollup (protected data — may fail on scope)
    try {
      const rollup = await fetchOrdersRollup(shopDomain, token, storeUrlBase, hasAllOrders);
      await sb.from("shopify_data_snapshots").insert({
        audit_id: auditId,
        client_id: clientId,
        snapshot_kind: "orders_rollup",
        timeframe_key: rollup.timeframe_key,
        computed: rollup,
        raw: {},
        fetched_at: now,
      });
      if (rollup.aov > 0) {
        await sb.from("audits").update({ aov: rollup.aov }).eq("id", auditId);
      }
      results.orders = "ok";
    } catch (e) {
      results.orders = e instanceof Error ? e.message : "error";
    }

    // Stage 3: products summary
    const productsRes = await shopifyRest(shopDomain, token, "/products.json?limit=50&fields=id,title,handle,status,product_type,vendor,created_at");
    if (productsRes.ok) {
      const products: any[] = productsRes.body?.products ?? [];
      await sb.from("shopify_data_snapshots").insert({
        audit_id: auditId,
        client_id: clientId,
        snapshot_kind: "products",
        computed: {
          sample_count: products.length,
          product_types: [...new Set(products.map((p) => p.product_type).filter(Boolean))].slice(0, 20),
        },
        raw: { products },
        fetched_at: now,
      });
      results.products = "ok";
    } else {
      results.products = `error_${productsRes.status}`;
    }

    await sb.from("shopify_connections").update({ last_verified_at: now, updated_at: now }).eq("client_id", clientId);

    return json({ ok: true, correlationId, results }, { status: 200 });
  } catch (e) {
    return json(
      { ok: false, error: { code: "request_failed", message: e instanceof Error ? e.message : "Unknown error" }, correlationId },
      { status: 200 },
    );
  }
});
