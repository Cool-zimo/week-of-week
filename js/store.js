/**
 * 数据层
 *
 * 数据结构（存到 wow-data 仓库的 data.json）：
 * {
 *   version: 1,
 *   updatedAt: ISO,
 *   subjects: [ {key:'语文', short:'语', goal:1, color:'#ef4444'}, ... ],
 *   records: {
 *     '2026-10-06': { subjects:['数学','英语'], note:'...', photos:[{path,w,h,name,size}] }
 *   }
 * }
 *
 * ★ 一周从周一开始：中国习惯，也和"上上周欠一节"这种说法对得上。
 *   getDay() 返回 0=周日，所以要把它映射到 7，否则周日会被算到下一周。
 */

/*
 * 科目配色：米黄纸底上的柔和暖色。
 *
 * ★ 原来的鲜红/鲜蓝/鲜绿在这张纸上有两个问题：
 *   ① 太跳，跟"温馨"不搭；
 *   ② 对比度不达标 —— 尤其绿色只有 2.35，而角标字才 10px，
 *      WCAG 对小字要求 4.5:1。实测这三个都过线了。
 */
const DEFAULT_SUBJECTS = [
    { key: '语文', short: '语', goal: 1, color: '#b5503a' },  // 砖红 4.67
    { key: '数学', short: '数', goal: 2, color: '#3f6b96' },  // 灰蓝 5.19
    { key: '英语', short: '英', goal: 2, color: '#48754f' }   // 草绿 4.95
];

/* 旧配色 → 新配色。只换这三个已知的旧值，用户自己改过的不动 */
const LEGACY_COLORS = {
    '#ef4444': '#b5503a',
    '#3b82f6': '#3f6b96',
    '#10b981': '#48754f',
};

