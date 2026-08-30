/* ===============================================================
   ENCLAVE — homepage hydration

   Four independent sections, four independent fetches. Nothing here is
   allowed to be load-bearing: index.html already renders a complete,
   readable page, and each function below either improves one section or
   leaves it exactly as the server sent it.

   That is why every section is settled separately rather than awaited
   together — a Discord outage must not blank the server board.
   =============================================================== */

(function (E) {
    'use strict';

    const { $, html, render, api, safeHref, formatNumber, timeAgo } = E;

    /* ------------------------- live server ------------------------- */

    const STATUS_LABELS = {
        online: 'يعمل الآن',
        full: 'ممتلئ',
        offline: 'متوقف',
        unknown: 'غير معروف'
    };

    /** Why the board is empty, in words a player can act on. */
    const OFFLINE_NOTES = {
        'not-configured': 'لم يتم ربط السيرفر بالموقع بعد.',
        unresolved: 'ما قدرنا نوصل لبيانات السيرفر حالياً. جرّب بعد شوي.',
        unreachable: 'السيرفر مقفل أو تحت الصيانة حالياً. تابع ديسكورد للتحديثات.',
        error: 'صار خطأ أثناء قراءة حالة السيرفر.'
    };

    function paintServer(stats) {
        const players = Number(stats.players) || 0;
        const max = Number(stats.maxPlayers) || 0;

        let state = 'offline';
        if (stats.online) state = (max > 0 && players >= max) ? 'full' : 'online';

        const pill = $('#serverStatus');
        if (pill) pill.setAttribute('data-state', state);
        const label = $('#serverStatusLabel');
        if (label) label.textContent = STATUS_LABELS[state] || STATUS_LABELS.unknown;

        $('#serverPlayers').textContent = stats.online ? formatNumber(players) : '—';
        $('#serverMax').textContent = stats.online && max ? `/ ${formatNumber(max)}` : '';

        const fill = $('#serverSlots');
        if (fill) {
            const ratio = stats.online && max > 0 ? Math.min(players / max, 1) : 0;
            fill.style.inlineSize = `${(ratio * 100).toFixed(1)}%`;
        }

        // The hostname carries FiveM colour codes (^1, ^2 …) which mean
        // nothing outside the game's own renderer, so they are stripped
        // rather than shown as literal text.
        const name = String(stats.hostname || '').replace(/\^\d/g, '').trim();
        if (name) $('#serverName').textContent = name;
        $('#serverGametype').textContent = stats.gametype || '—';
        $('#serverMap').textContent = stats.mapname || '—';

        const note = $('#serverNote');
        if (!note) return;
        note.textContent = stats.online
            ? 'افتح اللعبة واضغط «انضم إلى السيرفر» للدخول مباشرة.'
            : (OFFLINE_NOTES[stats.reason] || OFFLINE_NOTES.unreachable);
    }

    async function loadServer() {
        try {
            paintServer(await api('/api/server'));
        } catch {
            paintServer({ online: false, reason: 'error' });
        }
    }

    /* ---------------------------- news ---------------------------- */

    function newsCard(post) {
        const cover = safeHref(post.coverImage);
        return html`
            <article class="card">
                <a class="news-card-link" href="/news/${encodeURIComponent(post.slug)}">
                    ${cover ? html`
                        <div class="card-media">
                            <img src="${cover}" alt="" loading="lazy">
                        </div>` : null}
                    <div class="card-body">
                        <div class="news-meta">
                            ${post.pinned ? html`<span class="badge badge-accent">مثبّت</span>` : null}
                            ${post.tag ? html`<span class="chip">${post.tag}</span>` : null}
                            <time datetime="${post.publishedAt || ''}">${timeAgo(post.publishedAt)}</time>
                        </div>
                        <h3 class="card-name">${post.title}</h3>
                        <p class="news-excerpt">${post.excerpt}</p>
                    </div>
                </a>
            </article>`;
    }

    async function loadNews() {
        const grid = $('#newsGrid');
        if (!grid) return;
        try {
            const { posts } = await api('/api/news?limit=3');
            // No posts is not a failure — the server-rendered empty state
            // already says the right thing, so leave it alone.
            if (!posts || !posts.length) return;
            render(grid, html`${posts.map(newsCard)}`);
        } catch {
            // Same reasoning: the markup already in the page is a valid
            // "nothing to show" state, and replacing it with an error would
            // be louder than the situation deserves.
        }
    }

    /* ---------------------------- store ---------------------------- */

    function priceLabel(product, currency) {
        if (!currency || !product.price) return null;
        return html`<span class="price">${formatNumber(product.price)} ${currency}</span>`;
    }

    function productCard(product, currency, storeUrl) {
        const image = safeHref(product.image);
        const href = safeHref(storeUrl) || '/store';
        return html`
            <article class="card">
                <a class="news-card-link" href="${href}" target="_blank" rel="noopener">
                    <div class="card-media">
                        ${image
                            ? html`<img src="${image}" alt="" loading="lazy">`
                            : null}
                        ${product.badge
                            ? html`<div class="card-media-tags"><span class="badge badge-accent">${product.badge}</span></div>`
                            : null}
                    </div>
                    <div class="card-body">
                        ${product.brand ? html`<span class="card-brand">${product.brand}</span>` : null}
                        <h3 class="card-name">${product.name}</h3>
                        <div class="card-foot">
                            ${priceLabel(product, currency)}
                            ${product.status ? html`<span class="chip">${product.status}</span>` : null}
                        </div>
                    </div>
                </a>
            </article>`;
    }

    async function loadStore() {
        const grid = $('#storeGrid');
        if (!grid) return;
        try {
            const feed = await api('/api/store/latest');
            if (!feed.products || !feed.products.length) return;
            render(grid, html`
                ${feed.products.map(p => productCard(p, feed.baseCurrency, feed.storeUrl))}`);
        } catch {
            // The "opening soon" state in the markup stands.
        }
    }

    /* --------------------------- discord --------------------------- */

    async function loadDiscord() {
        try {
            const stats = await api('/api/discord');
            if (!stats.available) return;
            $('#discordMembers').textContent = formatNumber(stats.members);
            $('#discordOnline').textContent = formatNumber(stats.online);
        } catch {
            // Dashes stay.
        }
    }

    /* ----------------------------- boot ----------------------------- */

    function init() {
        E.initNav();
        E.initReveal();

        // Settled independently on purpose — see the file header.
        loadServer();
        loadNews();
        loadStore();
        loadDiscord();

        // The board is the one panel worth keeping current while someone
        // reads the page. It matches the server-side cache, so a visitor
        // sitting on the page costs one upstream poll per interval no
        // matter how many of them there are.
        setInterval(loadServer, 30000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})(window.Enclave);
