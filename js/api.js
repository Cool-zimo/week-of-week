/**
 * GitHub API 封装（与 GitHub Drive 同一套做法）
 *
 * 只保留 WEEK OF WEEK 用得到的部分：
 *   - 建仓库 / 读文件 / 写文件（带 sha 防冲突）
 *   - blob + tree + commit 批量上传（照片用）
 *   - 读 blob（照片回显）
 */
class GitHubAPI {
    constructor(token) {
        this.token = token;
        this.baseUrl = 'https://api.github.com';
    }

    async request(endpoint, options = {}) {
        const url = endpoint.startsWith('http') ? endpoint : this.baseUrl + endpoint;
        const headers = {
            'Authorization': `token ${this.token}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            ...options.headers
        };
        let body = options.body;
        if (body && !options.rawBody) {
            headers['Content-Type'] = 'application/json';
            body = JSON.stringify(body);
        }
        const res = await fetch(url, { method: options.method || 'GET', headers, body });
        if (!res.ok) {
            let msg = res.statusText;
            try {
                const j = await res.json();
                if (j && j.message) msg = j.message;
            } catch (e) { /* 非 JSON 响应 */ }
            const err = new Error(msg);
            err.status = res.status;
            throw err;
        }
        if (res.status === 204) return null;
        return await res.json();
    }

    async getMe() { return await this.request('/user'); }

    async getRepository(owner, repo) {
        return await this.request(`/repos/${owner}/${repo}`);
    }

    async createRepository(name, options = {}) {
        return await this.request('/user/repos', {
            method: 'POST',
            body: {
                name,
                description: options.description || '',
                private: options.private !== false,
                auto_init: options.autoInit !== false
            }
        });
    }

    /** 读文本文件内容，同时返回 sha（用于后续更新防冲突） */
    async getFile(owner, repo, path, branch = 'main') {
        const enc = encodeURIComponent(path).replace(/%2F/g, '/');
        return await this.request(`/repos/${owner}/${repo}/contents/${enc}?ref=${branch}`);
    }

    /** 文件不存在时返回 null，而不是抛异常 */
    async getFileOrNull(owner, repo, path, branch = 'main') {
        try { return await this.getFile(owner, repo, path, branch); }
        catch (e) {
            if (e.status === 404) return null;
            throw e;
        }
    }

    /** 二进制读取（照片回显） */
    async getFileRaw(owner, repo, path, branch = 'main') {
        const enc = encodeURIComponent(path).replace(/%2F/g, '/');
        const url = `${this.baseUrl}/repos/${owner}/${repo}/contents/${enc}?ref=${branch}`;
        const res = await fetch(url, {
            headers: {
                'Authorization': `token ${this.token}`,
                'Accept': 'application/vnd.github.raw',
                'X-GitHub-Api-Version': '2022-11-28'
            }
        });
        if (!res.ok) {
            const err = new Error(res.statusText);
            err.status = res.status;
            throw err;
        }
        return await res.arrayBuffer();
    }

    async putFile(owner, repo, path, contentBase64, message, branch = 'main', sha = null) {
        const enc = encodeURIComponent(path).replace(/%2F/g, '/');
        const body = { message, content: contentBase64, branch };
        if (sha) body.sha = sha;
        return await this.request(`/repos/${owner}/${repo}/contents/${enc}`, {
            method: 'PUT', body
        });
    }

    // ── Git Data API：批量提交（照片一次 tree + commit）──
    async getRef(owner, repo, ref = 'heads/main') {
        return await this.request(`/repos/${owner}/${repo}/git/ref/${ref}`);
    }
    async getCommit(owner, repo, sha) {
        return await this.request(`/repos/${owner}/${repo}/git/commits/${sha}`);
    }
    async createBlob(owner, repo, content, encoding = 'base64') {
        return await this.request(`/repos/${owner}/${repo}/git/blobs`, {
            method: 'POST', body: { content, encoding }
        });
    }
    async createTree(owner, repo, tree, baseTree = null) {
        const body = { tree };
        if (baseTree) body.base_tree = baseTree;
        return await this.request(`/repos/${owner}/${repo}/git/trees`, {
            method: 'POST', body
        });
    }
    async createCommit(owner, repo, message, tree, parents = []) {
        return await this.request(`/repos/${owner}/${repo}/git/commits`, {
            method: 'POST', body: { message, tree, parents }
        });
    }
    async updateRef(owner, repo, ref, sha) {
        return await this.request(`/repos/${owner}/${repo}/git/refs/${ref}`, {
            method: 'PATCH', body: { sha }
        });
    }

    async deleteFile(owner, repo, path, message, branch = 'main', sha) {
        const enc = encodeURIComponent(path).replace(/%2F/g, '/');
        return await this.request(`/repos/${owner}/${repo}/contents/${enc}`, {
            method: 'DELETE', body: { message, sha, branch }
        });
    }
}
