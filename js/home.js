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

    const DETAIL_LABELS = {
        gametype: 'النمط',
        mapname: 'الخريطة',
        projectName: 'اسم المشروع',
        projectDesc: 'الوصف',
        tags: 'الوسوم',
        locale: 'اللغة',
        enforceGameBuild: 'إصدار اللعبة',
        onesync: 'OneSync',
        resourceCount: 'عدد الموارد',
        serverVersion: 'إصدار السيرفر',
        upvotes: 'التصويتات'
    };

    /* ------------------------- live server ------------------------- */

    const STATUS_LABELS = {
        online: 'يعمل الآن',
        full: 'ممتلئ',
        offline: 'متوقف',
        unknown: 'غير معروف'
    };

    /**
     * GTA V's world coordinates, approximately -- not to scale, just enough
     * to place a dot roughly where a player is relative to the others. The
     * mini-map is deliberately an abstract radar rather than the game's own
     * map art (no licensed source for that), so exactness doesn't matter.
     */
    const MAP_BOUNDS = { minX: -4500, maxX: 4500, minY: -4500, maxY: 8000 };
    const MAP_VIEW_W = 100;
    const MAP_VIEW_H = 139; // matches the index.html viewBox's aspect ratio

    // The radar panel (css/home.css .player-map-radar) clips to a rounded
    // rect. A dot plotted right at 0/100 on either axis -- which is exactly
    // where a clamped out-of-bounds position lands -- sits inside that
    // rounded corner and gets clipped away entirely, silently. Keeping the
    // plotted range 5% inset from every edge keeps every dot, including a
    // clamped one, clear of the corners regardless of how round they are.
    const MAP_MARGIN = 0.05;

    /** A world position -> a point inside the radar's viewBox, clamped. */
    function mapPoint(pos) {
        const x = Math.min(Math.max(Number(pos.x) || 0, MAP_BOUNDS.minX), MAP_BOUNDS.maxX);
        const y = Math.min(Math.max(Number(pos.y) || 0, MAP_BOUNDS.minY), MAP_BOUNDS.maxY);
        const nx = (x - MAP_BOUNDS.minX) / (MAP_BOUNDS.maxX - MAP_BOUNDS.minX);
        // North (larger in-game y) should read as "up", i.e. a smaller SVG y.
        const ny = 1 - (y - MAP_BOUNDS.minY) / (MAP_BOUNDS.maxY - MAP_BOUNDS.minY);
        const cx = (MAP_MARGIN + nx * (1 - 2 * MAP_MARGIN)) * MAP_VIEW_W;
        const cy = (MAP_MARGIN + ny * (1 - 2 * MAP_MARGIN)) * MAP_VIEW_H;
        return { cx: cx.toFixed(1), cy: cy.toFixed(1) };
    }

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
        if (note) {
            note.textContent = stats.online
                ? 'افتح اللعبة واضغط «انضم إلى السيرفر» للدخول مباشرة.'
                : (OFFLINE_NOTES[stats.reason] || OFFLINE_NOTES.unreachable);
        }

        paintDetails(stats);
    }

    /**
     * The "show more" panel.
     *
     * Both the button and the panel stay hidden unless there is something to
     * put in them — an admin can select fields the server does not report,
     * and a panel of empty rows reads as broken rather than as "not
     * configured".
     */
    function paintDetails(stats) {
        const button = $('#serverMoreBtn');
        const panel = $('#serverMore');
        if (!button || !panel) return;

        const details = stats.details || {};
        const rows = Object.keys(DETAIL_LABELS)
            .filter(key => details[key] !== undefined && details[key] !== '')
            .map(key => html`
                <div>
                    <dt>${DETAIL_LABELS[key]}</dt>
                    <dd>${String(details[key])}</dd>
                </div>`);

        render('#serverDetails', html`${rows}`);

        // Names only. Identifiers never leave the server (lib/fivem.js), so
        // there is nothing here to strip a second time.
        const players = Array.isArray(stats.playerList) ? stats.playerList : [];
        const list = $('#serverPlayerList');
        if (players.length) {
            render(list, html`${players.map(player => html`
                <span class="player">${player.name}</span>`)}`);
            list.hidden = false;
        } else {
            list.hidden = true;
        }

        const hasMap = paintPlayerMap(stats);

        const hasContent = rows.length > 0 || players.length > 0 || hasMap;
        button.hidden = !hasContent;
        if (!hasContent) {
            panel.hidden = true;
            button.setAttribute('aria-expanded', 'false');
        }
    }

    /**
     * Positions only, from the enclave-positions FiveM resource -- no
     * names, no ids (see lib/fivem.js's publicPosition() for why). Returns
     * whether there was anything to plot, so paintDetails() can fold it
     * into whether the "show more" button has a reason to exist.
     */
    function paintPlayerMap(stats) {
        const wrap = $('#serverPlayerMap');
        if (!wrap) return false;

        const positions = Array.isArray(stats.playerMap) ? stats.playerMap : [];
        if (!positions.length) {
            wrap.hidden = true;
            return false;
        }

        render('#playerMapDots', html`${positions.map(pos => {
            const { cx, cy } = mapPoint(pos);
            return html`<circle class="player-map-dot" cx="${cx}" cy="${cy}" r="1.6"></circle>`;
        })}`);
        wrap.hidden = false;
        return true;
    }

    function toggleDetails() {
        const button = $('#serverMoreBtn');
        const panel = $('#serverMore');
        const open = button.getAttribute('aria-expanded') === 'true';
        button.setAttribute('aria-expanded', String(!open));
        panel.hidden = open;
        button.textContent = open ? 'عرض المزيد' : 'إخفاء التفاصيل';
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

    /* ------------------------ welcome images ------------------------ */

    async function loadWelcome() {
        const wrap = $('#welcome');
        if (!wrap) return;
        try {
            const data = await api('/api/discord/welcome');
            if (!data.available || !data.images || !data.images.length) return;

            // Images only, as asked: no names, no handles, no timestamps.
            // alt is empty because these are decorative here — a screen
            // reader announcing ten unlabelled avatars adds nothing.
            const cards = data.images.map(image => html`
                <img class="welcome-img" src="${safeHref(image.url)}" alt="" loading="lazy">`);

            const row = $('#welcomeRow');
            const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
            if (reduceMotion) {
                // The CSS loop relies on a doubled row scrolled by half its
                // width; a viewer who asked for less motion gets a plain
                // scrollable strip instead, so it isn't shown twice.
                render(row, html`${cards}`);
            } else {
                // The CSS loop only stays seamless if one half's rendered
                // width is at least the viewport's width -- otherwise the
                // tail of the scroll shows empty space before it jumps back
                // to the start. Two copies of the real image set used to be
                // "enough" only because the strip lived in a narrow column;
                // now that it spans the full panel, a handful of real
                // images can easily render narrower than a wide screen.
                // Repeating the set until each half carries at least 24
                // images (~24 * 256px including gaps =~ 6,100px) keeps a
                // half wider than any realistic viewport regardless of how
                // few images the API actually returns.
                const repeat = Math.max(1, Math.ceil(24 / cards.length));
                const half = Array.from({ length: repeat }, () => cards).flat();

                // ~2.6s per image in a half keeps the strip's speed steady
                // whether one repeated set is 3 images or 30, and matches
                // the smaller card size (max 240px wide, down from 320px).
                row.style.setProperty('--welcome-dur', `${Math.max(half.length * 2.6, 10)}s`);
                render(row, html`${half}${half}`);
            }
            wrap.hidden = false;
        } catch {
            // Stays hidden.
        }
    }

    /* ----------------------------- boot ----------------------------- */

    function init() {
        E.initNav();
        E.initReveal();

        // Settled independently on purpose — see the file header.
        const moreBtn = $('#serverMoreBtn');
        if (moreBtn) moreBtn.addEventListener('click', toggleDetails);

        loadServer();
        loadNews();
        loadStore();
        loadDiscord();
        loadWelcome();

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
