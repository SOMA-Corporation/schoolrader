/*
 * 학교알리미 공시 원문 파일 받아오기 (Vercel 서버리스 함수)
 *
 * OpenAPI(/api/schoolinfo)에는 없는 것을 사이트 화면에서 직접 긁어 온다.
 *
 *   표 (TABLE_ACTS — 사이트 '엑셀저장'과 같은 산출물 .xls)
 *     club 동아리 · move 전출입 · enter 입학생 · paps 체력 · hours 수업시수 ·
 *     roster 학년별학급별 학생수 · special 특색사업 · freesem 자유학기(중) ·
 *     library 도서관 · counsel 상담 · meal 급식
 *   첨부 원본
 *     act=rule       학업성적관리규정 (.hwp/.hwpx/.pdf — 학교마다 다름)
 *     act=curriculum 학교교육과정 편성·운영 및 평가 (고·중은 편제표, 초등은 계획 책자)
 *     act=evalplan   교과별(학년별) 교수·학습 및 평가계획 — 첨부가 여러 개라 목록/개별 2단계
 *   성취도 (중·고만 — 초등은 이 공시항목 자체가 없다)
 *     act=achieve-start : 캡차 이미지 + 세션 반환
 *     act=achieve-solve : 사용자가 읽은 숫자를 받아 .xls 반환
 *
 * 학교급마다 있는 항목이 다르다. 없으면 404 로 알려 주고, 호출부는 나머지를 계속 받는다.
 *
 * 왜 서버에서 하나 — 학교알리미는 EUC-KR + 세션 쿠키 + CORS 미허용이라
 * 브라우저가 직접 부를 수 없다. 여기서 대신 부르고 파일만 내려 준다.
 *
 * 세션 유지 — 서버리스는 요청 간 상태가 없다. 캡차는 '이미지를 받은 세션'에서
 * 답을 내야 하므로, 쿠키·폼필드를 클라이언트에 잠깐 맡겼다가 되돌려받는다.
 * 공개 사이트의 임시 세션값이라 비밀이 아니지만, 되돌아온 값을 그대로 믿지 않도록
 * 요청 경로는 공시 프래그먼트 패턴으로 제한한다(아래 SAFE_PATH).
 */

const iconv = require('iconv-lite');

