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
        // 拉一次最新（失败不拦人 —— 离线也要能记）
        try { await this.pull(); } catch (e) { console.warn('保存前同步失败，用本地数据', e); }
        apply();
        await this.push();
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
    async ensureRepo() {
        try {
            await this.api.getRepository(this.owner, this.repo);
            return;
        } catch (e) {
            if (e.status !== 404) throw e;
        }
        await this.api.createRepository(this.repo, {
            description: 'WEEK OF WEEK · 粥粥记录 —— 学习打卡数据',
            private: true,
            autoInit: true
        });
    },

    async pull() {
        await this.ensureRepo();
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
