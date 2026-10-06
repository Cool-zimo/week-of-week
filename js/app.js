/**
 * WEEK OF WEEK · 粥粥记录
 *
 * 解决的问题：口头记账记不住。"上上周你欠我一个语文"这种话说过就忘，
 * 谁也说不清到底欠没欠。所以把每节课落到具体日期上，按周自动算账。
 */
(function () {
    const TOKEN_KEY = 'wow_token';
    const USER_KEY = 'wow_user';

    const state = {
        view: 'month',
        anchor: new Date(),     // 月视图看月份，周视图看周一
        api: null,
        me: null,
        // 弹窗内的编辑态
        editing: null,          // { dateKey, subjects:[], note:'', photos:[], pendingFiles:[] }
        urlCache: new Map(),
    };

    const $ = id => document.getElementById(id);
    const esc = s => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    let toastTimer = null;
    function toast(msg, kind) {
        const el = $('toast');
        el.textContent = msg;
        el.className = 'toast' + (kind ? ' ' + kind : '');
        el.classList.remove('hidden');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
    }
    function syncing(on, msg) {
        const el = $('sync-state');
        if (on) el.dataset.busy = '1'; else delete el.dataset.busy;
        el.textContent = on ? (msg || '同步中…') : syncLabel();
        el.style.opacity = on ? '.75' : '.9';
        el.classList.toggle('sync-warn', !on && DataStore.pendingCount() > 0);
    }

    /** 顶栏那句话：有没上云的就说清楚，别只写"已保存"骗人 */
    function syncLabel() {
        const n = DataStore.pendingCount();
        return n ? `${n} 条未同步` : '已保存';
    }

    /** 补推队列；成功就刷新界面并把顶栏改回来 */
    async function flushPending(quiet) {
        const n = DataStore.pendingCount();
        if (!n) return;
        if (!quiet) syncing(true, '补同步…');
        const r = await DataStore.flushPending();
        syncing(false);
        if (r.ok && r.n) {
            renderAll();
            if (!quiet) toast(`${r.n} 条已同步到云端`, 'ok');
        }
    }

    // ══════════ 登录 ══════════
    async function login(token) {
        const btn = $('login-btn');
        btn.disabled = true; btn.textContent = '正在验证…';
        $('login-err').classList.add('hidden');
        try {
            const api = new GitHubAPI(token);
            const me = await api.getMe();
            localStorage.setItem(TOKEN_KEY, token);
            localStorage.setItem(USER_KEY, JSON.stringify({ login: me.login }));
            await boot(api, me);
        } catch (e) {
            const box = $('login-err');
            box.textContent = e.status === 401
                ? '令牌无效或已过期，请检查后重试'
                : '登录失败：' + e.message;
            box.classList.remove('hidden');
        } finally {
            btn.disabled = false; btn.textContent = '进入 →';
        }
    }

    async function boot(api, me) {
        state.api = api; state.me = me;
        DataStore.api = api; DataStore.owner = me.login;

        $('login').classList.add('hidden');
        $('app').classList.remove('hidden');
        $('user-name').textContent = '@' + me.login;

        // 先用缓存立刻渲染，网络回来再刷新 —— 弱网下不至于白屏
        const cached = DataStore.cacheLoad();
        if (cached) { DataStore.data = cached; renderAll(); }

        syncing(true, '读取中…');
        try {
            await DataStore.pull();
            renderAll();
            syncing(false);
            bindAutoSync();
            // 进来先看看有没有上次没推上去的
            if (DataStore.pendingCount()) flushPending(false);
        } catch (e) {
            syncing(false);
            toast('读取失败：' + e.message + '（显示的是本地缓存）', 'err');
            if (!cached) DataStore.data = DataStore.blank();
            renderAll();
        }
    }

    // ══════════ 渲染 ══════════
    function renderAll() {
        // 顶栏状态跟着每次重绘走 —— 不指望调用方记得调 syncing(false)
        const el = $('sync-state');
        if (el && !el.dataset.busy) {
            el.textContent = syncLabel();
            el.classList.toggle('sync-warn', DataStore.pendingCount() > 0);
        }
        renderDebtBanner();
        if (state.view === 'month') renderMonth(); else renderWeek();
        $('view-month').classList.toggle('hidden', state.view !== 'month');
        $('view-week').classList.toggle('hidden', state.view !== 'week');
    }

    function periodLabel() {
        if (state.view === 'month') {
            const d = state.anchor;
            return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`;
        }
        const mon = DataStore.mondayOf(state.anchor);
        const sun = DataStore.addDays(mon, 6);
        const fmt = x => `${x.getMonth() + 1}/${x.getDate()}`;
        const thisMon = DataStore.mondayOf(new Date());
        const diff = Math.round((mon - thisMon) / (7 * 86400000));
        let tag = '';
        if (diff === 0) tag = ' · 本周';
        else if (diff === -1) tag = ' · 上周';
        else if (diff < 0) tag = ` · ${-diff} 周前`;
        else tag = ` · ${diff} 周后`;
        return `${fmt(mon)} – ${fmt(sun)}${tag}`;
    }

    /** 角标：有记录显示科目简称，没有就显示"无" */
    function tagsHTML(dateKey) {
        const subs = DataStore.subjectsOf(dateKey);
        // 没记录只放一个极淡的小点。
        // 原来写的是"无"字 —— 一个月里 31 个格子全是"无"太吵，
        // 反而看不出哪天学了。留一个点，既保留"有/无"的信息，又不抢视线。
        if (!subs.length) return '<i class="tag-dot"></i>';
        return subs.map(k =>
            `<span class="tag" style="color:${DataStore.colorOf(k)}">${esc(DataStore.shortOf(k))}</span>`
        ).join('');
    }

    function renderMonth() {
        $('period-label').textContent = periodLabel();
        const a = state.anchor;
        const first = new Date(a.getFullYear(), a.getMonth(), 1);
        // getDay(): 0=周日 … 6=周六；月视图第一列是周一
        const lead = (first.getDay() + 6) % 7;
        const daysInMonth = new Date(a.getFullYear(), a.getMonth() + 1, 0).getDate();

        const todayKey = DataStore.toKey(new Date());
        let html = '';
        for (let i = 0; i < lead; i++) html += '<div class="cell cell-empty"></div>';

        for (let d = 1; d <= daysInMonth; d++) {
            const date = new Date(a.getFullYear(), a.getMonth(), d);
            const key = DataStore.toKey(date);
            const rec = DataStore.record(key);
            const cls = ['cell'];
            if (key === todayKey) cls.push('cell-today');
            if (rec) cls.push('cell-has');
            html += `<div class="${cls.join(' ')}" data-key="${key}">
                <span class="c-num">${d}</span>
                <span class="c-tags">${tagsHTML(key)}</span>
            </div>`;
        }
        // 尾部补到整周，网格不会塌
        const total = lead + daysInMonth;
        const tail = (7 - total % 7) % 7;
        for (let i = 0; i < tail; i++) html += '<div class="cell cell-empty"></div>';

        $('grid').innerHTML = html;
        $('grid').querySelectorAll('.cell[data-key]').forEach(c => {
            c.addEventListener('click', () => openDay(c.dataset.key));
        });
    }

    function renderWeek() {
        $('period-label').textContent = periodLabel();
        const st = DataStore.weekStat(DataStore.mondayOf(state.anchor));
        const todayKey = DataStore.toKey(new Date());

        // ── 本周进度 ──
        let sum = '<div class="wsum-title">本周进度</div>';
        for (const s of st.stat) {
            const pct = s.goal ? Math.min(100, s.done / s.goal * 100) : (s.done ? 100 : 0);
            const cls = s.diff >= 0 ? 'over' : (st.days.some(d => d.isFuture) ? '' : 'lack');
            const tail = s.diff >= 0 ? `超额 +${s.diff}` : `还差 ${-s.diff}`;
            sum += `<div class="wsum-row">
                <span class="wsum-name"><i style="background:${s.color}"></i>${esc(s.key)}</span>
                <span class="wsum-bar"><span class="wsum-fill" style="width:${pct}%;background:${s.color}"></span></span>
                <span class="wsum-num"><b>${s.done}</b>/${s.goal}
                    <span class="${cls}">${s.diff === 0 ? '完成' : tail}</span></span>
            </div>`;
        }
        sum += `<div class="wsum-row" style="margin-top:12px;padding-top:10px;border-top:1px solid #f3f4f8;">
            <span class="wsum-name">合计</span>
            <span class="wsum-bar"></span>
            <span class="wsum-num"><b>${st.totalDone}</b>/${st.totalGoal}</span>
        </div>`;
        $('week-summary').innerHTML = sum;

        // ── 七天卡片 ──
        const names = ['一', '二', '三', '四', '五', '六', '日'];
        $('week-days').innerHTML = st.days.map((d, i) => {
            const cls = ['wday'];
            if (d.isToday) cls.push('wday-today');
            return `<div class="${cls.join(' ')}" data-key="${d.dateKey}">
                <div class="wday-hd"><b>${d.day}</b><span>周${names[i]}</span></div>
                <div class="wday-tags">${tagsHTML(d.dateKey)}</div>
                ${d.note ? `<div class="wday-note">${esc(d.note)}</div>` : ''}
                ${d.photoCount ? `<div class="wday-ph">📷 ${d.photoCount} 张</div>` : ''}
            </div>`;
        }).join('');
        $('week-days').querySelectorAll('.wday').forEach(c => {
            c.addEventListener('click', () => openDay(c.dataset.key));
        });

        // ── 历史周 ──
        const hist = DataStore.debtHistory(12);
        let h = '<div class="whist-title">往周账本</div>';
        if (!hist.length) {
            h += '<div style="font-size:12.5px;color:#9aa1b1">还没有记录</div>';
        } else {
            for (const w of hist.slice().reverse()) {
                const mon = w.monday;
                const label = `${mon.getMonth() + 1}/${mon.getDate()} 那周`;
                let when = label;
                if (w.isCurrent) when = `<span class="hrow-cur">${label}（本周）</span>`;
                else if (w.weeksAgo === 1) when = `${label}（上周）`;
                else when = `${label}（${w.weeksAgo} 周前）`;

                // ★ 本周不能写"欠"：今天才周二就说欠一节，是假警报。
                //   本周还在进行中，只能说"还差"；只有整周过完了才叫"欠"。
                //   这正是"上上周你欠我一个语文"这句话的语义 ——
                //   "欠"只对已经结束的周成立。
                const items = w.stat.map(s => {
                    if (s.diff === 0) return `<span class="hitem hitem-ok">${esc(s.short)} 完成</span>`;
                    if (s.diff > 0) return `<span class="hitem hitem-ok">${esc(s.short)} 超 +${s.diff}</span>`;
                    if (w.isCurrent) {
                        return `<span class="hitem hitem-todo">${esc(s.short)} 还差 ${-s.diff}</span>`;
                    }
                    return `<span class="hitem hitem-lack">${esc(s.short)} 欠 ${-s.diff}</span>`;
                }).join('');
                h += `<div class="hrow"><span class="hrow-when">${when}</span>
                      <span class="hrow-items">${items}</span></div>`;
            }
        }
        $('week-history').innerHTML = h;
    }

    function renderDebtBanner() {
        const debts = DataStore.totalDebt().filter(d => d.debt !== 0);
        const el = $('debt-banner');
        if (!debts.length) {
            el.classList.add('hidden');
            return;
        }
        const owes = debts.filter(d => d.debt < 0);
        const over = debts.filter(d => d.debt > 0);
        let html = owes.length
            ? `<span class="db-title">还欠着：</span>`
            : `<span class="db-title">多学了：</span>`;
        for (const d of (owes.length ? owes : over)) {
            const n = Math.abs(d.debt);
            html += `<span class="debt-item" style="background:${d.color}1a;color:${d.color}">
                ${esc(d.key)} ${d.debt < 0 ? '欠' : '超'} ${n} 节</span>`;
        }
        if (owes.length && over.length) {
            for (const d of over) {
                html += `<span class="debt-item debt-ok">${esc(d.key)} 多 ${d.debt} 节</span>`;
            }
        }
        el.innerHTML = html;
        el.classList.remove('hidden');
    }

    // ══════════ 日期弹窗 ══════════
    async function openDay(dateKey) {
        const rec = DataStore.record(dateKey);
        const date = DataStore.parseKey(dateKey);
        const names = ['日', '一', '二', '三', '四', '五', '六'];
        const mon = DataStore.mondayOf(date);
        const thisMon = DataStore.mondayOf(new Date());
        const weeksAgo = Math.round((thisMon - mon) / (7 * 86400000));

        $('dm-title').textContent = `${date.getMonth() + 1} 月 ${date.getDate()} 日 · 周${names[date.getDay()]}`;
        let sub = weeksAgo === 0 ? '本周' : (weeksAgo === 1 ? '上周' : `${weeksAgo} 周前`);
        const st = DataStore.weekStat(mon);
        const lack = st.stat.filter(s => s.diff < 0);
        if (lack.length && weeksAgo !== 0) {
            sub += ` · 那周${lack.map(s => `${s.short} 欠 ${-s.diff}`).join('、')}`;
        }
        $('dm-sub').textContent = sub;

        state.editing = {
            dateKey,
            subjects: rec ? (rec.subjects || []).slice() : [],
            note: rec ? (rec.note || '') : '',
            photos: rec ? (rec.photos || []).slice() : [],
            pendingFiles: [],
        };
        $('dm-note').value = state.editing.note;
        renderChips();
        await renderPhotos();
        $('day-modal').classList.remove('hidden');
    }

    function renderChips() {
        const ed = state.editing;
        $('dm-subjects').innerHTML = DataStore.subjects().map(s => {
            const on = ed.subjects.includes(s.key);
            return `<button class="chip ${on ? 'on' : ''}" data-key="${esc(s.key)}"
                    style="${on ? `background:${s.color}` : ''}">
                <i style="background:${on ? '#fff' : s.color}"></i>${esc(s.key)}
                <span class="chip-goal">周${s.goal}</span>
            </button>`;
        }).join('');
        $('dm-subjects').querySelectorAll('.chip').forEach(c => {
            c.addEventListener('click', () => {
                const k = c.dataset.key;
                const i = ed.subjects.indexOf(k);
                if (i >= 0) ed.subjects.splice(i, 1); else ed.subjects.push(k);
                renderChips();
            });
        });
    }

    /** 老照片只存了 path，统一按主仓取；新的带 repo */
    async function photoURL(p) {
        const path = typeof p === 'string' ? p : p.path;
        const repo = typeof p === 'string' ? DataStore.repo : DataStore.photoRepo(p);
        const ck = repo + '/' + path;
        if (state.urlCache.has(ck)) return state.urlCache.get(ck);
        try {
            const u = await Photos.loadURL(state.api, DataStore.owner, repo, path);
            state.urlCache.set(ck, u);
            return u;
        } catch (e) {
            console.warn('照片加载失败', repo, path, e.message);
            return null;
        }
    }

    async function renderPhotos() {
        const ed = state.editing;
        const box = $('dm-photos');
        let html = '';
        for (const p of ed.photos) {
            const u = await photoURL(p.path);
            html += `<div class="ph">${u ? `<img src="${u}" alt="">` : '<div class="ph-load">加载失败</div>'}
                <button class="ph-x" data-path="${esc(p.path)}">✕</button></div>`;
        }
        for (let i = 0; i < ed.pendingFiles.length; i++) {
            const f = ed.pendingFiles[i];
            const u = URL.createObjectURL(f);
            html += `<div class="ph"><img src="${u}" alt="">
                <button class="ph-x" data-pending="${i}">✕</button></div>`;
        }
        box.innerHTML = html;
        box.querySelectorAll('.ph-x').forEach(b => {
            b.addEventListener('click', () => {
                if (b.dataset.path) {
                    ed.photos = ed.photos.filter(p => p.path !== b.dataset.path);
                } else {
                    ed.pendingFiles.splice(Number(b.dataset.pending), 1);
                }
                renderPhotos();
            });
        });
        box.querySelectorAll('.ph img').forEach(img => {
            img.addEventListener('click', () => {
                $('viewer-img').src = img.src;
                $('viewer').classList.remove('hidden');
            });
        });
    }

    async function saveDay() {
        const ed = state.editing;
        if (!ed) return;
        const btn = $('dm-save');
        btn.disabled = true;
        try {
            syncing(true, '保存中…');
            if (ed.pendingFiles.length) {
                // 先压缩出实际大小，才知道要占多少、该放哪个仓库
                syncing(true, '处理照片…');
                const packed = await Photos.pack(ed.pendingFiles,
                    pct => syncing(true, `处理照片 ${pct}%`));
                const need = packed.reduce((a, p) => a + p.size, 0);
                const v = await DataStore.ensureVault(need);
                if (v.isNew) toast(`已新建存储仓库 ${v.repo}`, 'ok');

                syncing(true, '传照片…');
                const up = await Photos.upload(
                    state.api, DataStore.owner, v.repo, ed.dateKey, packed,
                    pct => syncing(true, `传照片 ${pct}%`));
                // 记住每张照片住在哪个仓库，读取时才找得到
                for (const u of up) u.repo = v.repo;
                ed.photos = ed.photos.concat(up);
                ed.pendingFiles = [];
            }
            DataStore.recalcVaults();
            const r = await DataStore.saveRecord(ed.dateKey, ed.subjects, $('dm-note').value, ed.photos);
            syncing(false);
            $('day-modal').classList.add('hidden');
            state.editing = null;
            renderAll();
            // ★ 没上云就不能说"已保存" —— 那是骗人，用户会以为同步好了
            if (r.synced) toast('已保存', 'ok');
            else toast('已存到本地，联网后自动同步', 'err');
        } catch (e) {
            syncing(false);
            toast('保存失败：' + e.message, 'err');
        } finally {
            btn.disabled = false;
        }
    }

    /** 网络恢复、切回页面、每隔一分钟，都试着把没上云的补上 */
    function bindAutoSync() {
        window.addEventListener('online', () => flushPending(false));
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) flushPending(true);
        });
        setInterval(() => { if (!document.hidden) flushPending(true); }, 60000);
    }

    /* ══════════ 发布给家长 ══════════ */
    const pubOpt = { weeks: 2, withPhotos: true };

    function openPublish() {
        $('pub-modal').classList.remove('hidden');
        $('pub-status').classList.add('hidden');
    }

    /** 按选项算出要发布哪些天 */
    function pubDays() {
        const all = Object.keys(DataStore.data.records || {}).sort();
        if (!all.length) return [];
        if (!pubOpt.weeks) return all.map(k => DataStore.parseKey(k));
        const today = new Date();
        const mon = DataStore.mondayOf(today);
        const from = DataStore.addDays(mon, -7 * (pubOpt.weeks - 1));
        return all.map(k => DataStore.parseKey(k)).filter(d => d >= from);
    }

    async function doPublish() {
        const days = pubDays();
        if (!days.length) { toast('这段时间还没有记录', 'err'); return; }
        const btn = $('pub-go');
        btn.disabled = true;
        const st = $('pub-status');
        st.classList.remove('hidden');
        try {
            st.textContent = '正在准备…';
            const r = await Publish.push(state.api, DataStore.owner, DataStore.data, days,
                { withPhotos: pubOpt.withPhotos, title: '粥粥的学习记录' });
            st.innerHTML = `✓ 发布好了<br>
                <a href="${r.url}" target="_blank" class="pub-link">${r.url}</a><br>
                <span class="pub-meta">${r.days} 天${r.photos ? ` · ${r.photos} 张照片` : ''}</span>`;
            toast('发布好了', 'ok');
        } catch (e) {
            st.textContent = '发布失败：' + e.message;
            toast('发布失败', 'err');
        } finally {
            btn.disabled = false;
        }
    }

    // ══════════ 事件 ══════════
    function bind() {
        $('login-btn').addEventListener('click', () => {
            const t = $('token-input').value.trim();
            if (!t) { toast('请输入令牌', 'err'); return; }
            login(t);
        });
        $('token-input').addEventListener('keydown', e => {
            if (e.key === 'Enter') $('login-btn').click();
        });
        /* ── 拍照 ── */
        $('dm-cam').addEventListener('click', async () => {
            const ed = state.editing;
            if (!ed) return;
            try {
                await Camera.open(file => {
                    ed.pendingFiles.push(file);
                    renderPhotos();
                    toast('已拍一张，可以接着拍', 'ok');
                });
            } catch (e) {
                toast(e.message || '摄像头打不开', 'err');
                // 失败时把原因显示在弹窗里，比一闪而过的 toast 看得清
                const st = $('cam-err');
                st.textContent = e.message || '摄像头打不开';
                st.classList.remove('hidden');
                $('cam-modal').classList.remove('hidden');
            }
        });
        $('cam-shoot').addEventListener('click', () => Camera.shoot());
        $('cam-flip').addEventListener('click', () => Camera.flip());
        $('cam-close').addEventListener('click', () => Camera.close());
        $('cam-done').addEventListener('click', () => Camera.close());

        $('publish-btn').addEventListener('click', openPublish);
        $('pub-close').addEventListener('click', () => $('pub-modal').classList.add('hidden'));
        $('pub-cancel').addEventListener('click', () => $('pub-modal').classList.add('hidden'));
        $('pub-go').addEventListener('click', doPublish);
        $('pub-range').addEventListener('click', e => {
            const c = e.target.closest('.chip'); if (!c) return;
            $('pub-range').querySelectorAll('.chip').forEach(x => x.classList.remove('on'));
            c.classList.add('on');
            pubOpt.weeks = Number(c.dataset.w);
        });
        $('pub-photos').addEventListener('click', e => {
            const c = e.target.closest('.chip'); if (!c) return;
            $('pub-photos').querySelectorAll('.chip').forEach(x => x.classList.remove('on'));
            c.classList.add('on');
            pubOpt.withPhotos = c.dataset.p === '1';
        });

        $('logout-btn').addEventListener('click', () => {
            if (!confirm('退出后需要重新输入令牌，本地缓存会清掉。确定吗？')) return;
            localStorage.removeItem(TOKEN_KEY);
            localStorage.removeItem(USER_KEY);
            localStorage.removeItem(DataStore.CACHE_KEY);
            location.reload();
        });

        document.querySelectorAll('.seg-btn').forEach(b => {
            b.addEventListener('click', () => {
                document.querySelectorAll('.seg-btn').forEach(x => x.classList.remove('active'));
                b.classList.add('active');
                state.view = b.dataset.view;
                state.anchor = new Date();
                renderAll();
            });
        });

        $('prev').addEventListener('click', () => {
            if (state.view === 'month') {
                state.anchor = new Date(state.anchor.getFullYear(), state.anchor.getMonth() - 1, 1);
            } else {
                state.anchor = DataStore.addDays(state.anchor, -7);
            }
            renderAll();
        });
        $('next').addEventListener('click', () => {
            if (state.view === 'month') {
                state.anchor = new Date(state.anchor.getFullYear(), state.anchor.getMonth() + 1, 1);
            } else {
                state.anchor = DataStore.addDays(state.anchor, 7);
            }
            renderAll();
        });
        $('today-btn').addEventListener('click', () => {
            state.anchor = new Date();
            renderAll();
        });

        $('dm-close').addEventListener('click', () => $('day-modal').classList.add('hidden'));
        $('dm-cancel').addEventListener('click', () => $('day-modal').classList.add('hidden'));
        $('dm-save').addEventListener('click', saveDay);
        $('dm-clear').addEventListener('click', async () => {
            const ed = state.editing;
            if (!ed) return;
            if (!confirm('清空这天的全部记录（含照片）？')) return;
            syncing(true, '保存中…');
            try {
                await DataStore.saveRecord(ed.dateKey, [], '', []);
                syncing(false);
                toast('已清空', 'ok');
                $('day-modal').classList.add('hidden');
                state.editing = null;
                renderAll();
            } catch (e) {
                toast('清空失败：' + e.message, 'err');
            }
            syncing(false);
        });

        $('dm-file').addEventListener('change', e => {
            const ed = state.editing;
            if (!ed) return;
            for (const f of e.target.files) ed.pendingFiles.push(f);
            e.target.value = '';
            renderPhotos();
        });

        $('day-modal').addEventListener('click', e => {
            if (e.target.id === 'day-modal') $('day-modal').classList.add('hidden');
        });
        $('viewer-close').addEventListener('click', () => $('viewer').classList.add('hidden'));
        $('viewer').addEventListener('click', e => {
            if (e.target.id === 'viewer') $('viewer').classList.add('hidden');
        });
        document.addEventListener('keydown', e => {
            if (e.key !== 'Escape') return;
            $('viewer').classList.add('hidden');
            $('day-modal').classList.add('hidden');
        });
    }

    // ══════════ 启动 ══════════
    bind();
    const saved = localStorage.getItem(TOKEN_KEY);
    if (saved) {
        // 有 token 先直接进，验证放后台 —— 刷新时不该卡在登录页等网络
        const api = new GitHubAPI(saved);
        const me = JSON.parse(localStorage.getItem(USER_KEY) || '{}');
        boot(api, me).catch(async () => {
            // token 失效：回到登录页，但保留输入过的内容
            localStorage.removeItem(TOKEN_KEY);
            $('login').classList.remove('hidden');
            $('app').classList.add('hidden');
            toast('登录已失效，请重新输入令牌', 'err');
        });
    }
})();
