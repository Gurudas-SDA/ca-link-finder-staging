/* Minimal CDP client over Node's global WebSocket (own copy for bench/perf —
   bench/mem/cdp.cjs belongs to a parallel measurement and is left untouched).
   Needed because Playwright's CDPSession cannot attach to Worker targets and
   because HeapProfiler.takeHeapSnapshot streams chunks we want to write to
   disk without buffering the whole snapshot as one JS string. */
const http = require('http');

function httpJson(port, path) {
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path }, res => {
            let b = ''; res.on('data', d => b += d);
            res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
        }).on('error', reject);
    });
}

class Cdp {
    constructor(ws) {
        this.ws = ws; this.id = 0; this.waiters = new Map();
        this.listeners = [];
    }

    static async connect(port, tries = 40) {
        let v = null;
        for (let i = 0; i < tries; i++) {
            try { v = await httpJson(port, '/json/version'); break; }
            catch (e) { await new Promise(r => setTimeout(r, 250)); }
        }
        if (!v) throw new Error('CDP endpoint not reachable on port ' + port);
        const ws = new WebSocket(v.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
        const c = new Cdp(ws);
        ws.onmessage = ev => {
            const m = JSON.parse(ev.data);
            if (m.id && c.waiters.has(m.id)) {
                const w = c.waiters.get(m.id); c.waiters.delete(m.id);
                m.error ? w.rej(new Error(m.error.message)) : w.res(m.result);
            } else if (m.method) {
                for (const fn of c.listeners) fn(m);
            }
        };
        return c;
    }

    on(fn) { this.listeners.push(fn); }

    send(method, params = {}, sessionId, timeoutMs = 120000) {
        const id = ++this.id;
        const msg = { id, method, params };
        if (sessionId) msg.sessionId = sessionId;
        this.ws.send(JSON.stringify(msg));
        return new Promise((res, rej) => {
            this.waiters.set(id, { res, rej });
            setTimeout(() => {
                if (this.waiters.has(id)) { this.waiters.delete(id); rej(new Error('CDP timeout: ' + method)); }
            }, timeoutMs);
        });
    }

    async targets() { return (await this.send('Target.getTargets')).targetInfos; }

    async attach(pred) {
        const infos = await this.targets();
        const t = infos.find(pred);
        if (!t) return null;
        const { sessionId } = await this.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
        return { sessionId, info: t };
    }

    close() { try { this.ws.close(); } catch (e) {} }
}

module.exports = { Cdp, httpJson };
