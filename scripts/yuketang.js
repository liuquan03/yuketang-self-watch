// 卧床看课助手 —— 在屏幕上开一个浏览器窗口播放雨课堂视频：
//   视频暂停了自动点播放，播完了自动点"下一节"，
//   "继续观看/我知道了"这类确认弹窗自动点掉，
//   作业页只在用户明确要求后打开，必须由用户本人作答和提交。
// 注意：脚本绝不快进、绝不倍速 —— 时间轴必须真实走过，用户是真的在看。
const { chromium } = require('playwright-core');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const PORT = 7862;
const START_URL =
  process.argv[2] ||
  'https://www.yuketang.cn/v2/web/index';
const USER_DATA = path.join(__dirname, 'user-data');
const TOKEN_FILE = path.join(__dirname, 'control-token');
const CONTROL_TOKEN = crypto.randomBytes(32).toString('hex');
const MAX_BODY_BYTES = 8192;
const PRESENCE_TTL_MS = 2000 * 60 * 1000;
const NOTICE = ['继续观看', '继续学习', '我知道了', '知道了'];

function isAllowedUrl(value) {
  try {
    const u = new URL(value);
    return (
      u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      (u.hostname === 'yuketang.cn' || u.hostname.endsWith('.yuketang.cn'))
    );
  } catch {
    return false;
  }
}

if (!isAllowedUrl(START_URL)) {
  throw new Error('起始地址必须是 https://yuketang.cn 或其子域名');
}

fs.writeFileSync(TOKEN_FILE, CONTROL_TOKEN + '\n', { mode: 0o600 });
fs.chmodSync(TOKEN_FILE, 0o600);

const t = () => new Date().toLocaleTimeString('zh-CN');
const log = (...a) => console.log(`[${t()}]`, ...a);

const state = {
  phase: 'starting', // starting | login | ready | watching | popup | homework | presence | blocked
  loginOk: false,
  url: '',
  title: '',
  video: null,
  popup: null,
  lastAction: '启动中',
  lastNextAt: 0,
  manualMode: null,
  lastVideoUrl: '',
  presenceUntil: Date.now() + PRESENCE_TTL_MS,
  startedAt: new Date().toISOString(),
};

// ---------- 页面侧：检测（每次重新查找，无跨次引用） ----------
async function inspect() {
  return page.evaluate((notices) => {
    const vis = (e) => !!(e && (e.offsetParent || e.getClientRects().length));
    const txt = (e) => (e.textContent || '').trim().replace(/\s+/g, ' ');
    const out = { notices: [], question: null, video: null };

    const clickables = [...document.querySelectorAll('button, [role=button], a.btn, .btn')];

    // 1) 单按钮提示层：继续观看 / 继续学习 / 我知道了 …
    for (const n of notices) {
      if (clickables.some((e) => vis(e) && txt(e) === n)) out.notices.push(n);
    }

    // 2) 弹题：可见"提交/确定"按钮 + 同容器内 >=2 个短选项
    const submits = clickables.filter(
      (e) => vis(e) && /^(提交|提交答案|确定)$/.test(txt(e))
    );
    for (const s of submits) {
      let root = s;
      for (let i = 0; i < 10 && root.parentElement; i++) {
        root = root.parentElement;
        const opts = [
          ...root.querySelectorAll(
            'li, label, [class*="option" i], [class*="choice" i], [class*="answer" i]'
          ),
        ].filter((e) => vis(e) && txt(e) && txt(e).length <= 120 && e !== s);
        if (opts.length >= 2 && opts.length <= 12) {
          out.question = {
            text: txt(root).slice(0, 300),
            options: opts.map((o) => txt(o).slice(0, 100)),
            submitText: txt(s),
          };
          break;
        }
      }
      if (out.question) break;
    }

    // 3) 视频
    const v = document.querySelector('video');
    out.video = v
      ? {
          paused: v.paused,
          ended:
            v.ended ||
            (Number.isFinite(v.duration) && v.duration > 0 && v.currentTime >= v.duration - 0.75),
          time: Math.round(v.currentTime),
          dur: Math.round(v.duration || 0),
          muted: v.muted,
          rate: v.playbackRate,
        }
      : null;

    out.title = document.title;
    return out;
  }, NOTICE);
}

// ---------- 页面侧：动作 ----------
function pageSide() {
  // 公共工具在每个函数里各写一份（函数会被序列化进页面，不能引用外部作用域）
}

