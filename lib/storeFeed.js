'use strict';

/* ---------------------------------------------------------------
   Newest products from store.enclaverp.cc.

   The store publishes its catalogue at GET /api/store — not /api/products,
   which does not exist. That response carries the whole public view
   (config, categories, products); this module takes the newest few products
   and drops the rest.

   On the closed-shop gate
   -----------------------
   While the store is closed it answers with `storeOpen: false` and an empty
   products array, deliberately: "a scraper should not be able to read the
   whole inventory out of a shop that is showing a construction notice to
   everyone else." Staff signed into the store can preview through it.

   This module calls anonymously and always will. An empty catalogue from a
   closed shop is a real answer to render an empty state from, not an
   obstacle to authenticate around.

   Never throws.
--------------------------------------------------------------- */

const TIMEOUT_MS = 6000;
const TTL_MS = 120 * 1000;
const DEFAULT_LIMIT = 6;

let cache = { payload: null, expiresAt: 0 };
let inFlight = null;

/**
 * Reduce a catalogue entry to what a homepage card renders.
 *
 * The store's own product objects carry a full gallery, a long description
 * and spec tables. None of it is shown here, and forwarding it would make
 * the homepage payload several times larger than the page itself.
 */
function publicProduct(product, categoryNames) {
    return {
        id: String(product?.id ?? ''),
        name: String(product?.name ?? '').slice(0, 120),
        brand: String(product?.brand ?? '').slice(0, 60),
        category: categoryNames.get(product?.categoryId) || '',
        price: Number(product?.price) || 0,
        originalPrice: Number(product?.originalPrice) || 0,
        badge: String(product?.badge ?? '').slice(0, 40),
        status: String(product?.status ?? '').slice(0, 40),
        stock: Number(product?.stock) || 0,
        image: String(product?.mainImage ?? ''),
        createdAt: product?.createdAt ?? null
    };
}

function empty(reason) {
    return {
        available: false,
        reason,
        storeOpen: false,
        baseCurrency: '',
        products: [],
        checkedAt: new Date().toISOString()
    };
}

async function refresh(storeBase, limit) {
    if (!storeBase) return empty('not-configured');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let body;
    try {
        const response = await fetch(`${storeBase.replace(/\/+$/, '')}/api/store`, {
            signal: controller.signal,
            headers: { 'User-Agent': 'EnclaveRP-Home/1.0', Accept: 'application/json' }
        });
        // A closed store answers 503 from Caddy before Node sees the request,
        // which is not an error here — it is the shop being shut.
        if (response.status === 503) return { ...empty('store-closed'), available: true };
        if (!response.ok) return empty('unreachable');
        body = await response.json();
    } catch {
        return empty('unreachable');
    } finally {
        clearTimeout(timer);
    }

    const categoryNames = new Map(
        (Array.isArray(body?.categories) ? body.categories : [])
            .map(category => [category.id, String(category.name ?? '')])
    );

    const products = (Array.isArray(body?.products) ? body.products : [])
        // Newest first. Entries with no createdAt sort last rather than
        // being dropped — a product with a missing timestamp is still real.
        .sort((a, b) => {
            const left = Date.parse(a?.createdAt ?? '') || 0;
            const right = Date.parse(b?.createdAt ?? '') || 0;
            return right - left;
        })
        .slice(0, limit)
        .map(product => publicProduct(product, categoryNames));

    return {
        available: true,
        reason: null,
        storeOpen: body?.storeOpen === true,
        // Passed through rather than assumed. The store owns pricing --
        // base currency, conversion rates, role discounts and coupons all
        // live there -- so the homepage labels the figure with whatever
        // the store says its base is, and shows no figure at all when it
        // does not say. A card that guesses the currency is worse than a
        // card that sends the visitor to the store to find out.
        baseCurrency: String(body?.baseCurrency ?? ''),
        products,
        checkedAt: new Date().toISOString()
    };
}

async function getLatest(storeBase, limit = DEFAULT_LIMIT) {
    if (cache.payload && Date.now() < cache.expiresAt) return cache.payload;
    if (inFlight) return inFlight;

    inFlight = refresh(storeBase, limit)
        .then(payload => {
            cache = { payload, expiresAt: Date.now() + TTL_MS };
            return payload;
        })
        .catch(() => {
            const payload = empty('error');
            cache = { payload, expiresAt: Date.now() + TTL_MS };
            return payload;
        })
        .finally(() => { inFlight = null; });

    return inFlight;
}

function resetCache() {
    cache = { payload: null, expiresAt: 0 };
    inFlight = null;
}

module.exports = { getLatest, publicProduct, resetCache, TTL_MS, DEFAULT_LIMIT };
