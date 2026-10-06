/**
 * 发布：把记录做成一个静态页面，推到公开仓库，开 Pages
 *
 * ★ 为什么必须公开：wow-data 是私有仓库，而 GitHub Pages 对私有仓库
 *   需要付费账号。想让老父亲打开链接就能看，只能放进公开仓库。
 *   → 所以发上去的照片等于公开，发布前必须让用户明确选、明确知道。
 *
 * 页面是自包含的：文字 + 照片 + 样式全在一个仓库里，
 * 不依赖 wow-data、不依赖登录、不依赖任何后端。
 */
const Publish = {
    REPO: 'wow-view',

    esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    },

    /**
     * 生成页面 HTML
     * @param {Object} data  DataStore.data
     * @param {Array}  days  要发布的日期（Date 数组，升序）
     * @param {Object} opt   { withPhotos, title }
     */
    buildHTML(data, days, opt = {}) {
        const S = data.subjects || [];
        const R = data.records || {};
        const esc = this.esc;

        // ── 按周分组 ──
        const weeks = new Map();
        for (const d of days) {
            const k = DataStore.weekKey(d);
            if (!weeks.has(k)) weeks.set(k, []);
            weeks.get(k).push(d);
        }

        let weekHTML = '';
        let totalDebt = {};
        let hasAny = false;

        for (const [wk, dds] of weeks) {
            // 这周每天上的科目，累加
            const got = {};
            let cells = '';
            for (const d of dds) {
                const key = DataStore.toKey(d);
                const rec = R[key];
                if (!rec || !(rec.subjects || []).length) continue;
                hasAny = true;
                for (const s of rec.subjects) got[s] = (got[s] || 0) + 1;

                const wd = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
                let tags = rec.subjects.map(s => {
                    const sub = S.find(x => x.key === s);
                    const c = sub ? sub.color : '#666';
                    return `<span class="tag" style="color:${c}">${esc(sub ? (sub.short || s) : s)}</span>`;
                }).join('');

                let ph = '';
                if (opt.withPhotos && (rec.photos || []).length) {
                    ph = '<div class="phs">' + rec.photos.map(p => {
                        const src = this.esc('files/' + (p.pub || p.path.split('/').pop()));
                        return `<a href="${src}" target="_blank"><img src="${src}" alt="" loading="lazy"></a>`;
                    }).join('') + '</div>';
                }

                cells += `<div class="day">
                    <div class="dh"><span class="dn">${d.getMonth() + 1}/${d.getDate()}</span>
                    <span class="dw">周${wd}</span><span class="dt">${tags}</span></div>
                    ${rec.note ? `<div class="dnote">${esc(rec.note).replace(/\n/g, '<br>')}</div>` : ''}
                    ${ph}</div>`;
            }

            // 这周目标 vs 实际
            const stat = S.map(s => {
                const g = s.goal || 0, n = got[s.key] || 0;
                const diff = n - g;
                totalDebt[s.key] = (totalDebt[s.key] || 0) + Math.min(0, diff);
                const cls = diff >= 0 ? 'ok' : 'no';
                const mark = diff >= 0 ? '✓' : '欠' + (-diff);
                return `<span class="st ${cls}" style="--c:${s.color}">${esc(s.key)} ${n}/${g} ${mark}</span>`;
            }).join('');

            const a = dds[0], b = dds[dds.length - 1];
            weekHTML += `<div class="week">
                <div class="wh"><b>${a.getMonth() + 1}/${a.getDate()} – ${b.getMonth() + 1}/${b.getDate()}</b></div>
                <div class="ws">${stat}</div>
                <div class="wds">${cells || '<div class="empty">这周没有记录</div>'}</div>
            </div>`;
        }

        // ── 欠账总览（老父亲最想看的就是这个）──
        const debts = S.map(s => ({
            s, n: Math.abs(totalDebt[s.key] || 0)
        })).filter(x => x.n > 0);

        const debtHTML = debts.length
            ? `<div class="debt"><div class="dtitle">还欠着</div>${
                debts.map(x => `<span class="db" style="--c:${x.s.color}">${esc(x.s.key)} 欠 ${x.n} 节</span>`).join('')
              }</div>`
            : `<div class="debt ok-all"><div class="dtitle">不欠 ✅</div><span>所有科目都上够了</span></div>`;

        const title = opt.title || '粥粥的学习记录';
        const now = new Date();
        const stamp = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 更新`;

        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--paper:#faf6ee;--ink:#3d3731;--dim:#8a8178;--line:#e8e0d2}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);
 font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
 line-height:1.6;padding:16px}
.wrap{max-width:760px;margin:0 auto}
header{text-align:center;padding:20px 0 12px;border-bottom:1px solid var(--line);margin-bottom:16px}
h1{margin:0;font-size:20px;font-weight:600}
.sub{color:var(--dim);font-size:13px;margin-top:4px}
.debt{background:#fff;border:1px solid var(--line);border-left:3px solid #b5503a;
 border-radius:8px;padding:12px 14px;margin-bottom:18px}
.debt.ok-all{border-left-color:#48754f}
.dtitle{font-size:13px;font-weight:600;margin-bottom:6px}
.db{display:inline-block;margin-right:10px;font-size:14px;color:var(--c);font-weight:600}
.week{background:#fff;border:1px solid var(--line);border-radius:10px;
 padding:14px;margin-bottom:14px}
.wh{font-size:15px;margin-bottom:8px;padding-bottom:6px;border-bottom:1px dashed var(--line)}
.ws{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
.st{font-size:12px;padding:3px 9px;border-radius:20px;border:1px solid var(--c);color:var(--c)}
.st.ok{background:color-mix(in srgb,var(--c) 10%,#fff)}
.st.no{background:#fdf0ec;font-weight:600}
.wds{display:flex;flex-direction:column;gap:8px}
.day{border-left:2px solid var(--line);padding-left:10px}
.dh{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap}
.dn{font-weight:600;font-size:14px}
.dw{color:var(--dim);font-size:12px}
.dt{display:inline-flex;gap:4px;margin-left:auto}
.tag{font-size:12px;font-weight:600}
.dnote{font-size:13px;color:#5a524a;margin-top:3px;white-space:pre-wrap}
.phs{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.phs img{width:88px;height:66px;object-fit:cover;border-radius:6px;
 border:1px solid var(--line);display:block}
.empty{color:var(--dim);font-size:13px}
footer{text-align:center;color:var(--dim);font-size:12px;padding:18px 0}
@media(max-width:420px){body{padding:10px}.phs img{width:72px;height:54px}}
</style>
</head>
<body><div class="wrap">
<header><h1>📚 ${esc(title)}</h1><div class="sub">${stamp}</div></header>
${debtHTML}
${weekHTML || '<div class="empty">这段时间还没有记录</div>'}
<footer>WEEK OF WEEK · 粥粥记录</footer>
</div></body>
</html>`;
    },

    /**
     * 推送到公开仓库
     * @returns {Promise<{url:string, photos:number}>}
     */
    async push(api, owner, data, days, opt = {}) {
        const esc = this.esc;
        // 1. 确保仓库存在（公开！）
        try {
            await api.getRepository(owner, this.REPO);
        } catch (e) {
            if (e.status !== 404) throw e;
            await api.createRepository(this.REPO, {
                description: 'WEEK OF WEEK · 学习记录一览（公开发布）',
                private: false,
                autoInit: true
            });
        }

        const records = data.records || {};
        const tree = [];
        let nPhoto = 0;

        // 2. 收集照片字节（从各自所在的私有仓库取出来）
        const files = [];
        for (const d of days) {
            const key = DataStore.toKey(d);
            const rec = records[key];
            if (!rec || !opt.withPhotos) continue;
            for (const p of (rec.photos || [])) {
                const repo = DataStore.photoRepo(p);
                try {
                    const ab = await api.getFileRaw(owner, repo, p.path);
                    files.push({
                        path: 'files/' + p.path.split('/').pop(),
                        bytes: new Uint8Array(ab),
                        photo: p
                    });
                } catch (e) {
                    console.warn('照片读取失败，跳过', repo, p.path, e.message);
                }
            }
        }

        // 3. 建 blob（照片 + HTML 分批，避免一次太大）
        const base = await api.getRef(owner, this.REPO, 'heads/main');
        const commit = await api.getCommit(owner, this.REPO, base.object.sha);

        for (const f of files) {
            let bin = '';
            const u8 = f.bytes, CH = 0x8000;
            for (let i = 0; i < u8.length; i += CH) {
                bin += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
            }
            const bl = await api.createBlob(owner, this.REPO, btoa(bin), 'base64');
            tree.push({ path: f.path, mode: '100644', type: 'blob', sha: bl.sha });
            f.photo.pub = f.path.replace('files/', '');
            nPhoto++;
        }

        // 4. HTML（照片路径已回填 pub）
        const html = this.buildHTML(data, days, opt);
        let hb = '';
        const hu = new TextEncoder().encode(html);
        for (let i = 0; i < hu.length; i += 0x8000) {
            hb += String.fromCharCode.apply(null, hu.subarray(i, i + 0x8000));
        }
        const hbl = await api.createBlob(owner, this.REPO, btoa(hb), 'base64');
        tree.push({ path: 'index.html', mode: '100644', type: 'blob', sha: hbl.sha });
        tree.push({
            path: '.nojekyll', mode: '100644', type: 'blob',
            sha: (await api.createBlob(owner, this.REPO, btoa(''), 'base64')).sha
        });

        const newTree = await api.createTree(owner, this.REPO, tree, commit.tree.sha);
        const nc = await api.createCommit(owner, this.REPO,
            `更新学习记录一览（${days.length} 天${nPhoto ? `，${nPhoto} 张照片` : ''}）`,
            newTree.sha, [base.object.sha]);
        await api.updateRef(owner, this.REPO, 'heads/main', nc.sha);

        /*
         * 5. 开 Pages
         *
         * ★ body 要传对象，不能自己 JSON.stringify ——
         *   api.request 内部已经 stringify 一次，外面再套一层会变成
         *   双重编码，服务器收到的是字符串而不是对象，直接 400。
         *   （而且原来只 warn 不上报，失败了根本看不出来。）
         */
        let pagesOn = false;
        try {
            const cur = await api.request(`/repos/${owner}/${this.REPO}/pages`);
            pagesOn = !!(cur && cur.html_url);
        } catch (e) { /* 还没开，下面开 */ }

        if (!pagesOn) {
            try {
                await api.request(`/repos/${owner}/${this.REPO}/pages`, {
                    method: 'POST',
                    body: { source: { branch: 'main', path: '/' } }
                });
                pagesOn = true;
            } catch (e) {
                if (e.status === 409) pagesOn = true;   // 已存在，算成功
                else console.warn('Pages 开启失败：', e.status, e.message);
            }
        }
        if (!pagesOn) {
            console.warn('Pages 没能自动开启，需要去仓库 Settings → Pages 手动开一次');
        }

        return {
            url: `https://${owner}.github.io/${this.REPO}/`,
            photos: nPhoto,
            days: days.length
        };
    }
};
