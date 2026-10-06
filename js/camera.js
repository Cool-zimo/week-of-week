/**
 * 直接调摄像头拍照
 *
 * ★ 三条硬性前提，缺一不可：
 *   1. 页面必须是 HTTPS 或 localhost —— 浏览器只在安全上下文里给摄像头。
 *      GitHub Pages 是 HTTPS，所以线上能用；本地用 file:// 打开会直接失败。
 *   2. 用户点过按钮才调用 —— 不能进页面就弹权限，那样体验很差且常被拒。
 *   3. 关掉时必须 stop() 每一条 track —— 否则摄像头指示灯一直亮着，
 *      用户会以为被偷拍。这是隐私红线，不是细节。
 *
 * 为什么不用 <input capture="environment">：
 *   那只是"优先用后置摄像头"的文件选择，走的还是系统相机 App，
 *   拍完要确认、再回到页面，中间会离开应用。
 *   这里要的是"在页面里直接拍"—— 连续拍几张笔记不用切来切去。
 */
const Camera = {
    stream: null,
    video: null,
    facing: 'environment',   // 手机默认后置：拍笔记
    _onShot: null,

    supported() {
        return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    },

    /**
     * 打开取景器
     * @param {Function} onShot  收到 File 时回调
     */
    async open(onShot) {
        if (!this.supported()) {
            throw new Error('这个浏览器不支持直接调摄像头，可以用下面的「添加照片」选图片');
        }
        this._onShot = onShot;

        const box = document.getElementById('cam-modal');
        box.classList.remove('hidden');
        document.getElementById('cam-err').classList.add('hidden');
        document.getElementById('cam-shoot').disabled = true;
        document.getElementById('cam-msg').textContent = '正在打开摄像头…';

        await this._start();
    },

    async _start() {
        await this._stop();     // 切换前后摄像头前必须先停旧的

        const cons = {
            video: {
                facingMode: this.facing,
                width: { ideal: 1920 },
                height: { ideal: 1080 }
            },
            audio: false
        };
        try {
            this.stream = await navigator.mediaDevices.getUserMedia(cons);
        } catch (e) {
            /*
             * 常见失败：
             *   NotAllowedError  用户拒了 / 系统层面禁用
             *   NotFoundError    没有摄像头（台式机常见）
             *   OverconstrainedError  指定了后置但设备只有前置
             * 最后一种要降级重试，不能直接报错 —— 很多笔记本只有前置。
             */
            if (e.name === 'OverconstrainedError' && this.facing !== 'user') {
                this.facing = 'user';
                return await this._start();
            }
            throw this._friendly(e);
        }

        const v = document.getElementById('cam-video');
        this.video = v;
        v.srcObject = this.stream;
        try { await v.play(); } catch (e) { /* 部分浏览器自动播放 */ }

        await new Promise(r => {
            if (v.videoWidth) return r();
            v.onloadedmetadata = r;
            setTimeout(r, 3000);   // 兜底，别死等
        });

        document.getElementById('cam-shoot').disabled = false;
        document.getElementById('cam-msg').textContent = '';
        // 只有确实存在多个摄像头时才显示切换按钮
        try {
            const ds = await navigator.mediaDevices.enumerateDevices();
            const cams = ds.filter(d => d.kind === 'videoinput');
            document.getElementById('cam-flip').classList.toggle('hidden', cams.length < 2);
        } catch (e) { /* 拿不到设备列表就隐藏 */ }
    },

    _friendly(e) {
        const m = {
            NotAllowedError: '摄像头权限被拒绝了。去浏览器地址栏左边的图标里改成"允许"再试。',
            NotFoundError: '没找到摄像头。台式机的话先插一个；也可以用下面的「添加照片」。',
            NotReadableError: '摄像头被别的应用占用了，关掉那个应用再试。',
            OverconstrainedError: '摄像头不支持指定的参数。',
            SecurityError: '必须是 HTTPS 页面才能用摄像头。'
        };
        return new Error(m[e.name] || ('摄像头打开失败：' + (e.message || e.name)));
    },

    /** 拍照：从 video 抓一帧 → canvas → File */
    async shoot() {
        const v = this.video;
        if (!v || !v.videoWidth) { this._err('画面还没准备好'); return; }

        const w = v.videoWidth, h = v.videoHeight;
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(v, 0, 0, w, h);

        const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.92));
        if (!blob) { this._err('截图失败'); return; }

        // File 而不是 Blob：后面压缩流程统一按 File 处理，名字也要有
        const d = new Date();
        const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}` +
            `-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
        const file = new File([blob], `拍摄-${stamp}.jpg`, { type: 'image/jpeg' });

        if (this._onShot) this._onShot(file);
        this._flash();
    },

    _flash() {
        const f = document.getElementById('cam-flash');
        f.classList.remove('hidden');
        setTimeout(() => f.classList.add('hidden'), 180);
    },

    _err(msg) {
        const e = document.getElementById('cam-err');
        e.textContent = msg;
        e.classList.remove('hidden');
    },

    async flip() {
        this.facing = this.facing === 'environment' ? 'user' : 'environment';
        await this._start();
    },

    /** 关：必须停掉所有 track，摄像头灯才会灭 */
    async _stop() {
        if (this.stream) {
            this.stream.getTracks().forEach(t => t.stop());
            this.stream = null;
        }
        if (this.video) { this.video.srcObject = null; this.video = null; }
    },

    async close() {
        await this._stop();
        document.getElementById('cam-modal').classList.add('hidden');
        this._onShot = null;
    }
};
