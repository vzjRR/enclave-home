'use strict';

/* ---------------------------------------------------------------
   A small Markdown subset, rendered on the server.

   Rendering here rather than in the browser keeps a Markdown library off
   the page entirely, which matters under a `script-src 'self'` policy with
   no CDN, and means the stored source is never handed to a client that
   might render it less carefully.

   The safety rule is the order of operations: every character of the input
   is HTML-escaped FIRST, and only then are the handful of tags this module
   generates introduced. Nothing an author types can become markup — a
   pasted <script> is inert text by the time any rule looks at it. That is
   why there is no sanitiser pass afterwards; there is nothing to sanitise.

   Supported: headings (## ###), bold, italic, inline code, fenced code,
   links, images, unordered and ordered lists, blockquotes, horizontal
   rules, paragraphs. Anything else is left as text.
--------------------------------------------------------------- */

// Only schemes that cannot execute. `javascript:` is the obvious exclusion;
// `data:` is excluded too, since a data: URI in an href can carry HTML.
const SAFE_URL = /^(https?:\/\/|mailto:|\/)[^\s"'<>]*$/i;

function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** A URL that failed the allow-list renders as plain text, not a dead link. */
function safeUrl(url) {
    const trimmed = String(url).trim();
    return SAFE_URL.test(trimmed) ? trimmed : null;
}

/**
 * Inline rules. Runs on already-escaped text.
 *
 * Code spans are extracted before anything else and put back at the end, so
 * `**not bold**` inside backticks stays literal.
 *
 * The placeholder is wrapped in angle brackets deliberately: escapeHtml has
 * already turned every author-supplied `<` into `&lt;`, so a raw `<` cannot
 * appear in this text by any other route. That makes the sentinel
 * impossible to forge from the input.
 */
function inline(text) {
    const codeSpans = [];
    let out = text.replace(/`([^`]+)`/g, (_, code) => {
        codeSpans.push(code);
        return `<${codeSpans.length - 1}>`;
    });

    out = out
        .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, url) => {
            const href = safeUrl(url);
            return href ? `<img src="${href}" alt="${alt}" loading="lazy">` : match;
        })
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label, url) => {
            const href = safeUrl(url);
            if (!href) return match;
            // Anything leaving the site opens in a new tab, and rel stops the
            // opened page from reaching back through window.opener.
            const external = /^https?:\/\//i.test(href);
            const attrs = external ? ' target="_blank" rel="noopener noreferrer"' : '';
            return `<a href="${href}"${attrs}>${label}</a>`;
        })
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');

    return out.replace(/<(\d+)>/g, (_, index) => `<code>${codeSpans[index]}</code>`);
}

function renderList(lines, ordered) {
    const tag = ordered ? 'ol' : 'ul';
    const items = lines
        .map(line => line.replace(ordered ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/, ''))
        .map(item => `<li>${inline(item)}</li>`)
        .join('');
    return `<${tag}>${items}</${tag}>`;
}

function renderBlock(block) {
    const lines = block.split('\n');
    const first = lines[0];

    if (/^```/.test(first)) {
        // The closing fence may be missing on a truncated draft; everything
        // after the opener is still the code body.
        const closed = lines.length > 1 && lines[lines.length - 1].startsWith('```');
        const body = lines.slice(1, closed ? lines.length - 1 : lines.length).join('\n');
        return `<pre><code>${body}</code></pre>`;
    }

    if (/^\s*(-{3,}|\*{3,})\s*$/.test(first)) return '<hr>';

    const heading = /^(#{2,4})\s+(.*)$/.exec(first);
    if (heading) {
        const level = heading[1].length;
        return `<h${level}>${inline(heading[2])}</h${level}>`;
    }

    if (lines.every(line => /^\s*[-*]\s+/.test(line))) return renderList(lines, false);
    if (lines.every(line => /^\s*\d+\.\s+/.test(line))) return renderList(lines, true);

    if (lines.every(line => /^\s*>\s?/.test(line))) {
        const body = lines.map(line => line.replace(/^\s*>\s?/, '')).join(' ');
        return `<blockquote>${inline(body)}</blockquote>`;
    }

    // A single newline inside a paragraph is a line break, matching what
    // someone writing in a textarea expects to see.
    return `<p>${inline(lines.join('\n')).replace(/\n/g, '<br>')}</p>`;
}

function render(source) {
    const escaped = escapeHtml(String(source ?? '').replace(/\r\n/g, '\n').trim());
    if (!escaped) return '';

    return escaped
        .split(/\n{2,}/)
        .map(block => block.trim())
        .filter(Boolean)
        .map(renderBlock)
        .join('\n');
}

/** First stretch of plain text, for meta descriptions and card summaries. */
function excerpt(source, maxLength = 180) {
    const text = String(source ?? '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/[#>*`_[\]()]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength).replace(/\s+\S*$/, '')}…`;
}

module.exports = { render, excerpt, escapeHtml, safeUrl };
