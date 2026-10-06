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

const DEFAULT_SUBJECTS = [
    { key: '语文', short: '语', goal: 1, color: '#ef4444' },
    { key: '数学', short: '数', goal: 2, color: '#3b82f6' },
    { key: '英语', short: '英', goal: 2, color: '#10b981' }
];

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

    async saveRecord(dateKey, subjects, note, photos) {
        if (!this.data) this.data = this.blank();
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
        }
        this.cacheSave();
        return this.data;
    },

    async push() {
        if (!this.data) return;
        this.data.updatedAt = new Date().toISOString();
        const text = JSON.stringify(this.data);
        const b64 = btoa(unescape(encodeURIComponent(text)));
        const res = await this.api.putFile(
            this.owner, this.repo, 'data.json', b64,
            `粥粥记录 ${this.toKey(new Date())}`, 'main', this.sha);
        this.sha = (res && res.content && res.content.sha) || this.sha;
        this.cacheSave();
    },

    cacheSave() {
        try {
            localStorage.setItem(this.CACHE_KEY, JSON.stringify({
                data: this.data, at: Date.now()
            }));
        } catch (e) { /* 配额满就算了 */ }
    },
    cacheLoad() {
        try {
            const raw = localStorage.getItem(this.CACHE_KEY);
            if (!raw) return null;
            return JSON.parse(raw).data || null;
        } catch (e) { return null; }
    }
};
