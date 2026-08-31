/* ===============================================================
   ENCLAVE — news admin console

   Sign in with Discord (staff only) or the owner's TOTP code, then create,
   edit, publish and delete posts.

   Every write carries the session's CSRF token, handed over by
   /api/admin/session and held in core.js. The server checks it against the
   session and checks Origin independently, so nothing here is trusted.
   =============================================================== */

(function (E) {
    'use strict';

    const { $, $$, html, render, api, timeAgo, toast } = E;

    // Reasons the OAuth redirect can come back with. The server sends a
    // fixed code and the wording lives here, so nothing from Discord's
    // response is ever echoed into the page.
    const SIGNIN_ERRORS = {
        'not-configured': 'دخول ديسكورد غير مهيأ على الخادم. استخدم رمز التحقق.',
        'bad-state': 'انتهت جلسة الدخول. حاول مرة ثانية.',
        'no-code': 'لم يكتمل الدخول عبر ديسكورد.',
        'token-exchange-failed': 'تعذّر إكمال الدخول مع ديسكورد.',
        'identity-failed': 'ما قدرنا نقرأ هويتك من ديسكورد.',
        'not-a-member': 'لازم تكون عضواً في سيرفر ديسكورد أولاً.',
        'membership-check-failed': 'تعذّر التحقق من عضويتك. حاول لاحقاً.',
        'not-staff': 'حسابك ليس ضمن طاقم الإدارة.'
    };

    let posts = [];
    let editingId = null;

    /* ---------------------------- session ---------------------------- */

    async function loadSession() {
        const session = await api('/api/admin/session');
        if (!session.signedIn) {
            showGateError();
            return false;
        }

        E.setCsrf(session.csrfToken);
        $('#gate').hidden = true;
        $('#console').hidden = false;
        $('#whoami').textContent = session.user.displayName || '';
        return true;
    }

    function showGateError() {
        const params = new URLSearchParams(location.search);
        const reason = params.get('error');
        if (!reason) return;

        const box = $('#gateError');
        box.textContent = SIGNIN_ERRORS[reason] || 'تعذّر تسجيل الدخول.';
        box.hidden = false;

        // Drop the query string so a refresh does not re-show a stale error.
        history.replaceState(null, '', location.pathname);
    }

    /* ------------------------------ list ------------------------------ */

    function statusBadge(post) {
        if (!post.published) return html`<span class="badge badge-caution">مسودة</span>`;
        if (post.pinned) return html`<span class="badge badge-accent">منشور · مثبّت</span>`;
        return html`<span class="badge badge-positive">منشور</span>`;
    }

    function row(post) {
        return html`
            <tr>
                <td>${post.title}</td>
                <td>${post.tag || '—'}</td>
                <td>${statusBadge(post)}</td>
                <td><time datetime="${post.updatedAt || ''}">${timeAgo(post.updatedAt)}</time></td>
                <td class="table-actions">
                    <button class="btn btn-quiet btn-sm" type="button" data-edit="${post.id}">تحرير</button>
                </td>
            </tr>`;
    }

    async function loadPosts() {
        try {
            const data = await api('/api/admin/news');
            posts = data.posts || [];
        } catch (error) {
            render('#postRows', html`
                <tr><td class="table-empty" colspan="5">${error.message}</td></tr>`);
            return;
        }

        if (!posts.length) {
            render('#postRows', html`
                <tr><td class="table-empty" colspan="5">لا توجد أخبار بعد. ابدأ بواحد جديد.</td></tr>`);
            return;
        }
        render('#postRows', html`${posts.map(row)}`);
    }

    /* ----------------------------- editor ----------------------------- */

    function openEditor(post) {
        editingId = post ? post.id : null;

        $('#editorTitle').textContent = post ? 'تحرير الخبر' : 'خبر جديد';
        $('#fTitle').value = post ? post.title : '';
        $('#fTag').value = post ? (post.tag || '') : '';
        $('#fSlug').value = post ? (post.slug || '') : '';
        $('#fCover').value = post ? (post.coverImage || '') : '';
        $('#fBody').value = post ? (post.body || '') : '';
        $('#fPinned').checked = Boolean(post && post.pinned);
        $('#fPublished').checked = Boolean(post && post.published);
        $('#deletePost').hidden = !post;

        const editor = $('#editor');
        editor.dataset.open = 'true';
        editor.setAttribute('aria-hidden', 'false');
        $('#fTitle').focus();
    }

    function closeEditor() {
        const editor = $('#editor');
        editor.dataset.open = 'false';
        editor.setAttribute('aria-hidden', 'true');
        editingId = null;
    }

    function formValues() {
        return {
            title: $('#fTitle').value.trim(),
            tag: $('#fTag').value.trim(),
            slug: $('#fSlug').value.trim(),
            coverImage: $('#fCover').value.trim(),
            body: $('#fBody').value,
            pinned: $('#fPinned').checked,
            published: $('#fPublished').checked
        };
    }

    async function save(event) {
        event.preventDefault();
        const button = $('#savePost');
        button.disabled = true;

        try {
            const body = formValues();
            if (editingId) {
                await api(`/api/admin/news/${encodeURIComponent(editingId)}`, { method: 'PUT', body });
                toast('تم حفظ التعديلات.');
            } else {
                await api('/api/admin/news', { method: 'POST', body });
                toast('تم إنشاء الخبر.');
            }
            closeEditor();
            await loadPosts();
        } catch (error) {
            toast(error.message, 'error');
        } finally {
            button.disabled = false;
        }
    }

    async function remove() {
        if (!editingId) return;
        if (!confirm('حذف هذا الخبر نهائياً؟')) return;

        try {
            await api(`/api/admin/news/${encodeURIComponent(editingId)}`, { method: 'DELETE' });
            toast('تم حذف الخبر.');
            closeEditor();
            await loadPosts();
        } catch (error) {
            toast(error.message, 'error');
        }
    }

    /* ----------------------------- settings ----------------------------- */

    const DETAIL_LABELS = {
        gametype: 'النمط',
        mapname: 'الخريطة',
        projectName: 'اسم المشروع',
        projectDesc: 'وصف السيرفر',
        tags: 'الوسوم',
        locale: 'اللغة',
        enforceGameBuild: 'إصدار اللعبة',
        onesync: 'OneSync',
        resourceCount: 'عدد الموارد',
        serverVersion: 'إصدار السيرفر',
        upvotes: 'التصويتات'
    };

    const SYNC_REASONS = {
        'no-access': 'البوت ما يقدر يقرأ القناة',
        'not-found': 'القناة غير موجودة',
        'rate-limited': 'تجاوز حد الطلبات',
        unreachable: 'تعذّر الوصول',
        error: 'خطأ',
        disabled: 'المزامنة معطّلة',
        'no-bot-token': 'ما فيه توكن بوت',
        'no-channels': 'ما فيه قنوات محددة'
    };

    async function loadSettings() {
        const { settings, detailFields, lastSync } = await api('/api/admin/settings');

        $('#sJoin').value = settings.fivemJoinCode || '';
        $('#sInvite').value = settings.discordInviteCode || '';
        $('#sStore').value = settings.storeUrl || '';
        $('#sPlayers').checked = settings.publishPlayerList === true;
        $('#sPlayerMap').checked = settings.publishPlayerMap === true;
        $('#sNewsSync').checked = settings.newsSyncEnabled === true;
        $('#sNewsChannels').value = (settings.newsChannelIds || []).join('\n');
        $('#sWelcome').checked = settings.showWelcomeImages === true;
        $('#sWelcomeChannel').value = settings.welcomeChannelId || '';

        // Built from the server's own list, so a field added later appears
        // here without a matching edit in this file.
        const chosen = new Set(settings.serverDetailFields || []);
        render('#detailFields', html`${(detailFields || []).map(field => html`
            <label class="detail-field">
                <input type="checkbox" value="${field}" ${chosen.has(field) ? html`checked` : null}>
                <span>${DETAIL_LABELS[field] || field}</span>
            </label>`)}`);

        $('#settingsMeta').textContent = settings.updatedAt
            ? `آخر تعديل ${timeAgo(settings.updatedAt)}${settings.updatedBy ? ` — ${settings.updatedBy}` : ''}`
            : '';

        paintSync(lastSync);
    }

    /** Per-channel sync outcome, so a permission problem is visible here. */
    function paintSync(result) {
        const wrap = $('#syncStatusWrap');
        const meta = $('#syncMeta');
        if (!result) {
            wrap.hidden = true;
            meta.textContent = 'لم تتم أي مزامنة بعد.';
            return;
        }

        meta.textContent = result.syncedAt
            ? `آخر مزامنة ${timeAgo(result.syncedAt)}`
            : '';

        if (!result.channels || !result.channels.length) {
            wrap.hidden = true;
            if (result.reason) {
                meta.textContent += ` — ${SYNC_REASONS[result.reason] || result.reason}`;
            }
            return;
        }

        render('#syncRows', html`${result.channels.map(channel => html`
            <tr>
                <td class="hint-mono">${channel.channelId}</td>
                <td>${channel.ok
                    ? html`<span class="badge badge-positive">تعمل</span>`
                    : html`<span class="badge badge-negative">${SYNC_REASONS[channel.reason] || channel.reason}</span>`}</td>
                <td>${String(channel.added || 0)}</td>
                <td>${String(channel.removed || 0)}</td>
            </tr>`)}`);
        wrap.hidden = false;
    }

    async function syncNow() {
        const button = $('#syncNow');
        button.disabled = true;
        try {
            const result = await api('/api/admin/news/sync', { method: 'POST' });
            paintSync(result);
            toast(result.added
                ? `تمت إضافة ${result.added} مسودة.`
                : 'لا يوجد جديد.');
            await loadPosts();
        } catch (error) {
            toast(error.message, 'error');
        } finally {
            button.disabled = false;
        }
    }

    async function saveSettings(event) {
        event.preventDefault();
        const button = $('#saveSettings');
        button.disabled = true;

        try {
            const { changed } = await api('/api/admin/settings', {
                method: 'PUT',
                body: {
                    fivemJoinCode: $('#sJoin').value.trim(),
                    discordInviteCode: $('#sInvite').value.trim(),
                    storeUrl: $('#sStore').value.trim(),
                    publishPlayerList: $('#sPlayers').checked,
                    publishPlayerMap: $('#sPlayerMap').checked,
                    serverDetailFields: $$('#detailFields input:checked').map(box => box.value),
                    newsSyncEnabled: $('#sNewsSync').checked,
                    newsChannelIds: $('#sNewsChannels').value.split(/[\s,]+/).filter(Boolean),
                    showWelcomeImages: $('#sWelcome').checked,
                    welcomeChannelId: $('#sWelcomeChannel').value.trim()
                }
            });
            toast(changed.length ? 'تم حفظ الإعدادات.' : 'لا يوجد تغيير.');
            // Re-read rather than trusting the form: the server normalises
            // a pasted URL down to a bare code, and the field should show
            // what was actually stored.
            await loadSettings();
        } catch (error) {
            toast(error.message, 'error');
        } finally {
            button.disabled = false;
        }
    }

    /* ------------------------------- panes ------------------------------- */

    const PANE_TITLES = { news: 'الأخبار والإعلانات', settings: 'الإعدادات' };

    function showPane(name) {
        $$('.tab').forEach(tab => {
            tab.setAttribute('aria-selected', String(tab.getAttribute('data-pane') === name));
        });
        $('#paneNews').hidden = name !== 'news';
        $('#paneSettings').hidden = name !== 'settings';
        // "New post" belongs to the news pane only; leaving it visible on
        // settings would open an editor over a form the operator is filling.
        $('#newPost').hidden = name !== 'news';
        $('#paneTitle').textContent = PANE_TITLES[name] || '';
        if (name === 'settings') loadSettings().catch(e => toast(e.message, 'error'));
    }

    /* ------------------------------ boot ------------------------------ */

    async function signInWithTotp(event) {
        event.preventDefault();
        const code = $('#totpCode').value.trim();
        try {
            const result = await api('/api/admin/login', { method: 'POST', body: { code } });
            E.setCsrf(result.csrfToken);
            $('#gate').hidden = true;
            $('#console').hidden = false;
            await loadPosts();
        } catch (error) {
            toast(error.message, 'error');
            $('#totpCode').value = '';
            $('#totpCode').focus();
        }
    }

    async function signOut() {
        try {
            await api('/api/admin/logout', { method: 'POST' });
        } finally {
            location.href = '/admin';
        }
    }

    async function init() {
        $('#totpForm').addEventListener('submit', signInWithTotp);
        $('#paneSettings').addEventListener('submit', saveSettings);
        $('#syncNow').addEventListener('click', syncNow);
        $$('.tab').forEach(tab => {
            tab.addEventListener('click', () => showPane(tab.getAttribute('data-pane')));
        });
        $('#editorForm').addEventListener('submit', save);
        $('#newPost').addEventListener('click', () => openEditor(null));
        $('#editorClose').addEventListener('click', closeEditor);
        $('#cancelEdit').addEventListener('click', closeEditor);
        $('#deletePost').addEventListener('click', remove);
        $('#signOut').addEventListener('click', signOut);

        // The rows are re-rendered on every load, so the listener lives on
        // the table body rather than on each button.
        $('#postRows').addEventListener('click', (event) => {
            const id = event.target.getAttribute && event.target.getAttribute('data-edit');
            if (!id) return;
            const post = posts.find(candidate => candidate.id === id);
            if (post) openEditor(post);
        });

        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && $('#editor').dataset.open === 'true') closeEditor();
        });

        if (await loadSession()) await loadPosts();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})(window.Enclave);
