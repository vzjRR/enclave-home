/* ===============================================================
   ENCLAVE — shared client core
   Escaping, templating, API client, toasts, scroll reveal.
   Loaded before home.js, news.js and admin.js.

   The same primitives as the store repo's js/core.js, trimmed to what
   these three pages use. Kept deliberately similar so the two front ends
   read the same way.
   =============================================================== */

(function (global) {
    'use strict';

    /* ---------------------------------------------------------------
       Escaping & templating

       Every dynamic string goes through `html`, which escapes each
       interpolated value. Rendering is innerHTML throughout, so this is
       the thing standing between a news title and script execution — the
       page CSP is the net under it, not a substitute for it.
    --------------------------------------------------------------- */

    const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

    function esc(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/[&<>"']/g, ch => ESCAPES[ch]);
    }

    /** Marker for strings that are already safe markup. Use sparingly. */
    function raw(markup) {
        return { __safe: String(markup) };
    }

    function html(strings, ...values) {
        let out = strings[0];
        for (let i = 0; i < values.length; i++) {
            const value = values[i];
            if (value === null || value === undefined || value === false) {
                // skip
            } else if (value && value.__safe !== undefined) {
                out += value.__safe;
            } else if (Array.isArray(value)) {
                out += value.map(v => (v && v.__safe !== undefined ? v.__safe : esc(v))).join('');
            } else {
                out += esc(value);
            }
            out += strings[i + 1];
        }
        return raw(out);
    }

    function render(target, safeMarkup) {
        const node = typeof target === 'string' ? document.querySelector(target) : target;
        if (!node) return null;
        node.innerHTML = safeMarkup && safeMarkup.__safe !== undefined ? safeMarkup.__safe : '';
        return node;
    }

    const $ = (selector, scope = document) => scope.querySelector(selector);
    const $$ = (selector, scope = document) => Array.from(scope.querySelectorAll(selector));

    /**
     * A URL that is about to land in an href.
     *
     * Server-side validation already rejects anything but http(s), mailto
     * and site-relative paths, but values also arrive from the store's API,
     * which this service does not own.
     */
    function safeHref(url) {
        const value = String(url || '').trim();
        return /^(https?:\/\/|mailto:|\/)/i.test(value) ? value : '';
    }

    /* ---------------------------------------------------------------
       API client
    --------------------------------------------------------------- */

    let csrfToken = '';
    const setCsrf = token => { csrfToken = token || ''; };

    async function api(path, { method = 'GET', body } = {}) {
        const headers = {};
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        if (csrfToken && method !== 'GET') headers['X-CSRF-Token'] = csrfToken;

        const response = await fetch(path, {
            method,
            headers,
            credentials: 'same-origin',
            body: body === undefined ? undefined : JSON.stringify(body)
        });

        let payload = null;
        try {
            payload = await response.json();
        } catch {
            // A proxy error page or an empty 204 — neither is JSON, and
            // neither should throw over the caller's actual error.
        }

        if (!response.ok) {
            const error = new Error((payload && payload.error) || `فشل الطلب (${response.status})`);
            error.status = response.status;
            throw error;
        }
        return payload;
    }

    /* ---------------------------------------------------------------
       Numbers and dates

       Digits stay Latin and tabular so the stat tiles line up as they
       change; the surrounding prose is Arabic. That is what the existing
       landing page does with its countdown, and it is kept here.
    --------------------------------------------------------------- */

    const numberFormat = new Intl.NumberFormat('en-US');
    const formatNumber = value => numberFormat.format(Number(value) || 0);

    function formatDate(value) {
        if (!value) return '';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return '';
        return new Intl.DateTimeFormat('ar', {
            year: 'numeric', month: 'long', day: 'numeric'
        }).format(date);
    }

    /** "قبل ٣ ساعات" style relative time, falling back to an absolute date. */
    function timeAgo(value) {
        if (!value) return '';
        const then = new Date(value).getTime();
        if (Number.isNaN(then)) return '';

        const seconds = Math.round((then - Date.now()) / 1000);
        const relative = new Intl.RelativeTimeFormat('ar', { numeric: 'auto' });
        const steps = [
            [60, 'second', 1],
            [3600, 'minute', 60],
            [86400, 'hour', 3600],
            [604800, 'day', 86400]
        ];
        const magnitude = Math.abs(seconds);
        for (const [limit, unit, divisor] of steps) {
            if (magnitude < limit) return relative.format(Math.round(seconds / divisor), unit);
        }
        return formatDate(value);
    }

    /* ---------------------------------------------------------------
       Toasts
    --------------------------------------------------------------- */

    function toast(message, tone = 'success') {
        let host = $('.toasts');
        if (!host) {
            host = document.createElement('div');
            host.className = 'toasts';
            document.body.appendChild(host);
        }
        const node = document.createElement('div');
        node.className = 'toast';
        // The stylesheet keys the accent colour off data-tone, not a class.
        node.setAttribute('data-tone', tone);
        node.setAttribute('role', tone === 'error' ? 'alert' : 'status');
        node.textContent = message;
        host.appendChild(node);
        setTimeout(() => node.remove(), 4200);
    }

    /* ---------------------------------------------------------------
       Scroll reveal

       The stylesheet ships [data-reveal] at opacity 0, waiting for
       [data-reveal='shown']. So the attribute must never be in the served
       HTML: with JavaScript disabled nothing would ever set 'shown' and
       the whole page would render blank.

       Instead the markup carries data-animate, and JS opts each element
       into the animation only once it is in a position to finish it. No
       JS means no data-reveal attribute, which means fully visible
       content — the static-first guarantee holds by construction rather
       than by remembering to test it.
    --------------------------------------------------------------- */

    function initReveal() {
        const targets = $$('[data-animate]');
        if (!targets.length) return;

        const show = node => node.setAttribute('data-reveal', 'shown');

        // No observer: show everything rather than animate nothing.
        if (!('IntersectionObserver' in global)) {
            targets.forEach(show);
            return;
        }

        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                // `isIntersecting` alone is not enough. Callbacks are
                // batched and delivered on a later frame, so during a fast
                // scroll an element can already be out of view by the time
                // its entry arrives — it reads as not intersecting and,
                // with an early return, would stay invisible for good.
                // Anything that has been scrolled past counts as seen.
                if (!entry.isIntersecting && entry.boundingClientRect.top > 0) return;
                show(entry.target);
                observer.unobserve(entry.target);
            });
        }, { rootMargin: '0px 0px -10% 0px' });

        targets.forEach((node, index) => {
            node.setAttribute('data-reveal', '');
            node.style.setProperty('--reveal-delay', `${Math.min(index, 6) * 70}ms`);
            observer.observe(node);
        });

        // Failsafe. Whatever the observer has not reported on by now gets
        // shown regardless: an animation that did not play is a cosmetic
        // loss, but a section stuck at opacity 0 is missing content.
        setTimeout(() => {
            targets.forEach(node => {
                if (node.getAttribute('data-reveal') !== 'shown') show(node);
            });
        }, 3000);
    }

    /** Adds the scrolled state the sticky nav styles itself from. */
    function initNav() {
        const nav = $('.nav');
        if (!nav) return;
        const sync = () => nav.setAttribute('data-scrolled', String(global.scrollY > 8));
        sync();
        global.addEventListener('scroll', sync, { passive: true });
    }

    global.Enclave = {
        esc, raw, html, render, $, $$, safeHref,
        api, setCsrf,
        formatNumber, formatDate, timeAgo,
        toast, initReveal, initNav
    };
})(window);
