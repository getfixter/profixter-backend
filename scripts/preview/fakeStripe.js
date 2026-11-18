/**
 * A stateful, in-memory Stripe client for the local preview. Never talks to
 * Stripe: it is installed in place of the `stripe` npm module, so every
 * `require("stripe")(key)` in the app gets this.
 *
 * Its customers and subscriptions are built from the preview database on first
 * use (users with stripeCustomerId, Subscription records with
 * stripeSubscriptionId), so they always agree with what the Admin shows, and
 * they survive restarts because the app writes every change it makes back to
 * its own records. Invoices and charges are generated from each subscription's
 * dates, so the billing screens have a realistic history.
 *
 * Things that move money are either simulated (a plan change produces a paid
 * proration invoice), or refused outright (refunds: they stay in Stripe, Q-9).
 * Checkout and the billing portal return http://localhost pages that say no
 * payment was taken. Webhooks are refused: nothing can arrive from Stripe here.
 *
 * Anything not modelled answers with a harmless shape and is logged once as
 * "[preview stripe] resource.method (generic)".
 */

const DAY = 86400;

function unix(date) {
  if (!date) return null;
  const t = new Date(date).getTime();
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

function listResult(items) {
  const page = { object: "list", data: items, has_more: false, url: "/v1/preview" };
  const promise = Promise.resolve(page);
  promise[Symbol.asyncIterator] = async function* iterate() {
    for (const item of items) yield item;
  };
  promise.autoPagingToArray = async () => items.slice();
  promise.autoPagingEach = async (fn) => {
    for (const item of items) if ((await fn(item)) === false) break;
  };
  return promise;
}

function stripeError(message, { code = "resource_missing", statusCode = 404, type = "StripeInvalidRequestError" } = {}) {
  const error = new Error(message);
  error.type = type;
  error.rawType = "invalid_request_error";
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function createFakeStripeFactory({ log = console.log, publicBase = "http://localhost:5055", loadData }) {
  const state = {
    loaded: null,
    customers: new Map(),
    subscriptions: new Map(),
    invoices: new Map(),
    charges: new Map(),
    paymentIntents: new Map(),
    sessions: new Map(),
    schedules: new Map(),
    prices: new Map(),
    coupons: new Map(),
    seq: 0,
  };
  const loggedGeneric = new Set();
  const nextId = (prefix) => `${prefix}_preview_${Date.now().toString(36)}${(++state.seq).toString(36)}`;

  function ensureLoaded() {
    if (!state.loaded) {
      state.loaded = Promise.resolve()
        .then(() => loadData())
        .then((data) => ingest(data || {}))
        .catch((error) => {
          log(`[preview stripe] could not build the fake Stripe data: ${error.message}`);
          state.loaded = null;
        });
    }
    return state.loaded;
  }

  function priceObject(id, { amountCents, interval, product, plan, cycle }) {
    return {
      id,
      object: "price",
      active: true,
      currency: "usd",
      unit_amount: amountCents,
      type: "recurring",
      recurring: { interval, interval_count: 1 },
      product,
      lookup_key: plan && cycle ? `${plan}_${cycle}` : null,
      metadata: plan ? { plan, billingCycle: cycle } : {},
      nickname: plan ? `${plan} ${cycle}` : null,
    };
  }

  function ingest({ catalog = {}, customers = [], subscriptions = [], paymentIntents = [] }) {
    for (const [plan, entry] of Object.entries(catalog)) {
      for (const cycle of ["monthly", "annual"]) {
        const c = entry[cycle];
        if (!c?.stripePriceId) continue;
        state.prices.set(
          c.stripePriceId,
          priceObject(c.stripePriceId, {
            amountCents: Math.round(Number(c.price) * 100),
            interval: cycle === "annual" ? "year" : "month",
            product: entry.stripeProductId,
            plan,
            cycle,
          })
        );
      }
    }
    for (const c of customers) {
      state.customers.set(c.id, {
        id: c.id,
        object: "customer",
        email: c.email || null,
        name: c.name || null,
        phone: c.phone || null,
        created: unix(c.createdAt) || unix(new Date()),
        deleted: false,
        metadata: { userId: c.userId || "" },
        invoice_settings: {
          default_payment_method: {
            id: `pm_preview_${c.id.slice(-8)}`,
            object: "payment_method",
            type: "card",
            card: { brand: c.cardBrand || "visa", last4: c.last4 || "4242", exp_month: 12, exp_year: 2029 },
          },
        },
      });
    }
    for (const s of subscriptions) addSubscriptionFromRecord(s);
    for (const pi of paymentIntents) {
      state.paymentIntents.set(pi.id, {
        id: pi.id,
        object: "payment_intent",
        amount: pi.amountCents,
        amount_received: pi.amountCents,
        currency: "usd",
        status: "succeeded",
        customer: pi.customer || null,
        created: unix(pi.at),
        description: pi.description || "Preview payment",
        latest_charge: `ch_${pi.id.slice(3)}`,
        metadata: pi.metadata || {},
      });
    }
  }

  function addSubscriptionFromRecord(s) {
    const price = state.prices.get(s.priceId) || priceObject(s.priceId || "price_preview_unknown", { amountCents: 0, interval: "month" });
    const status = s.status;
    const sub = {
      id: s.id,
      object: "subscription",
      customer: s.customer,
      status,
      created: unix(s.startDate),
      start_date: unix(s.startDate),
      current_period_start: unix(s.currentPeriodStart),
      current_period_end: unix(s.currentPeriodEnd),
      cancel_at: s.cancelAt ? unix(s.cancelAt) : null,
      cancel_at_period_end: Boolean(s.cancelAtPeriodEnd),
      canceled_at: ["canceled", "incomplete_expired"].includes(status) ? unix(s.endedAt || s.currentPeriodEnd) : null,
      ended_at: ["canceled", "incomplete_expired"].includes(status) ? unix(s.endedAt || s.currentPeriodEnd) : null,
      trial_start: unix(s.trialStart),
      trial_end: unix(s.trialEnd),
      latest_invoice: null,
      schedule: null,
      discount: null,
      discounts: [],
      collection_method: "charge_automatically",
      currency: "usd",
      default_payment_method: null,
      items: {
        object: "list",
        data: [{ id: s.itemId || `si_${s.id.slice(4)}`, object: "subscription_item", price, quantity: 1, subscription: s.id }],
      },
      metadata: { ...(s.metadata || {}) },
    };
    state.subscriptions.set(sub.id, sub);
    buildInvoiceHistory(sub, s);
  }

  /** One invoice per billing period from the start until now; the last one follows the status. */
  function buildInvoiceHistory(sub, record) {
    const price = sub.items.data[0].price;
    const amount = Number(price.unit_amount || 0);
    const yearly = price.recurring?.interval === "year";
    const start = new Date(record.startDate || Date.now());
    const until = new Date(Math.min(Date.now(), new Date(record.currentPeriodStart || Date.now()).getTime()));
    const periods = [];
    const cursor = new Date(start);
    let guard = 0;
    while (cursor.getTime() <= until.getTime() + 1000 && guard++ < 40) {
      const periodStart = new Date(cursor);
      if (yearly) cursor.setUTCFullYear(cursor.getUTCFullYear() + 1);
      else cursor.setUTCMonth(cursor.getUTCMonth() + 1);
      periods.push({ start: periodStart, end: new Date(cursor) });
    }
    if (!periods.length) periods.push({ start, end: new Date(record.currentPeriodEnd || Date.now()) });
    periods.forEach((period, index) => {
      const last = index === periods.length - 1;
      const failing = last && ["past_due", "unpaid", "incomplete"].includes(sub.status);
      const trialFree = index === 0 && record.trialStart;
      const id = `in_${sub.id.slice(4)}_${String(index + 1).padStart(2, "0")}`;
      const total = trialFree ? 0 : amount;
      const invoice = {
        id,
        object: "invoice",
        number: `PREV-${sub.id.replace(/\D/g, "").padStart(4, "0")}-${String(index + 1).padStart(4, "0")}`,
        customer: sub.customer,
        subscription: sub.id,
        status: failing ? "open" : "paid",
        billing_reason: index === 0 ? "subscription_create" : "subscription_cycle",
        currency: "usd",
        total,
        subtotal: total,
        tax: 0,
        amount_due: total,
        amount_paid: failing ? 0 : total,
        amount_remaining: failing ? total : 0,
        attempt_count: failing ? 3 : 1,
        attempted: true,
        paid: !failing,
        next_payment_attempt: failing ? unix(new Date(Date.now() + 2 * DAY * 1000)) : null,
        created: unix(period.start),
        period_start: unix(period.start),
        period_end: unix(period.end),
        hosted_invoice_url: null,
        invoice_pdf: null,
        payment_intent: failing ? null : `pi_${id.slice(3)}`,
        charge: failing ? null : `ch_${id.slice(3)}`,
        lines: {
          object: "list",
          data: [{ id: `il_${id.slice(3)}`, amount: total, description: `1 x ${price.nickname || "Membership"}`, period: { start: unix(period.start), end: unix(period.end) }, price }],
        },
        metadata: {},
      };
      state.invoices.set(id, invoice);
      sub.latest_invoice = id;
      if (!failing && total > 0) {
        state.charges.set(invoice.charge, chargeFor(invoice));
      }
      if (failing) {
        state.charges.set(`ch_${id.slice(3)}_failed`, { ...chargeFor(invoice), id: `ch_${id.slice(3)}_failed`, status: "failed", paid: false, failure_code: "card_declined", failure_message: "Your card was declined. (preview)" });
      }
    });
  }

  function chargeFor(invoice) {
    return {
      id: invoice.charge || `ch_${invoice.id.slice(3)}`,
      object: "charge",
      amount: invoice.total,
      amount_refunded: 0,
      refunded: false,
      currency: "usd",
      status: "succeeded",
      paid: true,
      captured: true,
      customer: invoice.customer,
      invoice: invoice.id,
      payment_intent: invoice.payment_intent,
      created: invoice.created,
      description: "Profixter membership (preview)",
      failure_code: null,
      failure_message: null,
      payment_method_details: { type: "card", card: { brand: "visa", last4: "4242" } },
      billing_details: {},
      metadata: {},
    };
  }

  const byCustomer = (map, customer) => [...map.values()].filter((x) => !customer || x.customer === customer);
  const newest = (a, b) => Number(b.created || 0) - Number(a.created || 0);
  const clone = (value) => JSON.parse(JSON.stringify(value));

  function prorationPreview(sub, newPriceId, now = Date.now()) {
    const item = sub.items.data[0];
    const oldPrice = item.price;
    const newPrice = state.prices.get(newPriceId) || oldPrice;
    const start = Number(sub.current_period_start || unix(now)) * 1000;
    const end = Number(sub.current_period_end || unix(now + 30 * DAY * 1000)) * 1000;
    const fraction = Math.max(0, Math.min(1, (end - now) / Math.max(1, end - start)));
    const cycleChanges = oldPrice.recurring?.interval !== newPrice.recurring?.interval;
    const credit = -Math.round(Number(oldPrice.unit_amount || 0) * fraction);
    const charge = cycleChanges ? Number(newPrice.unit_amount || 0) : Math.round(Number(newPrice.unit_amount || 0) * fraction);
    const newEnd = cycleChanges ? unix(new Date(now).setUTCFullYear(new Date(now).getUTCFullYear() + (newPrice.recurring?.interval === "year" ? 1 : 0)) + (newPrice.recurring?.interval === "month" ? 30 * DAY * 1000 : 0)) : unix(end);
    const lines = [
      { id: nextId("il"), amount: credit, description: `Unused time on ${oldPrice.nickname || "current plan"}`, period: { start: unix(now), end: unix(end) }, proration: true, price: oldPrice },
      { id: nextId("il"), amount: charge, description: `Remaining time on ${newPrice.nickname || "new plan"}`, period: { start: unix(now), end: newEnd }, proration: true, price: newPrice },
    ];
    const total = credit + charge;
    return {
      object: "invoice",
      customer: sub.customer,
      subscription: sub.id,
      currency: "usd",
      status: "draft",
      total,
      subtotal: total,
      tax: 0,
      amount_due: Math.max(0, total),
      amount_paid: 0,
      amount_remaining: Math.max(0, total),
      period_start: unix(now),
      period_end: newEnd,
      next_payment_attempt: unix(now),
      lines: { object: "list", data: lines },
    };
  }

  function applySubscriptionUpdate(sub, params = {}) {
    const now = Date.now();
    if (Array.isArray(params.items) && params.items.length) {
      const change = params.items[0];
      const newPrice = state.prices.get(change.price);
      if (newPrice) {
        if (params.proration_behavior === "always_invoice") {
          const preview = prorationPreview(sub, change.price, now);
          const id = nextId("in");
          const invoice = {
            ...preview,
            id,
            object: "invoice",
            number: `PREV-${id.slice(-6).toUpperCase()}`,
            status: "paid",
            amount_paid: preview.amount_due,
            amount_remaining: 0,
            paid: true,
            attempt_count: 1,
            billing_reason: "subscription_update",
            created: unix(now),
            payment_intent: preview.amount_due > 0 ? `pi_${id.slice(3)}` : null,
            charge: preview.amount_due > 0 ? `ch_${id.slice(3)}` : null,
          };
          state.invoices.set(id, invoice);
          if (invoice.charge) state.charges.set(invoice.charge, chargeFor(invoice));
          sub.latest_invoice = id;
          if (preview.period_end && preview.period_end !== sub.current_period_end) {
            sub.current_period_start = unix(now);
            sub.current_period_end = preview.period_end;
          }
          log(`[preview stripe] simulated proration charge of $${(preview.amount_due / 100).toFixed(2)} (no card was charged)`);
        }
        sub.items.data[0] = { ...sub.items.data[0], price: newPrice };
      }
    }
    if (Object.prototype.hasOwnProperty.call(params, "cancel_at")) {
      sub.cancel_at = params.cancel_at === "" || params.cancel_at == null ? null : Number(params.cancel_at);
      if (sub.cancel_at) sub.cancel_at_period_end = false;
    }
    if (Object.prototype.hasOwnProperty.call(params, "cancel_at_period_end")) {
      sub.cancel_at_period_end = Boolean(params.cancel_at_period_end);
      if (sub.cancel_at_period_end) sub.cancel_at = sub.current_period_end;
      else if (!Object.prototype.hasOwnProperty.call(params, "cancel_at")) sub.cancel_at = null;
    }
    if (params.metadata && typeof params.metadata === "object") sub.metadata = { ...sub.metadata, ...params.metadata };
    if (Object.prototype.hasOwnProperty.call(params, "discounts") || Object.prototype.hasOwnProperty.call(params, "coupon")) {
      const coupon = params.coupon || params.discounts?.[0]?.coupon || null;
      sub.discount = coupon ? { id: nextId("di"), coupon: state.coupons.get(coupon) || { id: coupon, percent_off: 20, duration: "once" } } : null;
      sub.discounts = sub.discount ? [sub.discount.id] : [];
    }
    return sub;
  }

  function checkoutUrl(id) {
    return `${publicBase}/__preview/checkout/${id}`;
  }

  /* ---------------------------------------------------------------- resources */

  const resources = {
    customers: {
      async retrieve(id) {
        await ensureLoaded();
        const c = state.customers.get(String(id));
        if (!c) throw stripeError(`No such customer: '${id}' (preview)`);
        return clone(c);
      },
      async list(params = {}) {
        await ensureLoaded();
        let items = [...state.customers.values()];
        if (params.email) items = items.filter((c) => String(c.email || "").toLowerCase() === String(params.email).toLowerCase());
        return listResult(items.map(clone));
      },
      async search(params = {}) {
        await ensureLoaded();
        const email = (String(params.query || "").match(/email:['"]([^'"]+)['"]/) || [])[1];
        const items = [...state.customers.values()].filter((c) => !email || String(c.email || "").toLowerCase() === email.toLowerCase());
        return { object: "search_result", data: items.map(clone), has_more: false };
      },
      async create(params = {}) {
        await ensureLoaded();
        const id = nextId("cus");
        const c = { id, object: "customer", email: params.email || null, name: params.name || null, phone: params.phone || null, created: unix(new Date()), deleted: false, metadata: params.metadata || {}, invoice_settings: { default_payment_method: null } };
        state.customers.set(id, c);
        return clone(c);
      },
      async update(id, params = {}) {
        await ensureLoaded();
        const c = state.customers.get(String(id));
        if (!c) throw stripeError(`No such customer: '${id}' (preview)`);
        Object.assign(c, { ...params, metadata: { ...c.metadata, ...(params.metadata || {}) } });
        return clone(c);
      },
    },

    subscriptions: {
      async retrieve(id) {
        await ensureLoaded();
        const s = state.subscriptions.get(String(id));
        if (!s) throw stripeError(`No such subscription: '${id}' (preview)`);
        return clone(s);
      },
      list(params = {}) {
        const run = async () => {
          await ensureLoaded();
          let items = byCustomer(state.subscriptions, params.customer);
          const status = params.status || "active";
          if (status === "all") {
            // everything
          } else if (status === "ended") {
            items = items.filter((s) => ["canceled", "incomplete_expired"].includes(s.status));
          } else {
            items = items.filter((s) => s.status === status);
          }
          if (params.price) items = items.filter((s) => s.items.data.some((i) => i.price.id === params.price));
          return items.sort(newest).map(clone);
        };
        const pending = run();
        const wrapper = pending.then((items) => listResult(items));
        wrapper[Symbol.asyncIterator] = async function* iterate() {
          for (const item of await pending) yield item;
        };
        wrapper.autoPagingToArray = async () => pending;
        wrapper.autoPagingEach = async (fn) => {
          for (const item of await pending) if ((await fn(item)) === false) break;
        };
        return wrapper;
      },
      async update(id, params = {}) {
        await ensureLoaded();
        const s = state.subscriptions.get(String(id));
        if (!s) throw stripeError(`No such subscription: '${id}' (preview)`);
        applySubscriptionUpdate(s, params);
        log(`[preview stripe] subscriptions.update ${id} (${Object.keys(params).filter((k) => k !== "expand").join(", ")})`);
        return clone(s);
      },
      async cancel(id) {
        await ensureLoaded();
        const s = state.subscriptions.get(String(id));
        if (!s) throw stripeError(`No such subscription: '${id}' (preview)`);
        s.status = "canceled";
        s.canceled_at = unix(new Date());
        s.ended_at = s.canceled_at;
        log(`[preview stripe] subscriptions.cancel ${id}`);
        return clone(s);
      },
      async create(params = {}) {
        await ensureLoaded();
        const id = nextId("sub");
        const now = new Date();
        const end = new Date(now);
        end.setUTCMonth(end.getUTCMonth() + 1);
        addSubscriptionFromRecord({ id, customer: params.customer, status: "active", priceId: params.items?.[0]?.price, startDate: now, currentPeriodStart: now, currentPeriodEnd: end, metadata: params.metadata });
        return clone(state.subscriptions.get(id));
      },
    },

    subscriptionSchedules: {
      async create(params = {}) {
        const id = nextId("sub_sched");
        const schedule = { id, object: "subscription_schedule", subscription: params.from_subscription || null, status: "active", phases: params.phases || [], metadata: params.metadata || {} };
        state.schedules.set(id, schedule);
        const sub = state.subscriptions.get(String(params.from_subscription || ""));
        if (sub) sub.schedule = id;
        return clone(schedule);
      },
      async retrieve(id) {
        const schedule = state.schedules.get(String(id));
        if (!schedule) throw stripeError(`No such subscription schedule: '${id}' (preview)`);
        return clone(schedule);
      },
      async update(id, params = {}) {
        const schedule = state.schedules.get(String(id)) || { id, object: "subscription_schedule", phases: [] };
        Object.assign(schedule, params);
        state.schedules.set(String(id), schedule);
        return clone(schedule);
      },
      async release(id) {
        const schedule = state.schedules.get(String(id)) || { id, object: "subscription_schedule" };
        schedule.status = "released";
        for (const sub of state.subscriptions.values()) if (sub.schedule === id) sub.schedule = null;
        return clone(schedule);
      },
      async cancel(id) {
        return resources.subscriptionSchedules.release(id);
      },
    },

    prices: {
      async retrieve(id) {
        await ensureLoaded();
        const p = state.prices.get(String(id));
        if (!p) throw stripeError(`No such price: '${id}' (preview)`);
        return clone(p);
      },
      async list(params = {}) {
        await ensureLoaded();
        let items = [...state.prices.values()];
        if (params.product) items = items.filter((p) => p.product === params.product);
        if (Array.isArray(params.lookup_keys)) items = items.filter((p) => params.lookup_keys.includes(p.lookup_key));
        return listResult(items.map(clone));
      },
      async create(params = {}) {
        const id = nextId("price");
        const p = { id, object: "price", active: true, currency: params.currency || "usd", unit_amount: params.unit_amount, recurring: params.recurring || null, product: params.product || params.product_data?.name || null, metadata: params.metadata || {} };
        state.prices.set(id, p);
        return clone(p);
      },
    },

    products: {
      async retrieve(id) {
        return { id, object: "product", name: "Profixter membership (preview)", active: true, metadata: {} };
      },
    },

    invoices: {
      async retrieve(id) {
        await ensureLoaded();
        const inv = state.invoices.get(String(id));
        if (!inv) throw stripeError(`No such invoice: '${id}' (preview)`);
        return clone(inv);
      },
      async list(params = {}) {
        await ensureLoaded();
        let items = byCustomer(state.invoices, params.customer);
        if (params.subscription) items = items.filter((i) => i.subscription === params.subscription);
        if (params.status) items = items.filter((i) => i.status === params.status);
        items = items.sort(newest).slice(0, Number(params.limit || 100));
        return listResult(items.map(clone));
      },
      async createPreview(params = {}) {
        await ensureLoaded();
        if (params.subscription && params.subscription_details?.items?.length) {
          const sub = state.subscriptions.get(String(params.subscription));
          if (!sub) throw stripeError(`No such subscription: '${params.subscription}' (preview)`);
          return prorationPreview(sub, params.subscription_details.items[0].price, params.subscription_details.proration_date ? params.subscription_details.proration_date * 1000 : Date.now());
        }
        const subs = byCustomer(state.subscriptions, params.customer).filter((s) => ["active", "trialing", "past_due"].includes(s.status) && !(s.cancel_at && s.cancel_at <= s.current_period_end));
        const sub = params.subscription ? state.subscriptions.get(String(params.subscription)) : subs[0];
        if (!sub) throw stripeError("No upcoming invoices for customer (preview)", { code: "invoice_upcoming_none" });
        const price = sub.items.data[0].price;
        return {
          object: "invoice",
          customer: sub.customer,
          subscription: sub.id,
          currency: "usd",
          total: price.unit_amount,
          subtotal: price.unit_amount,
          tax: 0,
          amount_due: price.unit_amount,
          period_start: sub.current_period_start,
          period_end: sub.current_period_end,
          next_payment_attempt: sub.current_period_end,
          lines: { object: "list", data: [{ amount: price.unit_amount, description: `1 x ${price.nickname || "Membership"}`, period: { start: sub.current_period_end, end: sub.current_period_end + 30 * DAY }, price }] },
        };
      },
      async retrieveUpcoming(params = {}) {
        return resources.invoices.createPreview(params);
      },
      async create(params = {}) {
        const id = nextId("in");
        const inv = { id, object: "invoice", customer: params.customer || null, status: "draft", total: 0, amount_due: 0, amount_paid: 0, amount_remaining: 0, currency: "usd", created: unix(new Date()), metadata: params.metadata || {}, lines: { object: "list", data: [] } };
        state.invoices.set(id, inv);
        return clone(inv);
      },
      async finalizeInvoice(id) {
        const inv = state.invoices.get(String(id));
        if (inv) {
          inv.status = "open";
          inv.hosted_invoice_url = `${publicBase}/__preview/invoice/${id}`;
        }
        return clone(inv || { id, status: "open" });
      },
      async sendInvoice(id) {
        return resources.invoices.finalizeInvoice(id);
      },
      async voidInvoice(id) {
        const inv = state.invoices.get(String(id));
        if (inv) inv.status = "void";
        return clone(inv || { id, status: "void" });
      },
      async del(id) {
        state.invoices.delete(String(id));
        return { id, object: "invoice", deleted: true };
      },
      async pay() {
        throw stripeError("Collecting an invoice is disabled in the preview.", { code: "preview_disabled", statusCode: 400 });
      },
    },

    invoiceItems: {
      async create(params = {}) {
        const id = nextId("ii");
        const inv = state.invoices.get(String(params.invoice || ""));
        const amount = Number(params.amount || params.unit_amount || 0) * Number(params.quantity || 1);
        if (inv) {
          inv.lines.data.push({ id, amount, description: params.description || "" });
          inv.total = inv.amount_due = inv.amount_remaining = inv.lines.data.reduce((s, l) => s + Number(l.amount || 0), 0);
        }
        return { id, object: "invoiceitem", amount, description: params.description || "" };
      },
    },

    charges: {
      async list(params = {}) {
        await ensureLoaded();
        const items = byCustomer(state.charges, params.customer).sort(newest).slice(0, Number(params.limit || 100));
        return listResult(items.map(clone));
      },
      async retrieve(id) {
        await ensureLoaded();
        const ch = state.charges.get(String(id));
        if (!ch) throw stripeError(`No such charge: '${id}' (preview)`);
        return clone(ch);
      },
    },

    paymentIntents: {
      async retrieve(id) {
        await ensureLoaded();
        const pi = state.paymentIntents.get(String(id));
        if (pi) return clone(pi);
        const inv = [...state.invoices.values()].find((i) => i.payment_intent === id);
        return { id, object: "payment_intent", status: inv ? "succeeded" : "requires_payment_method", amount: inv ? inv.total : 0, currency: "usd", customer: inv?.customer || null, invoice: inv?.id || null, metadata: {} };
      },
      async list(params = {}) {
        await ensureLoaded();
        return listResult(byCustomer(state.paymentIntents, params.customer).map(clone));
      },
      async create() {
        throw stripeError("Creating payments is disabled in the preview.", { code: "preview_disabled", statusCode: 400 });
      },
    },

    checkout: {
      sessions: {
        async create(params = {}) {
          const id = nextId("cs_test");
          const amount = (params.line_items || []).reduce((sum, line) => {
            const price = state.prices.get(String(line.price || ""));
            const unitAmount = line.price_data?.unit_amount ?? price?.unit_amount ?? 0;
            return sum + Number(unitAmount) * Number(line.quantity || 1);
          }, 0);
          const session = {
            id,
            object: "checkout.session",
            url: checkoutUrl(id),
            status: "open",
            payment_status: "unpaid",
            mode: params.mode || "payment",
            customer: params.customer || null,
            customer_email: params.customer_email || null,
            client_reference_id: params.client_reference_id || null,
            amount_total: amount,
            currency: "usd",
            metadata: params.metadata || {},
            success_url: params.success_url || null,
            cancel_url: params.cancel_url || null,
            expires_at: params.expires_at || unix(new Date(Date.now() + 24 * 3600 * 1000)),
            created: unix(new Date()),
            payment_intent: null,
            subscription: null,
            line_items: params.line_items || [],
          };
          state.sessions.set(id, session);
          log(`[preview stripe] checkout.sessions.create -> ${session.url} (mode ${session.mode}, $${(amount / 100).toFixed(2)}; nothing can be paid)`);
          return clone(session);
        },
        async retrieve(id) {
          const s = state.sessions.get(String(id));
          if (!s) throw stripeError(`No such checkout.session: '${id}' (preview)`);
          return clone(s);
        },
        async expire(id) {
          const s = state.sessions.get(String(id));
          if (!s) throw stripeError(`No such checkout.session: '${id}' (preview)`);
          s.status = "expired";
          return clone(s);
        },
        async list(params = {}) {
          let items = [...state.sessions.values()];
          if (params.payment_intent) items = items.filter((s) => s.payment_intent === params.payment_intent);
          return listResult(items.map(clone));
        },
        async listLineItems(id) {
          const s = state.sessions.get(String(id));
          return listResult((s?.line_items || []).map((line, index) => ({ id: `li_${index}`, object: "item", quantity: line.quantity || 1, price: state.prices.get(String(line.price || "")) || null, amount_total: s.amount_total })));
        },
      },
    },

    billingPortal: {
      sessions: {
        async create(params = {}) {
          const id = nextId("bps");
          return { id, object: "billing_portal.session", url: `${publicBase}/__preview/portal/${id}`, customer: params.customer || null, return_url: params.return_url || null };
        },
      },
      configurations: {
        async list() {
          return listResult([]);
        },
        async create(params = {}) {
          return { id: nextId("bpc"), object: "billing_portal.configuration", ...params };
        },
        async update(id, params = {}) {
          return { id, object: "billing_portal.configuration", ...params };
        },
        async retrieve(id) {
          return { id, object: "billing_portal.configuration", features: {} };
        },
      },
    },

    coupons: {
      async retrieve(id) {
        const c = state.coupons.get(String(id));
        if (c) return clone(c);
        return { id, object: "coupon", valid: true, percent_off: 20, duration: "once", name: `${id} (preview)` };
      },
      async create(params = {}) {
        const id = params.id || nextId("coupon");
        const c = { id, object: "coupon", valid: true, ...params };
        state.coupons.set(id, c);
        return clone(c);
      },
    },

    promotionCodes: {
      async list(params = {}) {
        return listResult([]);
      },
      async create(params = {}) {
        return { id: nextId("promo"), object: "promotion_code", active: true, code: params.code || "PREVIEW", coupon: { id: params.coupon || "coupon_preview" } };
      },
      async update(id, params = {}) {
        return { id, object: "promotion_code", ...params };
      },
    },

    refunds: {
      async create() {
        throw stripeError("Refunds are made in Stripe, never from the Admin (and never in the preview).", { code: "preview_refunds_refused", statusCode: 400 });
      },
      async list() {
        return listResult([]);
      },
    },

    webhooks: {
      constructEvent() {
        throw stripeError("Stripe webhooks are disabled in the preview: nothing can arrive from Stripe.", { code: "preview_webhooks_disabled", statusCode: 400, type: "StripeSignatureVerificationError" });
      },
      generateTestHeaderString() {
        return "t=0,v1=preview";
      },
    },
  };

  function genericResource(name, path = name) {
    return new Proxy(
      {},
      {
        get(target, method) {
          if (typeof method !== "string" || method === "then") return undefined;
          if (!target[method]) {
            target[method] = (...args) => {
              const key = `${path}.${method}`;
              if (!loggedGeneric.has(key)) {
                loggedGeneric.add(key);
                log(`[preview stripe] ${key} (generic fake answer)`);
              }
              if (/^list/.test(method) || method === "search") return listResult([]);
              if (method === "del") return Promise.resolve({ id: args[0], deleted: true });
              if (method === "retrieve") return Promise.resolve({ id: args[0], object: name, preview: true });
              if (/^(create|update)/.test(method)) {
                const params = (method === "update" ? args[1] : args[0]) || {};
                return Promise.resolve({ id: method === "update" ? args[0] : nextId(name.slice(0, 6)), object: name, ...params, preview: true });
              }
              return Promise.resolve({ object: name, preview: true });
            };
          }
          return target[method];
        },
      }
    );
  }

  function wrapResource(name, resource) {
    return new Proxy(resource, {
      get(target, prop) {
        if (prop in target) return target[prop];
        if (typeof prop !== "string" || prop === "then") return undefined;
        target[prop] = genericResource(prop, `${name}.${prop}`);
        return target[prop];
      },
    });
  }

  function makeClient() {
    const base = {};
    for (const [name, resource] of Object.entries(resources)) base[name] = wrapResource(name, resource);
    base._preview = { state, ensureLoaded };
    base.setApiVersion = () => {};
    base.setMaxNetworkRetries = () => {};
    base.on = () => {};
    base.off = () => {};
    return new Proxy(base, {
      get(target, prop) {
        if (prop in target) return target[prop];
        if (typeof prop !== "string" || prop === "then") return undefined;
        target[prop] = wrapResource(prop, {});
        return target[prop];
      },
    });
  }

  let client = null;
  function StripeFactory() {
    if (!client) client = makeClient();
    return client;
  }
  StripeFactory.Stripe = StripeFactory;
  StripeFactory.default = StripeFactory;
  StripeFactory.errors = {
    StripeError: Error,
    StripeCardError: Error,
    StripeInvalidRequestError: Error,
    StripeSignatureVerificationError: Error,
  };
  StripeFactory.webhooks = resources.webhooks;
  StripeFactory.createFetchHttpClient = () => ({});
  StripeFactory.createNodeHttpClient = () => ({});
  StripeFactory._preview = { state, ensureLoaded, resources };
  return StripeFactory;
}

module.exports = { createFakeStripeFactory, listResult };