async function clickNotice(name) {
  return page.evaluate((n) => {
    const vis = (e) => !!(e && (e.offsetParent || e.getClientRects().length));
    const txt = (e) => (e.textContent || '').trim();
    const el = [...document.querySelectorAll('button, [role=button], a.btn, .btn')].find(
      (e) => vis(e) && txt(e) === n
    );
    if (!el) return false;
    el.click();
    return true;
  }, name);
}

async function resumePlay() {
  return page.evaluate(() => {
    const v = document.querySelector('video');
    if (!v) return false;
    v.defaultPlaybackRate = 1;
    v.playbackRate = 1;
    const p = v.play();
    if (p && p.catch) p.catch(() => {});
    return true;
  });
}

async function pausePlay() {
  return page.evaluate(() => {
    const v = document.querySelector('video');
    if (!v) return false;
    v.pause();
    return true;
  });
}

async function clickNext() {
  return page.evaluate(() => {
    const vis = (e) => !!(e && (e.offsetParent || e.getClientRects().length));
    const txt = (e) => (e.textContent || '').trim().replace(/\s+/g, ' ');

    // 只接受目录中明确标注为“视频”的下一项；不猜测、不进入作业或考试。
    const leaves = [...document.querySelectorAll('.leaf-item')].filter(vis);
    const idx = leaves.findIndex((e) => /(^| )is-active( |$)/.test(e.className + ''));
    if (idx >= 0) {
      const skipped = [];
      for (let j = idx + 1; j < leaves.length; j++) {
        const tagEl = leaves[j].querySelector('.leaf-item-tag');
        const tag = tagEl ? tagEl.textContent.trim() : '';
        const title = txt(leaves[j].querySelector('.leaf-item-title') || leaves[j]).slice(0, 40);
        if (tag === '视频') {
          if (skipped.length) window.__skippedItems = skipped;
          leaves[j].click();
          return '目录:' + title + (skipped.length ? '（已跳过: ' + skipped.join('、') + '）' : '');
        }
        skipped.push(tag + title);
      }
      return 'NO_MORE:本课目录已到末尾' + (skipped.length ? '（后面只剩: ' + skipped.join('、') + '）' : '');
    }

    return null;
  });
}

async function clickNextHomework() {
  return page.evaluate(() => {
    const vis = (e) => !!(e && (e.offsetParent || e.getClientRects().length));
    const txt = (e) => (e.textContent || '').trim().replace(/\s+/g, ' ');
    const leaves = [...document.querySelectorAll('.leaf-item')].filter(vis);
    const idx = leaves.findIndex((e) => /(^| )is-active( |$)/.test(e.className + ''));

    for (let j = idx >= 0 ? idx + 1 : 0; j < leaves.length; j++) {
      const tagEl = leaves[j].querySelector('.leaf-item-tag');
      const tag = tagEl ? txt(tagEl) : '';
      if (!/\u4f5c\u4e1a/.test(tag) || /\u8003\u8bd5|\u6d4b\u9a8c/.test(tag)) continue;
      const title = txt(leaves[j].querySelector('.leaf-item-title') || leaves[j]).slice(0, 80);
      leaves[j].click();
      return '\u4f5c\u4e1a:' + title;
    }

    return null;
  });
}