const BASE = 'https://www.schoolinfo.go.kr';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const DELAY = 250;                       // 사이트에 몰아치지 않을 정도의 간격
const SAFE_PATH = /^\/ei\/pp\/Pneipp_b\d+_s0p\.do$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ── EUC-KR 사이트라 쿼리스트링·폼바디를 EUC-KR 로 인코딩해야 한다(한글 파라미터가 섞인다) ── */
function qs(obj){
  return Object.entries(obj).map(([k, v]) => {
    const bytes = iconv.encode(String(v ?? ''), 'euc-kr');
    let out = '';
    for (const b of bytes) {
      const ch = String.fromCharCode(b);
      out += /[A-Za-z0-9\-_.!~*'()]/.test(ch) ? ch : '%' + b.toString(16).toUpperCase().padStart(2, '0');
    }
    return encodeURIComponent(k) + '=' + out;
  }).join('&');
}
function decode(buf){
  const head = buf.subarray(0, 2048).toString('latin1').toLowerCase();
  const m = head.match(/charset=["']?([\w-]+)/);
  return iconv.decode(buf, m && /utf-?8/.test(m[1]) ? 'utf-8' : 'euc-kr');
}

/* ── 쿠키 단지 (JSESSIONID 를 들고 다녀야 프래그먼트가 열린다) ── */
function makeSession(init){
  const jar = new Map(Object.entries(init || {}));
  const header = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const absorb = res => {
    for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
      const kv = c.split(';')[0], i = kv.indexOf('=');
      if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
    }
  };
  const common = () => ({ 'User-Agent': UA, Cookie: header(), Referer: BASE + '/Main.do' });
  return {
    cookies: () => Object.fromEntries(jar),
    async get(path, params){
      await sleep(DELAY);
      const res = await fetch(BASE + path + (params ? '?' + qs(params) : ''),
        { headers: common(), signal: AbortSignal.timeout(20000) });
      absorb(res);
      return { res, buf: Buffer.from(await res.arrayBuffer()) };
    },
    async post(path, data){
      await sleep(DELAY);
      const res = await fetch(BASE + path, {
        method: 'POST',
        headers: { ...common(), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: qs(data), signal: AbortSignal.timeout(25000),
      });
      absorb(res);
      return { res, buf: Buffer.from(await res.arrayBuffer()) };
    },
  };
}

/* ── HTML 파싱 (사이트가 넘겨주는 조각에서 폼/표만 뽑아낸다) ── */
function hiddenFields(formHtml){
  const out = {};
  for (const tag of formHtml.match(/<input[^>]*type=["']hidden["'][^>]*>/gi) || []) {
    const attrs = {}; const re = /(\w+)\s*=\s*["']([^"']*)["']/g; let m;
    while ((m = re.exec(tag))) attrs[m[1]] = m[2];
    if (attrs.name) out[attrs.name] = attrs.value ?? '';
  }
  return out;
}
function extractForm(html, id){
  const m = html.match(new RegExp(`<form[^>]*id=["']${id}["'][\\s\\S]*?</form>`));
  return m ? m[0] : null;
}
/* id 일치 div 의 innerHTML — 중첩 div 를 세면서 닫는 위치를 찾는다 */
function divInner(html, id){
  const m = html.match(new RegExp(`<div[^>]*id=["']${id}["'][^>]*>`));
  if (!m) return '';
  const start = m.index + m[0].length;
  let depth = 1;
  const re = /<div\b|<\/div>/g; re.lastIndex = start;
  let t;
  while ((t = re.exec(html))) {
    depth += t[0] === '</div>' ? -1 : 1;
    if (depth === 0) return html.slice(start, t.index);
  }
  return '';
}
function gongsiItems(html){
  const RE = /loadGongSi\('([^']*)',\s*'([^']*)',\s*'([^']*)',\s*'([^']*)',\s*'([^']*)',\s*'([^']*)',\s*'([^']*)',\s*'([^']*)'\)/g;
  const items = []; let m;
  while ((m = RE.exec(html))) items.push({
    url: m[1], GS_HANGMOK_CD: m[2], GS_HANGMOK_NO: m[3], GS_HANGMOK_NM: m[4],
    GS_BURYU_CD: m[5], JG_BURYU_CD: m[6], JG_HANGMOK_CD: m[7], JG_GUBUN: m[8],
  });
  return items;
}
/* 항목명 비교용 정규화 — 공백과 가운뎃점류를 지운다.
   학교알리미는 같은 자리를 '전·출입' · '전ㆍ출입' 처럼 다른 글자로 쓰는 데가 있어서
   공백만 지우면 학교에 따라 놓친다. 후보를 여러 개 받아 앞에서부터 찾는다. */
const normNm = s => String(s || '').replace(/[\s·ㆍ・･‧∙⋅]/g, '');
const findItem = (items, ...kws) => {
  for (const kw of kws.flat()) {
    const k = normNm(kw);
    const hit = items.find(i => normNm(i.GS_HANGMOK_NM).includes(k));
    if (hit) return hit;
  }
  return null;
};

/* ── 표(엑셀저장)로 받는 공시항목 ──
   전부 exportExcel 경로를 똑같이 탄다. 항목명 후보와 저장 파일명만 다르다.
   학교급마다 있는 항목이 달라서(초등에 자유학기제가 없는 식) 없으면 404 로 알려 준다 —
   호출부가 나머지 항목을 계속 받게 하려는 것이다.

   ※ 여기 이름은 학교알리미 화면의 공시항목 번호(4-나 같은 것)를 따르고,
     /api/schoolinfo 의 apiType 과는 무관한 축이다. 둘을 섞지 말 것. */
const TABLE_ACTS = {
  club:    { kws: ['동아리활동현황', '동아리'],        file: '동아리활동현황',     label: '동아리 활동 현황' },
  move:    { kws: ['전출입및학업중단', '전출입'],       file: '전출입및학업중단',   label: '전·출입 및 학업중단 학생 수' },
  enter:   { kws: ['입학생현황'],                      file: '입학생현황',         label: '입학생 현황' },
  paps:    { kws: ['학생의체력증진', '체력증진'],       file: '학생체력증진',       label: '학생의 체력 증진에 관한 사항' },
  hours:   { kws: ['수업일수및수업시수', '수업일수'],   file: '수업일수및수업시수', label: '수업일수 및 수업시수 현황' },
  roster:  { kws: ['학년별학급별학생수'],              file: '학년별학급별학생수', label: '학년별·학급별 학생수' },
  special: { kws: ['교육운영특색사업'],                file: '교육운영특색사업',   label: '교육운영 특색사업 계획' },
  freesem: { kws: ['자유학기제운영', '자유학기제'],     file: '자유학기제운영',     label: '자유학기제 운영에 관한 사항' },
  library: { kws: ['학교도서관현황', '학교도서관'],     file: '학교도서관현황',     label: '학교도서관 현황' },
  counsel: { kws: ['상담계획및실시'],                  file: '상담실시현황',       label: '학생·학부모 상담계획 및 실시 현황' },
  meal:    { kws: ['급식실시현황'],                    file: '급식실시현황',       label: '급식 실시 현황' },
};

const fragParams = (it, uuid, school, year) => ({
  GS_HANGMOK_CD: it.GS_HANGMOK_CD, GS_HANGMOK_NO: it.GS_HANGMOK_NO, GS_HANGMOK_NM: it.GS_HANGMOK_NM,
  GS_BURYU_CD: it.GS_BURYU_CD, JG_BURYU_CD: it.JG_BURYU_CD, JG_HANGMOK_CD: it.JG_HANGMOK_CD,
  JG_GUBUN: it.JG_GUBUN, JG_YEAR2: year, JG_YEAR: year, CHOSEN_JG_YEAR: year, PRE_JG_YEAR: year,
  HG_NM: school, SHL_IDF_CD: uuid, GS_TYPE: 'Y', SORT: 'BR', LOAD_TYPE: 'single',
});

async function openDetail(sess, uuid, year){
  await sess.get('/Main.do');
  const { buf } = await sess.get('/ei/ss/Pneiss_b01_s0.do', { SHL_IDF_CD: uuid, PRE_JG_YEAR: year });
  const items = gongsiItems(decode(buf));
  if (!items.length) throw new Error('학교알리미 상세 페이지에서 공시항목을 찾지 못했습니다.');
  return items;
}

/* 사이트의 '엑셀저장' 버튼과 같은 동작 — 화면의 표 HTML 을 그대로 되돌려 보내면 xls 로 만들어 준다 */
async function exportExcel(sess, frag){
  const form = extractForm(frag, 'excelprint');
  if (!form) throw new Error('이 학교·연도에는 표 데이터가 없습니다(엑셀 폼 없음).');
  const fields = hiddenFields(form);
  fields.ExcelData = divInner(frag, 'excel');
  fields.ExcelData2 = divInner(frag, 'excel2');
  fields.ExcelDataN = divInner(frag, 'excelN');
  if (!fields.ExcelData.trim()) throw new Error('이 학교·연도에는 공시된 표 내용이 없습니다.');
  const { buf } = await sess.post('/cm/include/ExcelPrint.do', fields);
  return buf;
}

/* 첨부 목록 — title 은 "…계획.hwpx 알수없는 첨부파일" 처럼 뒤에 설명이 붙는다 */
function attachments(frag){
  return [...frag.matchAll(/onclick=["']getEiFile\d+\('(\d+)'\);?["'][^>]*title=["']([^"']*)["']/g)]
    .map(m => ({ seq: m[1], title: m[2] }));
}
/* 확장자 — title 끝에 설명이 붙으므로 '$' 로 잡으면 안 된다. 마지막 ".xxx" 를 쓴다 */
function extOf(title, fallback){
  const all = [...String(title).matchAll(/\.([a-z0-9]{2,5})(?=[\s"']|$)/gi)];
  return all.length ? all[all.length - 1][1].toLowerCase() : fallback;
}
/* 첨부 하나를 실제로 내려받는다. HTML 이 오면 사이트가 거절한 것 */
async function downloadAttachment(sess, frag, seq){
  const form = extractForm(frag, 'eiFileDownForm');
  if (!form) return null;
  const r = await sess.get('/servlets/EiFileDownLoad.do', { ...hiddenFields(form), FILE_SEQ: seq });
  if (r.buf.subarray(0, 512).toString('latin1').toLowerCase().includes('<html')) return null;
  return r.buf;
}

const isCaptcha = html => /CaptChaImg\.jsp|passLine/.test(html);

/* ── 응답 헬퍼 ── */
function sendFile(res, buf, filename, mime){
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition',
    `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.status(200).send(buf);
}
const fail = (res, code, msg) => res.status(code).json({ ok: false, error: msg });
const packSession = o => Buffer.from(JSON.stringify(o), 'utf8').toString('base64');
const unpackSession = s => JSON.parse(Buffer.from(String(s), 'base64').toString('utf8'));

/* 본문은 세 가지 모습으로 온다 —
     Vercel : application/json 이면 알아서 파싱해 **객체**로 준다
     dev.js : 스트림을 먼저 다 읽어서 **문자열**(json·text) 또는 **Buffer**(그 외)로 준다
     그 밖  : 아무도 안 읽었으면 스트림 그대로

   객체만 받아들이면 dev.js 에서 문자열이 그냥 통과해 버리고, 아래 스트림 읽기는 이미
   비워진 스트림을 다시 읽어 빈 객체가 된다 — 캡차 답이 사라져 "숫자만 입력해 주세요"
   가 뜬다. 실제로 그렇게 깨졌다. 세 경우를 다 받는다. */
async function readBody(req){
  if (Buffer.isBuffer(req.body)) req.body = req.body.toString('utf8');
  if (typeof req.body === 'string') return req.body ? JSON.parse(req.body) : {};
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

module.exports = async (req, res) => {
  const q = req.query || {};
  const act = String(q.act || '');
  const uuid = String(q.uuid || '');
  const name = String(q.name || '').slice(0, 60);
  const year = /^\d{4}$/.test(String(q.year)) ? String(q.year) : '2026';

  try {
    /* ── 1. 표로 공시된 항목 (사이트의 '엑셀저장' 과 같은 산출물) ──
       동아리·전출입·입학생·체력·수업시수·학급별 학생수·특색사업·자유학기·도서관·상담·급식.
       전부 같은 경로라 TABLE_ACTS 한 줄만 늘리면 항목이 하나 붙는다. */
    if (TABLE_ACTS[act]) {
      const spec = TABLE_ACTS[act];
      if (!UUID_RE.test(uuid)) return fail(res, 400, '학교 식별자가 올바르지 않습니다.');
      const sess = makeSession();
      const items = await openDetail(sess, uuid, year);
      const it = findItem(items, spec.kws);
      if (!it) return fail(res, 404, `${year}년 공시에 「${spec.label}」 항목이 없습니다.`);
      const { buf } = await sess.get(it.url, fragParams(it, uuid, name, year));
      const xls = await exportExcel(sess, decode(buf));
      return sendFile(res, xls, `${spec.file}_${name || '학교'}_${year}.xls`, 'application/vnd.ms-excel');
    }

    /* ── 2. 학업성적관리규정 (첨부파일 원본) ──
       학교마다 부르는 이름이 다르다. 고교·중학교는 '학업성적관리규정' 으로 통일돼 있지만
       초등은 '학업 성적 관리 규정'(대치초, 띄어쓰기) · '학생평가 규정' · '학업성적관리규칙'
       처럼 갈린다. 후보를 넓게 두고 순서대로 찾는다. */
    if (act === 'rule') {
      if (!UUID_RE.test(uuid)) return fail(res, 400, '학교 식별자가 올바르지 않습니다.');
      const RULE_NAMES = ['학업성적관리규정', '학업성적관리규칙', '학업성적관리지침',
                          '학생평가규정', '학생평가관리규정', '성적관리', '평가규정'];
      const sess = makeSession();
      const items = await openDetail(sess, uuid, year);
      // 규정 첨부는 '교과별(학년별) 교수·학습 및 평가계획' 아래에 붙고, 없으면 '학교규칙…' 쪽에 있다
      for (const key of ['교과별(학년별)교수', '학교규칙']) {
        const it = findItem(items, key);
        if (!it) continue;
        const frag = decode((await sess.get(it.url, fragParams(it, uuid, name, year))).buf);
        if (!extractForm(frag, 'eiFileDownForm')) continue;
        const files = attachments(frag);
        let hit = null;
        for (const want of RULE_NAMES) {
          hit = files.find(f => normNm(f.title).includes(want));
          if (hit) break;
        }
        if (!hit) continue;
        const buf = await downloadAttachment(sess, frag, hit.seq);
        if (!buf) return fail(res, 502, '첨부파일을 받지 못했습니다(학교알리미가 HTML을 반환).');
        return sendFile(res, buf, `학업성적관리규정_${name || '학교'}_${year}.${extOf(hit.title, 'hwp')}`,
          'application/octet-stream');
      }
      return fail(res, 404, `${year}년 공시에 학업성적관리규정 첨부가 없습니다. 공시연도를 낮춰 보세요.`);
    }

    /* ── 2-a. 교과별(학년별) 교수·학습 및 평가계획 — 첨부 전수 ──
       초등은 이 항목에 학년별 교과평가계획이 따로따로 붙는다(대치초 = 1~6학년 6개 + 규정 1개).
       고교는 전과목 한 파일이다. 몇 개인지 미리 알 수 없어 목록과 개별 다운로드로 나눈다.

         idx 없음 : { ok, files:[{idx,title,ext}] }
         idx=N    : N 번째 첨부 바이트

       매번 세션을 새로 여는 게 낭비로 보이지만, 서버리스에는 요청 사이 상태가 없어서
       이렇게 두는 편이 안전하다(캡차와 달리 여기는 세션을 맡길 이유가 없다). */
    if (act === 'evalplan') {
      if (!UUID_RE.test(uuid)) return fail(res, 400, '학교 식별자가 올바르지 않습니다.');
      const sess = makeSession();
      const items = await openDetail(sess, uuid, year);
      const it = findItem(items, ['교과별(학년별)교수', '교수학습및평가계획']);
      if (!it) return fail(res, 404, `${year}년 공시에 교과별 교수·학습 및 평가계획 항목이 없습니다.`);
      const frag = decode((await sess.get(it.url, fragParams(it, uuid, name, year))).buf);
      const files = attachments(frag);
      if (!files.length) return fail(res, 404, `${year}년 공시에 평가계획 첨부가 없습니다.`);

      const idx = q.idx === undefined || q.idx === '' ? null : Number(q.idx);
      if (idx === null) {
        res.setHeader('Cache-Control', 'private, no-store');
        return res.status(200).json({
          ok: true,
          files: files.map((f, i) => ({ idx: i, title: f.title, ext: extOf(f.title, 'hwp') })),
        });
      }
      if (!Number.isInteger(idx) || idx < 0 || idx >= files.length) {
        return fail(res, 400, `첨부 번호가 범위를 벗어났습니다 (0~${files.length - 1}).`);
      }
      const hit = files[idx];
      const buf = await downloadAttachment(sess, frag, hit.seq);
      if (!buf) return fail(res, 502, '첨부파일을 받지 못했습니다(학교알리미가 HTML을 반환).');
      /* 첨부 이름을 그대로 살린다 — '2026학년도 5학년 1학기 교과평가계획' 처럼 이름이
         곧 자료의 정체라서, 여기서 뭉개면 클로드코드가 몇 학년 것인지 알아볼 수 없다.
         뒤에 붙는 "한글문서 첨부파일" 같은 설명만 떼고 확장자를 다시 붙인다. */
      const ext = extOf(hit.title, 'hwp');
      const base = hit.title.split(new RegExp(`\\.${ext}`, 'i'))[0].trim() || `평가계획_${idx}`;
      return sendFile(res, buf, `${base}.${ext}`, 'application/octet-stream');
    }

    /* ── 3. 학교교육과정 편성·운영 및 평가 (첨부파일 원본 — 학점편제표) ── */
    if (act === 'curriculum') {
      if (!UUID_RE.test(uuid)) return fail(res, 400, '학교 식별자가 올바르지 않습니다.');
      const sess = makeSession();
      const items = await openDetail(sess, uuid, year);
      // 항목명은 학교급에 따라 '학교교육과정 편성…' / '교육과정 편성…' 두 형태가 있다
      const it = findItem(items, '학교교육과정편성') || findItem(items, '교육과정편성');
      if (!it) return fail(res, 404, `${year}년 공시에 교육과정 편성·운영 항목이 없습니다.`);
      const frag = decode((await sess.get(it.url, fragParams(it, uuid, name, year))).buf);
      const files = attachments(frag);
      if (!files.length) return fail(res, 404, `${year}년 공시에 교육과정 편성 첨부가 없습니다. 공시연도를 낮춰 보세요.`);
      // 이 항목에는 학사일정(.xlsx)이 같이 붙는다 — 학점편제가 든 '교육과정' 쪽을 고른다
      const flat = f => f.title.replace(/\s/g, '');
      const hit = files.find(f => flat(f).includes('교육과정') && !flat(f).includes('학사일정'))
               || files.find(f => !flat(f).includes('학사일정'))
               || files[0];
      const buf = await downloadAttachment(sess, frag, hit.seq);
      if (!buf) return fail(res, 502, '첨부파일을 받지 못했습니다(학교알리미가 HTML을 반환).');
      return sendFile(res, buf, `학교교육과정편성운영평가_${name || '학교'}_${year}.${extOf(hit.title, 'hwp')}`,
        'application/octet-stream');
    }

    /* ── 3-a. 교과별 학업성취 — 캡차 이미지 발급 ── */
    if (act === 'achieve-start') {
      if (!UUID_RE.test(uuid)) return fail(res, 400, '학교 식별자가 올바르지 않습니다.');
      const sess = makeSession();
      const items = await openDetail(sess, uuid, year);
      const it = findItem(items, '교과별학업성취');
      if (!it) return fail(res, 404, `${year}년 공시에 교과별 학업성취 사항이 없습니다.`);
      const frag = decode((await sess.get(it.url, fragParams(it, uuid, name, year))).buf);

      if (!isCaptcha(frag)) {                       // 드물게 캡차 없이 바로 열리는 경우
        const xls = await exportExcel(sess, frag);
        return res.status(200).json({ ok: true, solved: true,
          file: xls.toString('base64'), filename: `교과별학업성취사항_${name || '학교'}_${year}.xls` });
      }
      const form = extractForm(frag, 'srcForm');
      if (!form) return fail(res, 502, '캡차 폼을 찾지 못했습니다(사이트 구조 변경 가능성).');
      const fields = hiddenFields(form);
      const cap = await sess.get('/captcha/CaptChaImg.jsp',
        { rand: String(Math.random()), gsHangmokCd: fields.GS_HANGMOK_CD || it.GS_HANGMOK_CD });
      res.setHeader('Cache-Control', 'private, no-store');
      return res.status(200).json({
        ok: true, solved: false,
        image: 'data:image/png;base64,' + cap.buf.toString('base64'),
        session: packSession({ c: sess.cookies(), u: it.url, f: fields, n: name, y: year, id: uuid }),
      });
    }

    /* ── 3-b. 교과별 학업성취 — 캡차 답 제출 ── */
    if (act === 'achieve-solve') {
      const body = await readBody(req);
      const answer = String(body.answer || '').trim();
      if (!/^\d{1,10}$/.test(answer)) return fail(res, 400, '캡차는 숫자만 입력해 주세요.');
      let st;
      try { st = unpackSession(body.session); } catch { return fail(res, 400, '세션이 올바르지 않습니다. 다시 시도해 주세요.'); }
      if (!SAFE_PATH.test(String(st.u || ''))) return fail(res, 400, '허용되지 않은 요청입니다.');

      const sess = makeSession(st.c);
      const frag = decode((await sess.post(st.u, { ...st.f, passLine: answer, isCaptcha: 'Y' })).buf);
      if (isCaptcha(frag)) {                        // 틀렸으면 새 이미지를 다시 준다
        const cap = await sess.get('/captcha/CaptChaImg.jsp',
          { rand: String(Math.random()), gsHangmokCd: st.f.GS_HANGMOK_CD || '' });
        const form = extractForm(frag, 'srcForm');
        return res.status(200).json({
          ok: false, retry: true, error: '숫자가 맞지 않습니다. 새 이미지로 다시 입력해 주세요.',
          image: 'data:image/png;base64,' + cap.buf.toString('base64'),
          session: packSession({ ...st, c: sess.cookies(), f: form ? hiddenFields(form) : st.f }),
        });
      }
      const xls = await exportExcel(sess, frag);
      return sendFile(res, xls, `교과별학업성취사항_${st.n || '학교'}_${st.y}.xls`, 'application/vnd.ms-excel');
    }

    return fail(res, 400, 'act 파라미터가 필요합니다 — 표: '
      + Object.keys(TABLE_ACTS).join(' · ')
      + ' / 첨부: rule · curriculum · evalplan / 성취도: achieve-start · achieve-solve.');
  } catch (e) {
    const timedOut = e.name === 'TimeoutError' || e.name === 'AbortError';
    return fail(res, timedOut ? 504 : 502,
      timedOut ? '학교알리미 응답이 없습니다. 잠시 후 다시 시도해 주세요.' : (e.message || '요청 실패'));
  }
};
