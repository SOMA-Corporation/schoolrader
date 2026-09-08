/*
 * 로컬 서버 — 이제는 "확인용"이 아니라 이 프로젝트의 실행 방식이다.
 *
 *   node dev.js   →  http://localhost:3000
 *
 * 받은 파일을 프로젝트 폴더(vault/)에 쌓고, 거기서 클로드코드가 리포트를 만들고,
 * 만든 PDF 를 다시 웹이 보여 준다. 이 셋 다 디스크에 쓰거나 프로세스를 띄우는
 * 일이라 Vercel 서버리스에서는 동작하지 않는다 — 그래서 로컬로 돈다.
 * (api/schoolinfo.js · api/gongsi.js 는 그대로 서버리스 형태를 지킨다.)
 */
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

/* .env 를 먼저 읽는다 — api/*.js 가 require 되는 순간 process.env 를 보기 때문에
   그 전에 채워 넣어야 한다. 의존성을 늘리지 않으려고 직접 판다(형식이 단순하다).
   이미 셸에 있는 값은 덮어쓰지 않는다 — 그쪽이 더 명시적인 지정이다. */
(function loadEnv(){
  try {
    for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m || line.trimStart().startsWith('#')) continue;
      const v = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
      if (v && process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  } catch {}                       // .env 가 없어도 돈다 — 키가 필요한 기능만 꺼진다
})();

const HANDLERS = {
  '/api/schoolinfo': require('./api/schoolinfo.js'),
  '/api/gongsi': require('./api/gongsi.js'),
  '/api/vault': require('./api/vault.js'),      // 로컬 전용 — 디스크에 쓴다
  '/api/report': require('./api/report.js'),    // 로컬 전용 — 클로드코드를 띄운다
};

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const VAULT = path.join(__dirname, 'vault');

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
                '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml',
                '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
                '.pdf': 'application/pdf', '.csv': 'text/csv; charset=utf-8',
                '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
                '.xls': 'application/vnd.ms-excel',
                '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };

/* 브라우저 안에서 바로 열어 볼 수 있는 것만 inline — 나머지는 내려받게 둔다.
   PDF 를 inline 으로 줘야 vault.html 의 <iframe> 뷰어가 뜬다. */
const INLINE = new Set(['.pdf', '.png', '.svg', '.txt', '.md', '.csv', '.json', '.html']);

const send = (res, code, type, body) => {
  res.writeHead(code, { 'Content-Type': type });
  res.end(body);
};

/* named 는 저장소 파일에만 쓴다. 정적 자원(style.css · gate.js)에 Content-Disposition 을
   붙이면 브라우저가 스타일·스크립트로 안 읽고 내려받으려 할 수 있다. */
async function serveFile(res, full, { named, download } = {}) {
  let st;
  try {
    st = await fsp.stat(full);
    if (!st.isFile()) throw new Error('not a file');
  } catch {
    send(res, 404, 'text/plain; charset=utf-8', '없는 파일입니다.');
    return;
  }
  const ext = path.extname(full).toLowerCase();
  const headers = {
    'Content-Type': TYPES[ext] || 'application/octet-stream',
    'Content-Length': st.size,
    'Cache-Control': 'no-store',
  };
  if (named) {
    const inline = INLINE.has(ext) && !download;
    headers['Content-Disposition'] =
      `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(path.basename(full))}`;
  }
  res.writeHead(200, headers);
  fs.createReadStream(full).pipe(res);
}

/** 요청 경로가 base 안에 있는지 확인하고 절대경로를 돌려준다 (../ 차단) */
function resolveUnder(base, rel) {
  const full = path.resolve(base, decodeURIComponent(rel).replace(/^\/+/, ''));
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  return full;
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  /* ── API ── */
  const handler = HANDLERS[url.pathname];
  if (handler) {
    req.query = Object.fromEntries(url.searchParams);

    /* Vercel 은 본문을 알아서 모아 주지만 여기서는 직접 읽는다.
       파일 업로드가 지나가므로 **Buffer 그대로** 넘긴다 — 문자열로 바꾸면 바이너리가 깨진다.
       JSON·텍스트를 기대하는 기존 핸들러를 위해 그런 content-type 일 때만 문자열로 준다. */
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.body === undefined) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks);
      req.rawBody = raw;
      const ct = String(req.headers['content-type'] || '');
      req.body = /application\/json|text\/|application\/x-www-form-urlencoded/.test(ct)
        ? raw.toString('utf8') : raw;
    }

    res.status = c => { res.statusCode = c; return res; };
    res.json = o => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(o)); };
    res.send = b => res.end(b);

    try {
      await handler(req, res);
    } catch (e) {
      if (!res.headersSent) send(res, 500, 'application/json; charset=utf-8', JSON.stringify({ error: e.message }));
    }
    return;
  }

  /* ── 저장소 파일 ── /vault/{학교_연도}/raw/파일명 */
  if (url.pathname.startsWith('/vault/')) {
    const full = resolveUnder(VAULT, url.pathname.slice('/vault/'.length));
    if (!full) { send(res, 403, 'text/plain; charset=utf-8', '잘못된 경로입니다.'); return; }
    await serveFile(res, full, { named: true, download: url.searchParams.has('dl') });
    return;
  }

  /* ── 정적 ── */
  const file = url.pathname === '/' ? 'index.html' : url.pathname;
  const full = resolveUnder(PUBLIC, file);
  if (!full) { send(res, 403, 'text/plain; charset=utf-8', '잘못된 경로입니다.'); return; }
  await serveFile(res, full);
}).listen(PORT, () => {
  console.log(`[스쿨레이더] http://localhost:${PORT}`);
  console.log(`[저장소]     ${VAULT}`);
});