async function returnToVideo() {
  if (!state.lastVideoUrl || !isAllowedUrl(state.lastVideoUrl)) return false;
  await page.goto(state.lastVideoUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  return true;
}

// ---------- 自动脉航 ----------
let busy = false;
async function tick() {
  if (busy) return;
  busy = true;
  try {
    const currentIsVideo = isAllowedUrl(page.url()) && new URL(page.url()).pathname.includes('/video/');
    if (!state.manualMode && !currentIsVideo) {
      const videoPage = [...ctx.pages()]
        .reverse()
        .find((p) => !p.isClosed() && isAllowedUrl(p.url()) && new URL(p.url()).pathname.includes('/video/'));
      if (videoPage) {
        page = videoPage;
        log('已自动切换到视频标签页:', page.url());
      }
    }
    if (!isAllowedUrl(page.url())) {
      state.phase = 'blocked';
      state.url = page.url();
      state.lastAction = '已阻止：当前页不是雨课堂安全域名';
      return;
    }
    const s = await inspect();
    state.url = page.url();
    state.title = s.title;
    state.video = s.video;

    if (!state.loginOk) {
      const u = state.url, ti = state.title || '';
      const onYuketang = /yuketang\.cn/.test(u);
      const looksLogin = /\/web\/\?next|login/i.test(u) || ti.includes('登录');
      if (onYuketang && !looksLogin) {
        state.loginOk = true;
        log('✔ 检测到已登录');
      }
    }

    if (state.manualMode === 'homework') {
      await pausePlay();
      state.phase = 'homework';
      state.popup = s.question;
      state.lastAction = s.question
        ? '作业页已检测到题目；请本人在页面中作答和提交'
        : '作业辅助模式；请本人在页面中操作';
      return;
    }

    if (s.question) {
      state.phase = 'popup';
      await pausePlay();
      if (!state.popup || state.popup.text !== s.question.text) {
        log('⛔ 出现弹题，已暂停等待作答：', s.question.text.slice(0, 80));
      }
      state.popup = s.question;
      state.lastAction = '检测到题目，已暂停；请本人在页面中完成';
    } else {
      state.popup = null;
      if (s.notices.length) {
        const n = s.notices[0];
        const ok = await clickNotice(n);
        state.lastAction = (ok ? '已点提示「' : '点提示失败「') + n + '」';
        if (ok) log('ℹ 自动点击提示：', n);
      } else if (s.video && !s.video.ended) {
        state.phase = 'watching';
        if (s.video.rate !== 1) await page.evaluate(() => {
          const v = document.querySelector('video');
          if (v) v.playbackRate = 1;
        });
        if (Date.now() > state.presenceUntil) {
          await pausePlay();
          state.phase = 'presence';
          state.lastAction = '在场确认已过期，视频已暂停';
          return;
        }
        if (s.video.paused) {
          await resumePlay();
          state.lastAction = '自动恢复播放';
        } else {
          state.lastAction =
            '播放中 ' + s.video.time + '/' + s.video.dur + 's' + (s.video.muted ? '（静音）' : '');
        }
      } else if (s.video && s.video.ended) {
        state.phase = 'watching';
        if (Date.now() > state.presenceUntil) {
          state.phase = 'presence';
          state.lastAction = '在场确认已过期，未进入下一节';
          return;
        }
        if (Date.now() - state.lastNextAt > 8000) {
          state.lastNextAt = Date.now();
          const r = await clickNext();
          state.lastAction = r ? '已点下一节（' + r + '）' : '视频结束但没找到"下一节"，请告知';
          log(r ? '⏭ 自动进入下一节：' + r : '⚠ 未找到下一节按钮');
        }
      } else {
        state.phase = state.loginOk ? 'ready' : 'login';
        state.lastAction = state.loginOk ? '空闲（没有检测到视频）' : '等待登录';
      }
    }
  } catch (e) {
    state.lastAction = 'tick错误: ' + (e.message || e).slice(0, 120);
  } finally {
    busy = false;
  }
}

// ---------- 本地控制接口（仅 127.0.0.1） ----------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        const e = new Error('request body too large');
        e.statusCode = 413;
        reject(e);
        req.removeAllListeners('data');
        req.resume();
        return;
      }
      b += c;
    });
    req.on('end', () => {
      try {
        resolve(b ? JSON.parse(b) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

async function handle(req, res) {
  const u = new URL(req.url, 'http://127.0.0.1');
  const send = (obj) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(JSON.stringify(obj, null, 2));
  };
  try {
    if (!['127.0.0.1:7862', 'localhost:7862'].includes(req.headers.host || '')) {
      res.statusCode = 403;
      return send({ err: 'forbidden host' });
    }
    if (req.headers.origin) {
      res.statusCode = 403;
      return send({ err: 'browser-origin requests are not allowed' });
    }
    if (!safeEqual(req.headers['x-yuketang-token'], CONTROL_TOKEN)) {
      res.statusCode = 401;
      return send({ err: 'unauthorized' });
    }
    if (u.pathname === '/status' && req.method === 'GET') {
      const s = { ...state };
      if (s.popup) s.popup = { ...s.popup, text: s.popup.text.slice(0, 200) };
      s.presenceRemainingSeconds = Math.max(0, Math.round((state.presenceUntil - Date.now()) / 1000));
      return send(s);
    }
    if (u.pathname === '/presence' && req.method === 'POST') {
      state.presenceUntil = Date.now() + PRESENCE_TTL_MS;
      state.lastAction = '已确认本人在场（20分钟）';
      return send({ ok: true, presenceMinutes: 20 });
    }
    if (u.pathname === '/next' && req.method === 'POST') {
      if (Date.now() > state.presenceUntil) {
        res.statusCode = 409;
        return send({ ok: false, err: 'presence confirmation expired' });
      }
      const r = await clickNext();
      state.lastNextAt = Date.now();
      return send({ ok: !!r, detail: r });
    }
    if (u.pathname === '/homework' && req.method === 'POST') {
      const currentUrl = page.url();
      if (isAllowedUrl(currentUrl) && new URL(currentUrl).pathname.includes('/video/')) {
        state.lastVideoUrl = currentUrl;
      }
      const r = await clickNextHomework();
      if (!r) {
        res.statusCode = 404;
        return send({ ok: false, err: '没有找到目录中明确标注为作业的下一项' });
      }
      state.manualMode = 'homework';
      state.phase = 'homework';
      state.lastAction = '已打开' + r + '；等待本人作答和提交';
      return send({ ok: true, detail: r });
    }
    if (u.pathname === '/study' && req.method === 'POST') {
      const r = await returnToVideo();
      if (!r) {
        res.statusCode = 409;
        return send({ ok: false, err: '没有可返回的视频页' });
      }
      state.manualMode = null;
      state.lastAction = '已返回视频学习';
      return send({ ok: true, url: state.lastVideoUrl });
    }
    if (u.pathname === '/pause' && req.method === 'POST') {
      const r = await pausePlay();
      return send({ ok: r });
    }
    if (u.pathname === '/play' && req.method === 'POST') {
      if (Date.now() > state.presenceUntil) {
        res.statusCode = 409;
        return send({ ok: false, err: 'presence confirmation expired' });
      }
      const r = await resumePlay();
      return send({ ok: r });
    }
    if (u.pathname === '/clicknotice' && req.method === 'POST') {
      const b = await readBody(req);
      const name = b.name || '继续观看';
      if (!NOTICE.includes(name)) return send({ ok: false, err: 'notice not allowed' });
      const r = await clickNotice(name);
      return send({ ok: r });
    }
    if (u.pathname === '/stop' && req.method === 'POST') {
      send({ ok: true });
      ctx.close().catch(() => {});
      setTimeout(() => process.exit(0), 500);
      return;
    }
    send({ err: 'unknown ' + req.method + ' ' + u.pathname });
  } catch (e) {
    if (!res.headersSent) res.statusCode = e.statusCode || 500;
    send({ err: (e.message || String(e)).slice(0, 300) });
  }
}

// ---------- 启动 ----------
let ctx, page;
(async () => {
  let channel = 'msedge';
  try {
    ctx = await chromium.launchPersistentContext(USER_DATA, {
      channel,
      headless: false,
      viewport: null,
      args: ['--start-maximized', '--autoplay-policy=no-user-gesture-required', '--lang=zh-CN'],
    });
  } catch (e) {
    log('Edge 启动失败，改用 Chrome：', (e.message || '').slice(0, 120));
    channel = 'chrome';
    ctx = await chromium.launchPersistentContext(USER_DATA, {
      channel,
      headless: false,
      viewport: null,
      args: ['--start-maximized', '--autoplay-policy=no-user-gesture-required', '--lang=zh-CN'],
    });
  }
  page = ctx.pages().find((p) => isAllowedUrl(p.url())) || ctx.pages()[0] || (await ctx.newPage());
  page.on('pageerror', (err) => log('[页面脚本错误]', String(err).slice(0, 150)));

  // 只跟随最终导航到雨课堂安全域名的新标签页。
  ctx.on('page', (p) => {
    log('🆕 检测到新标签页:', p.url());
    p.on('pageerror', (err) => log('[页面脚本错误]', String(err).slice(0, 150)));
    p.on('domcontentloaded', () => {
      if (isAllowedUrl(p.url())) {
        page = p;
        log('已跟随雨课堂新标签页:', p.url());
      } else {
        log('已忽略非雨课堂标签页:', p.url());
      }
    });
    p.on('close', () => {
      const rest = ctx.pages().filter((x) => !x.isClosed() && isAllowedUrl(x.url()));
      if (page === p || page.isClosed()) {
        page = rest[rest.length - 1] || page;
        log('标签页关闭，切回:', page.url());
      }
    });
  });

  const server = http.createServer(handle);
  server.headersTimeout = 5000;
  server.requestTimeout = 10000;
  server.listen(PORT, '127.0.0.1', () => {
    log(`助手已启动（浏览器: ${channel}，窗口应该已在你屏幕上打开）`);
    log(`控制接口: http://127.0.0.1:${PORT}/status`);
    log(`控制令牌文件: ${TOKEN_FILE}`);
    log('安全模式：视频仅1x；作业页需明确命令打开且由本人作答、提交');
    log('即将打开:', START_URL);
  });
  server.on('error', (e) => log('控制接口监听失败:', e.message));

  await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch((e) => {
    log('打开页面失败:', e.message);
  });
  await page.waitForLoadState({ state: 'domcontentloaded' }).catch(() => {});
  log('页面已打开:', page.url(), '|', '如果看到登录二维码，请用手机扫码');

  setInterval(tick, 2000);
  process.on('uncaughtException', (e) => log('未捕获异常:', e.message));
})();
