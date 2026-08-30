/* ===============================================================
   ENCLAVE — news index and article view

   One page serves both: /news lists, /news/<slug> reads. The server
   returns news.html for either, and this decides which half to show.
   =============================================================== */

(function (E) {
    'use strict';

    const { $, html, render, api, safeHref, timeAgo, formatDate } = E;

    function metaRow(post) {
        return html`
            ${post.pinned ? html`<span class="badge badge-accent">مثبّت</span>` : null}
            ${post.tag ? html`<span class="chip">${post.tag}</span>` : null}
            <time datetime="${post.publishedAt || ''}">${formatDate(post.publishedAt)}</time>`;
    }

    function card(post) {
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

    async function showIndex() {
        try {
            const { posts } = await api('/api/news');
            if (!posts || !posts.length) return;
            render('#newsList', html`${posts.map(card)}`);
            E.initReveal();
        } catch {
            // The empty state already in the markup is the right fallback.
        }
    }

    async function showArticle(slug) {
        const index = $('#newsIndex');
        const article = $('#newsArticle');

        let post;
        try {
            post = await api(`/api/news/${encodeURIComponent(slug)}`);
        } catch (error) {
            // A missing or unpublished post falls back to the list rather
            // than a dead end, with a word about why.
            if (error.status === 404) {
                E.toast('هذا الخبر غير موجود أو لم يُنشر بعد.', 'error');
            } else {
                E.toast('ما قدرنا نفتح الخبر. حاول مرة ثانية.', 'error');
            }
            return;
        }

        index.hidden = true;
        article.hidden = false;

        document.title = `${post.title} — ENCLAVE RP`;
        $('#postTitle').textContent = post.title;
        render('#postMeta', metaRow(post));

        const cover = safeHref(post.coverImage);
        const coverEl = $('#postCover');
        if (cover) {
            coverEl.src = cover;
            coverEl.hidden = false;
        }

        // post.html is rendered and escaped by lib/markdown.js on the
        // server — the author's text was HTML-escaped before any tag was
        // introduced, so this is markup we generated, not markup we were
        // given. It is the one place `raw` is used on this page.
        render('#postBody', E.raw(post.html));
    }

    function init() {
        E.initNav();

        const match = /^\/news\/([^/]+)\/?$/.exec(location.pathname);
        if (match) {
            let slug = match[1];
            try {
                slug = decodeURIComponent(slug);
            } catch {
                // A malformed escape sequence is not a slug worth asking
                // the server about; fall through to the index.
                showIndex();
                return;
            }
            showArticle(slug);
            return;
        }

        showIndex();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})(window.Enclave);
