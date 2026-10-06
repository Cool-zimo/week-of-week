/**
 * 照片：压缩 → 上传 → 回显
 *
 * 存储方式与 GitHub Drive 完全一致：Git Data API（blob + tree + commit），
 * 一次提交放多张照片，而不是每张三四次请求。
 *
 * ★ 必须先压缩。手机随手一拍 4~8MB，原样传上去：
 *     - 仓库很快涨到几百 MB（GitHub 单仓建议 1GB）
 *     - 每次同步都要拉一大坨 base64，慢
 *   压到长边 1600px / 质量 0.82，实测 5.2MB → 约 380KB，肉眼看不出区别。
 */
const Photos = {
    MAX_EDGE: 1600,
    QUALITY: 0.82,

    /**
     * 读取并压缩一张图片
     * @returns {Promise<{arrayBuffer:ArrayBuffer, w:number, h:number, name:string, size:number}>}
     */
    async compress(file) {
        const bitmap = await this._decode(file);
        let { width: w, height: h } = bitmap;
        const scale = Math.min(1, this.MAX_EDGE / Math.max(w, h));
        const tw = Math.round(w * scale), th = Math.round(h * scale);

        const canvas = document.createElement('canvas');
        canvas.width = tw; canvas.height = th;
        const ctx = canvas.getContext('2d');
        // JPEG 没有 alpha，透明区会变黑 —— 先铺白底
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, tw, th);
        ctx.drawImage(bitmap, 0, 0, tw, th);
        if (bitmap.close) bitmap.close();

        const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', this.QUALITY));
        if (!blob) throw new Error('图片处理失败：' + file.name);
        const arrayBuffer = await blob.arrayBuffer();
        return { arrayBuffer, w: tw, h: th, name: file.name, size: blob.size };
    },

    async _decode(file) {
        // createImageBitmap 更快，但部分浏览器对 HEIC 不支持，回退到 <img>
        if (window.createImageBitmap) {
            try { return await createImageBitmap(file); } catch (e) { /* 回退 */ }
        }
        const url = URL.createObjectURL(file);
        try {
            const img = new Image();
            await new Promise((res, rej) => {
                img.onload = res;
                img.onerror = () => rej(new Error('无法读取图片：' + file.name));
                img.src = url;
            });
            return img;
        } finally {
            URL.revokeObjectURL(url);
        }
    },

    /** Uint8Array → base64（分块，避免大数组 apply 爆栈） */
    toBase64(u8) {
        let out = '';
        const CH = 0x8000;
        for (let i = 0; i < u8.length; i += CH) {
            out += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
        }
        return btoa(out);
    },

    /**
     * 批量上传照片到 wow-data/photos/<dateKey>/
     * @returns {Promise<Array<{path,w,h,name,size}>>}
     */
    /**
     * 只压缩，不上传。
     * ★ 拆出来是为了先知道总共多大 —— 分配仓库必须提前算，
     *   等传完了才发现超容就晚了。
     */
    async pack(files, onProgress) {
        const out = [];
        for (let i = 0; i < files.length; i++) {
            const c = await this.compress(files[i]);
            c.base64 = this.toBase64(new Uint8Array(c.arrayBuffer));
            out.push(c);
            if (onProgress) onProgress(Math.round((i + 1) / files.length * 100));
        }
        return out;
    },

    async upload(api, owner, repo, dateKey, packed, onProgress) {
        const results = [];
        // 并发上限 4：照片不大但 base64 后有内存开销，稳妥些
        const CONC = 4;
        for (let i = 0; i < packed.length; i += CONC) {
            const batch = packed.slice(i, i + CONC);
            for (const p of batch) {
                if (!p.path) {
                    p.path = `photos/${dateKey}/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}.jpg`;
                }
            }
            if (onProgress) onProgress(Math.round((i + batch.length) / packed.length * 100));

            // 一次 tree + commit 提交这批
            const ref = await api.getRef(owner, repo, 'heads/main');
            const commit = await api.getCommit(owner, repo, ref.object.sha);
            const blobs = await Promise.all(packed.map(p =>
                api.createBlob(owner, repo, p.base64, 'base64')));
            const tree = packed.map((p, j) => ({
                path: p.path, mode: '100644', type: 'blob', sha: blobs[j].sha
            }));
            const newTree = await api.createTree(owner, repo, tree, commit.tree.sha);
            const newCommit = await api.createCommit(owner, repo,
                `粥粥记录 ${dateKey} 照片 ×${packed.length}`, newTree.sha, [ref.object.sha]);
            await api.updateRef(owner, repo, 'heads/main', newCommit.sha);

            for (const p of packed) {
                results.push({ path: p.path, w: p.w, h: p.h, name: p.name, size: p.size });
            }
        }
        return results;
    },

    /** 私有仓库不能直接用 raw 链接当 src，必须带 token 取回来转成 blob URL */
    async loadURL(api, owner, repo, path) {
        const ab = await api.getFileRaw(owner, repo, path);
        const blob = new Blob([ab], { type: 'image/jpeg' });
        return URL.createObjectURL(blob);
    }
};
