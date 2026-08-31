'use strict';

/* ---------------------------------------------------------------
   News and announcements.

   Persistence comes from JsonStore: written atomically, with every
   mutation serialised through one promise chain — the same shape the store
   repo uses for its catalogue, and for the same reason: two concurrent
   admin saves must not interleave into a half-written file.

   Post bodies are stored as Markdown source. The rendered HTML is derived
   on read and memoised, rather than being written into the document. That
   costs a little CPU per cold read and buys the property that a fix to
   lib/markdown.js takes effect everywhere immediately, instead of leaving
   HTML rendered by the old rules sitting in the file.
--------------------------------------------------------------- */

const crypto = require('crypto');
const path = require('path');

const markdown = require('./markdown');
const { JsonStore } = require('./jsonStore');

const MAX_TITLE = 140;
const MAX_BODY = 40000;
const MAX_TAG = 32;
const MAX_POSTS = 500;

/**
 * Slugs keep Arabic letters rather than transliterating them: the sites are
 * Arabic, and a percent-encoded Arabic slug is a normal, shareable URL.
 * Only characters that would be ambiguous in a path are dropped.
 */
function slugify(title) {
    const base = String(title ?? '')
        .trim()
        .toLowerCase()
        .replace(/[\s_]+/g, '-')
        .replace(/[^\p{L}\p{N}-]+/gu, '')
        .replace(/-{2,}/g, '-')
        .replace(/^-|-$/g, '');
    return base || `post-${Date.now()}`;
}

function fail(message, statusCode = 400) {
    return Object.assign(new Error(message), { statusCode });
}

class News extends JsonStore {
    constructor(dataDir) {
        super(path.join(dataDir, 'news.json'), { posts: [] });
        this.renderCache = new Map();
    }

    #render(post) {
        const key = `${post.id}:${post.updatedAt}`;
        let html = this.renderCache.get(key);
        if (html === undefined) {
            html = markdown.render(post.body);
            // The cache is keyed by updatedAt, so an edited post lands on a
            // new key and the old one is dead weight. Clearing on growth is
            // enough for a set this size.
            if (this.renderCache.size > 200) this.renderCache.clear();
            this.renderCache.set(key, html);
        }
        return html;
    }

    /** Card-sized view: no rendered body, so a list response stays small. */
    summary(post) {
        return {
            id: post.id,
            slug: post.slug,
            title: post.title,
            excerpt: post.excerpt || markdown.excerpt(post.body),
            tag: post.tag || '',
            pinned: post.pinned === true,
            coverImage: post.coverImage || '',
            publishedAt: post.publishedAt,
            updatedAt: post.updatedAt
        };
    }

    /** Full view, including the rendered body. */
    full(post) {
        return { ...this.summary(post), html: this.#render(post), body: post.body };
    }

    /**
     * Published posts, pinned first then newest first.
     * Drafts are never returned here — only the admin listing sees them.
     */
    published({ limit = 0, tag = '' } = {}) {
        const posts = this.state.posts
            .filter(post => post.published === true)
            .filter(post => (tag ? post.tag === tag : true))
            .sort((a, b) => {
                if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
                return Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0);
            });
        return limit > 0 ? posts.slice(0, limit) : posts;
    }

    findBySlug(slug) {
        return this.state.posts.find(post => post.slug === slug) || null;
    }

    findById(id) {
        return this.state.posts.find(post => post.id === id) || null;
    }

    /** Every post, drafts included, newest edit first. Admin listing only. */
    all() {
        return [...this.state.posts]
            .sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0));
    }

    #validate(input, existingId) {
        const title = String(input?.title ?? '').trim();
        const body = String(input?.body ?? '').trim();

        if (!title) throw fail('العنوان مطلوب');
        if (title.length > MAX_TITLE) throw fail(`العنوان يجب أن يكون أقصر من ${MAX_TITLE} حرف`);
        if (!body) throw fail('محتوى الخبر مطلوب');
        if (body.length > MAX_BODY) throw fail('محتوى الخبر طويل جداً');

        const tag = String(input?.tag ?? '').trim().slice(0, MAX_TAG);

        const coverImage = String(input?.coverImage ?? '').trim();
        // Reuse the renderer's allow-list so a cover image cannot smuggle in
        // a scheme that the post body itself would have rejected.
        if (coverImage && !markdown.safeUrl(coverImage)) {
            throw fail('رابط صورة الغلاف غير صالح');
        }

        // An author may set the slug explicitly; otherwise it follows the
        // title. Either way it has to be unique, since it is the URL.
        let slug = slugify(input?.slug || title);
        const clash = post => post.slug === slug && post.id !== existingId;
        if (this.state.posts.some(clash)) {
            slug = `${slug}-${crypto.randomBytes(2).toString('hex')}`;
        }

        return {
            title,
            body,
            tag,
            coverImage,
            slug,
            pinned: input?.pinned === true,
            published: input?.published === true
        };
    }

    create(input, author) {
        const fields = this.#validate(input, null);
        const now = new Date().toISOString();

        return this.mutate(state => {
            if (state.posts.length >= MAX_POSTS) {
                throw fail('تم بلوغ الحد الأقصى لعدد الأخبار', 409);
            }
            const post = {
                id: `news_${crypto.randomBytes(8).toString('hex')}`,
                ...fields,
                excerpt: markdown.excerpt(fields.body),
                author: author || '',
                createdAt: now,
                updatedAt: now,
                // publishedAt is the ordering key readers see, so it is set
                // when a post first goes live — not when the draft was made.
                publishedAt: fields.published ? now : null
            };
            state.posts.push(post);
            return this.full(post);
        });
    }

    update(id, input) {
        return this.mutate(state => {
            const post = state.posts.find(candidate => candidate.id === id);
            if (!post) throw fail('الخبر غير موجود', 404);

            const fields = this.#validate(input, id);
            const now = new Date().toISOString();

            // Publishing for the first time stamps publishedAt; re-publishing
            // something previously live keeps its original date, so an edit
            // does not shuffle it back to the top of the page.
            const publishedAt = fields.published
                ? (post.publishedAt || now)
                : null;

            Object.assign(post, fields, {
                excerpt: markdown.excerpt(fields.body),
                updatedAt: now,
                publishedAt
            });
            return this.full(post);
        });
    }

    remove(id) {
        return this.mutate(state => {
            const index = state.posts.findIndex(post => post.id === id);
            if (index === -1) throw fail('الخبر غير موجود', 404);
            state.posts.splice(index, 1);
            return { removed: id };
        });
    }
}

module.exports = { News, slugify, MAX_TITLE, MAX_BODY };