const DataStore = {
    data: null,
    sha: null,
    api: null,
    owner: null,
    repo: 'wow-data',
    CACHE_KEY: 'wow_cache',

    // ── 日期工具 ──
    toKey(d) {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    },
    parseKey(s) {
        const [y, m, d] = s.split('-').map(Number);
        return new Date(y, m - 1, d);
    },
    /** 该日期所在周的周一 */
    mondayOf(d) {
        const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        const dow = x.getDay();            // 0=周日 … 6=周六
        const back = dow === 0 ? 6 : dow - 1;
        x.setDate(x.getDate() - back);
        return x;
    },
    weekKey(d) { return this.toKey(this.mondayOf(d)); },
    addDays(d, n) {
        const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        x.setDate(x.getDate() + n);
        return x;
    },
    /** 周一 → 周日 共 7 天 */
    weekDays(monday) {
        return Array.from({ length: 7 }, (_, i) => this.addDays(monday, i));
    },

    // ── 空数据 ──
    blank() {
        return {
            version: 1,
            updatedAt: new Date().toISOString(),
            subjects: JSON.parse(JSON.stringify(DEFAULT_SUBJECTS)),
            records: {}
        };
    },

    subjects() {
        return (this.data && this.data.subjects && this.data.subjects.length)
            ? this.data.subjects : DEFAULT_SUBJECTS;
    },
    shortOf(key) {
        const s = this.subjects().find(x => x.key === key);
        return s ? (s.short || s.key[0]) : key[0];
    },
    colorOf(key) {
        const s = this.subjects().find(x => x.key === key);
        return s ? (s.color || '#6b7280') : '#6b7280';
    },
    goalOf(key) {
        const s = this.subjects().find(x => x.key === key);
        return s ? (s.goal || 0) : 0;
    },

    record(dateKey) {
        if (!this.data) return null;
        return this.data.records[dateKey] || null;
    },
    /** 某天学过的科目（去重，保持配置顺序） */
    subjectsOf(dateKey) {
        const r = this.record(dateKey);
        if (!r || !Array.isArray(r.subjects)) return [];
        const order = this.subjects().map(s => s.key);
        return r.subjects.filter(k => order.includes(k))
                         .sort((a, b) => order.indexOf(a) - order.indexOf(b));
    },

    /**
     * 保存某天的记录。
     *
     * ★ 先 pull 再改：两台设备同时录不同日期时，
     *   如果各自拿着旧数据直接覆盖，后写的会把先写的整份冲掉。
     *   保存前拉一次最新，绝大多数冲突就不存在了。
     */
    /**
     * 保存某天的记录。
     *
     * 返回 { synced } —— 调用方据此决定说"已保存"还是"已存本地，待同步"。
     *
     * ★ 顺序很关键：先落地 + 入队，再尝试上云。
     *   上云失败不再是"保存失败"，而是"存本地了，联网后自动同步"。
     *   这样断网记的课不会丢，用户也知道它还没上云。
     */
    async saveRecord(dateKey, subjects, note, photos) {
        if (!this.data) this.data = this.blank();
        const apply = () => {
            const has = subjects.length || (note && note.trim()) || (photos && photos.length);
            if (has) {
                this.data.records[dateKey] = {
                    subjects: subjects.slice(),
                    note: note || '',
                    photos: photos || []
                };
            } else {
                delete this.data.records[dateKey];
            }
        };
        // ① 先落到本地并入队 —— 这一步不能失败
        apply();
        this.pendingAdd(dateKey);
        this.cacheSave();

        // ② 再尝试上云
        try {
            await this.pull();          // 拉最新（会保住 pending 的本地版本）
            apply();
            await this.push();
            this.pendingDel(dateKey);   // 真的上云了才出队
            this.cacheSave();
            return { synced: true };
        } catch (e) {
            console.warn('上云失败，已存本地待同步：', e.message);
            this.cacheSave();
            return { synced: false, error: e };
        }
    },

    /** 把 pending 里没上云的重新推一次。成功返回同步了几条。 */
    async flushPending() {
        const keys = this.pendingLoad();
        if (!keys.length) return { ok: true, n: 0 };
        try {
            await this.pull();
            await this.push();
            this.pendingSave([]);
            this.cacheSave();
            return { ok: true, n: keys.length };
        } catch (e) {
            return { ok: false, n: 0, error: e };
        }
    },

    // ── 周统计 ──
    /**
     * 某一周的完成情况
     * @returns {monday, days:[{dateKey,day,subjects,note,photoCount,isToday,isFuture}],
     *           stat:[{key,short,color,done,goal,diff}], totalGoal, totalDone}
     */
    weekStat(monday) {
        const days = this.weekDays(monday).map(d => {
            const k = this.toKey(d);
            const r = this.record(k);
            return {
                dateKey: k,
                date: d,
                day: d.getDate(),
                subjects: this.subjectsOf(k),
                note: r ? (r.note || '') : '',
                photoCount: r && r.photos ? r.photos.length : 0,
                isToday: k === this.toKey(new Date()),
                isFuture: d > new Date()
            };
        });
        const stat = this.subjects().map(s => {
            let done = 0;
            for (const d of days) {
                if (d.subjects.includes(s.key)) done++;
            }
            return {
                key: s.key, short: s.short || s.key[0], color: s.color,
                done, goal: s.goal || 0, diff: done - (s.goal || 0)
            };
        });
        return {
            monday,
            weekKey: this.toKey(monday),
            days,
            stat,
            totalGoal: stat.reduce((a, s) => a + s.goal, 0),
            totalDone: stat.reduce((a, s) => a + s.done, 0)
        };
    },

    /**
     * 历史欠账：从有记录的第一周到本周，逐周统计。
     *
     * ★ 只统计"已经过去的整周"——本周还没过完，欠了不算欠，
     *   否则周三看一眼就显示"欠 3 节"，是假警报。
     *   本周用"进度"显示，历史周才用"欠/超"。
     */
    debtHistory(weeksBack = 12) {
        const today = new Date();
        const thisMonday = this.mondayOf(today);
        const out = [];
        for (let i = weeksBack; i >= 0; i--) {
            const monday = this.addDays(thisMonday, -7 * i);
            const st = this.weekStat(monday);
            const isCurrent = (i === 0);
            // 完全没记录且不是本周 → 不显示（还没开始用）
            const anyRecord = st.totalDone > 0;
            if (!anyRecord && !isCurrent) continue;
            out.push({ ...st, isCurrent, weeksAgo: i });
        }
        return out;
    },

    /** 累计欠账（不含本周） */
    totalDebt() {
        const hist = this.debtHistory(200).filter(w => !w.isCurrent);
        const byKey = {};
        for (const w of hist) {
            for (const s of w.stat) {
                byKey[s.key] = (byKey[s.key] || 0) + s.diff;
            }
        }
        return this.subjects().map(s => ({
            key: s.key, short: s.short || s.key[0], color: s.color,
            debt: byKey[s.key] || 0
        }));
    },

    // ── 远端读写 ──
    async ensureRepo(repoName) {
        const name = repoName || this.repo;
        try {
            await this.api.getRepository(this.owner, name);
            return;
        } catch (e) {
            if (e.status !== 404) throw e;
        }
        await this.api.createRepository(name, {
            description: 'WEEK OF WEEK · 粥粥记录 —— 学习打卡数据',
            private: true,
            autoInit: true
        });
    },

    /* ══════════ 多仓库（vault）══════════
     *
     * ★ 为什么需要：照片全塞进 wow-data 一个仓库，涨到 1GB 就传不动了。
     *   GitHub 对单仓的建议上限是 1GB（硬超会报警，再大就拒绝推送）。
     *   这里取 900MB 作为阈值，留出余量。
     *
     * 做法：装不下就再开一个 wow-data-2 / -3 …，每张照片记住自己住哪个仓库。
     * 读取时按记录的 repo 去取 —— 所以扩仓对使用者是透明的。
     */
    VAULT_MAX: 900 * 1024 * 1024,

    /** 初始化并保证 vaults 数组存在（老数据没有这个字段） */
    vaults() {
        if (!this.data) this.data = this.blank();
        if (!this.data.vaults || !this.data.vaults.length) {
            this.data.vaults = [{ repo: this.repo, bytes: this._guessBytes() }];
        }
        return this.data.vaults;
    },

    /** 老数据没有用量记录，按已有照片估算一次，避免一上来就误判成满 */
    _guessBytes() {
        let n = 0;
        for (const k in (this.data.records || {})) {
            for (const p of (this.data.records[k].photos || [])) n += p.size || 0;
        }
        return n;
    },

    /** 下一个仓库名：wow-data → wow-data-2 → wow-data-3 */
    _nextVaultName() {
        const used = new Set(this.vaults().map(v => v.repo));
        for (let i = 2; i < 100; i++) {
            const n = `${this.repo}-${i}`;
            if (!used.has(n)) return n;
        }
        return `${this.repo}-${Date.now().toString(36)}`;
    },

    /**
     * 找一个装得下 needBytes 的仓库；都不够就新建一个。
     * @returns {Promise<{repo:string, isNew:boolean}>}
     */
    async ensureVault(needBytes) {
        const vs = this.vaults();
        let last = vs[vs.length - 1];
        // 最后一个仓库还有位置 —— 直接用
        if (last && (last.bytes || 0) + needBytes <= this.VAULT_MAX) {
            return { repo: last.repo, isNew: false };
        }
        // 前面的可能还有空位（比如中间某个还没满）
        for (const v of vs) {
            if ((v.bytes || 0) + needBytes <= this.VAULT_MAX) return { repo: v.repo, isNew: false };
        }
        // 都要满了 —— 开新的
        const name = this._nextVaultName();
        await this.ensureRepo(name);
        vs.push({ repo: name, bytes: 0 });
        return { repo: name, isNew: true };
    },

    /**
     * 按实际记录重算每个仓库的用量。
     *
     * ★ 为什么不用"加加减减"：删照片、删整天、上传失败重试，
     *   任何一种漏记都会让用量越滚越大，最后明明没满却白白开新仓。
     *   每次保存前从 records 全量重算，贵是贵一点（纯内存遍历），但不会错。
     */
    recalcVaults() {
        const vs = this.vaults();
        for (const v of vs) v.bytes = 0;
        for (const k in (this.data.records || {})) {
            for (const p of (this.data.records[k].photos || [])) {
                const r = this.photoRepo(p);
                let v = vs.find(x => x.repo === r);
                if (!v) { v = { repo: r, bytes: 0 }; vs.push(v); }
                v.bytes += p.size || 0;
            }
        }
        return vs;
    },

    /** 每条照片记录补上 repo（老数据统一归到主仓） */
    photoRepo(p) { return p && p.repo ? p.repo : this.repo; },

    /** 总用量 / 上限，给界面显示 */
    vaultStat() {
        const vs = this.vaults();
        const bytes = vs.reduce((a, v) => a + (v.bytes || 0), 0);
        return { bytes, max: this.VAULT_MAX * vs.length, repos: vs.length };
    },

    async pull() {
        await this.ensureRepo();
        // ★ 拉之前先把本地"还没推上云"的那几天存下来，
        //   拉完要用它盖回去 —— 否则云端旧数据会把未同步的记录吃掉。
        const pending = this.pendingLoad();
        const keep = {};
        if (pending.length && this.data && this.data.records) {
            for (const k of pending) if (this.data.records[k]) keep[k] = this.data.records[k];
        }
        const f = await this.api.getFileOrNull(this.owner, this.repo, 'data.json');
        if (!f) {
            this.data = this.blank();
            this.sha = null;
        } else {
            this.sha = f.sha;
            const text = new TextDecoder('utf-8').decode(
                Uint8Array.from(atob(f.content.replace(/\n/g, '')), c => c.charCodeAt(0)));
            try {
                this.data = JSON.parse(text);
            } catch (e) {
                console.warn('data.json 解析失败，用空数据', e);
                this.data = this.blank();
            }
            if (!this.data.records) this.data.records = {};
            if (!this.data.subjects) this.data.subjects = JSON.parse(JSON.stringify(DEFAULT_SUBJECTS));
            // 还没同步的日期，本地说了算
            Object.assign(this.data.records, keep);
            // 老数据里的鲜艳色换掉，不然在米黄纸上又跳又看不清
            for (const s of this.data.subjects) {
                if (LEGACY_COLORS[s.color]) s.color = LEGACY_COLORS[s.color];
            }
        }
        this.cacheSave();
        return this.data;
    },

    async push() {
        if (!this.data) return;
        this.data.updatedAt = new Date().toISOString();
        const write = () => {
            const text = JSON.stringify(this.data);
            const b64 = btoa(unescape(encodeURIComponent(text)));
            return this.api.putFile(
                this.owner, this.repo, 'data.json', b64,
                `粥粥记录 ${this.toKey(new Date())}`, 'main', this.sha);
        };
        let res;
        try {
            res = await write();
        } catch (e) {
            /*
             * 409 = 远端被别的设备改过了，我手里的 sha 过期。
             * 拉最新 → 合并 → 用新 sha 重试一次。
             *
             * 合并规则：记录是按天存的，所以逐天合并 ——
             * 我这边的改动保留，远端独有的日期也保留，两边都不丢。
             */
            if (e.status !== 409) throw e;
            const mine = this.data.records || {};
            await this.pull();
            this.data.records = Object.assign({}, this.data.records || {}, mine);
            res = await write();
        }
        this.sha = (res && res.content && res.content.sha) || this.sha;
        this.cacheSave();
    },

    /*
     * ★ 缓存必须连 sha 一起存。
     *
     * 只存 data 的话，网络失败时 data 从缓存恢复、sha 却是 null，
     * 下次 push 不带 sha = 直接强制覆盖远端 —— 等于把别的设备
     * 刚录的课整份抹掉，而且用户完全看不出来。
     */
    cacheSave() {
        try {
            localStorage.setItem(this.CACHE_KEY, JSON.stringify({
                data: this.data, sha: this.sha, at: Date.now()
            }));
        } catch (e) { /* 配额满就算了 */ }
    },

    /*
     * ── 待同步队列 ──
     *
     * ★ 这是"断网记了一课，刷新后没了"的解法。
     *
     * 原来的流程是：apply() 改内存 → push() 上云。
     * push 失败就抛错，但内存已经改了 —— UI 上看着有，云端没有。
     * 下次刷新 pull 拉回云端旧数据，把本地那条整份盖掉，
     * 用户完全不知道自己记的东西去哪了。
     *
     * 现在：改动先落地 + 记进 pending，上云成功才出队。
     * pull 时 pending 里的日期以本地为准，绝不被云端覆盖。
     */
    PENDING_KEY: 'wow.pending.v1',

    pendingLoad() {
        try { return JSON.parse(localStorage.getItem(this.PENDING_KEY) || '[]'); }
        catch (e) { return []; }
    },
    pendingSave(keys) {
        try { localStorage.setItem(this.PENDING_KEY, JSON.stringify([...new Set(keys)])); }
        catch (e) { /* 配额满就算了 */ }
    },
    pendingAdd(dateKey) { this.pendingSave(this.pendingLoad().concat([dateKey])); },
    pendingDel(dateKey) { this.pendingSave(this.pendingLoad().filter(k => k !== dateKey)); },
    pendingCount() { return this.pendingLoad().length; },
    cacheLoad() {
        try {
            const raw = localStorage.getItem(this.CACHE_KEY);
            if (!raw) return null;
            const o = JSON.parse(raw);
            if (o && o.data) { this.sha = o.sha || null; return o.data; }
            return null;
        } catch (e) { return null; }
    }
};
