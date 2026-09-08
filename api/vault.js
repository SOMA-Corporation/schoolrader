/*
 * 저장소 (vault) — 받은 파일을 브라우저가 아니라 프로젝트 폴더에 쌓는다.
 *
 * 전에는 IndexedDB 였다. 그건 브라우저 안에만 있어서 클로드코드가 못 읽고, 기기를
 * 옮기면 사라지고, 200MB 상한에 걸리면 오래된 것부터 버려야 했다. 여기 두면
 * 웹이 쓴 파일을 클로드코드가 그대로 읽어 리포트를 만들고, 만든 PDF 를 다시
 * 웹이 보여 준다 — 웹과 에이전트가 만나는 지점이 이 폴더 하나다.
 *
 *   vault/{학교명}_{공시연도}/
 *     raw/    공시 원문 (동아리 .xls · 규정 .hwp/.pdf · 편제표 · 성취도 3개년)
 *     data/   OpenAPI 수집 결과 openapi.json · 졸업생진로 .csv (KESS)
 *     out/    분석리포트_○○고.pdf        ← 클로드코드가 넣는다
 *     meta.json  학교 식별자 · 파일 목록 · 리포트 상태
 *
 * ⚠️ 이 함수는 디스크에 쓴다 — Vercel 서버리스에서는 동작하지 않는다(파일시스템이
 *    읽기 전용이고 호출 사이에 유지되지도 않는다). 로컬(node dev.js) 전용이다.
 *
 *   GET    /api/vault                    저장소 전체 목록
 *   GET    /api/vault?id=..              한 학교 상세(meta)
 *   POST   /api/vault?id=..&kind=raw&name=..   파일 저장 (본문 = 파일 바이트)
 *   POST   /api/vault?id=..&meta=1       meta 병합 (본문 = JSON)
 *   DELETE /api/vault?id=..              학교 폴더 통째로 삭제
 *   DELETE /api/vault?id=..&file=raw/..  파일 하나 삭제
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', 'vault');
const KINDS = new Set(['raw', 'data', 'out']);

/* 파일명은 학교가 준 것을 그대로 쓰고 싶지만, 경로 구분자와 상위 이동(..)만은
   반드시 막는다. 한글·괄호·공백은 그대로 둔다 — 원본 이름이 곧 자료 이름이라
   여기서 손대면 클로드코드가 무슨 파일인지 알아보기 어려워진다. */
const safeName = s => String(s || '')
  .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
  .replace(/^\.+/, '_')
  .slice(0, 180) || 'unnamed';

/* 폴더 id 는 "{학교명}_{연도}". 학교명에도 같은 규칙을 건다. */
const folderId = (nm, year) => `${safeName(nm)}_${String(year).replace(/\D/g, '') || '0000'}`;

/** vault 밖으로 나가는 경로를 원천 차단한다 */
function resolveIn(...parts) {
  const full = path.resolve(ROOT, ...parts);
  const base = path.resolve(ROOT);
  if (full !== base && !full.startsWith(base + path.sep)) throw new Error('잘못된 경로입니다.');
  return full;
}

const EMPTY_META = () => ({
  school: null, year: null,
  created: new Date().toISOString(), updated: null,
  files: {},                       // "raw/이름.xls" → {act,label,size,at}
  report: { status: 'none' },      // none | running | done | failed
});

async function readMeta(id) {
  try {
    return JSON.parse(await fsp.readFile(resolveIn(id, 'meta.json'), 'utf8'));
  } catch {
    return null;
  }
}

async function writeMeta(id, meta) {
  meta.updated = new Date().toISOString();
  await fsp.mkdir(resolveIn(id), { recursive: true });
  await fsp.writeFile(resolveIn(id, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  return meta;
}

/* 폴더를 실제로 훑어 meta.files 를 다시 맞춘다. 클로드코드가 out/ 에 PDF 를 넣거나
   사람이 파일을 지워도 웹이 곧바로 알아보게 하려는 것 — meta 를 믿지 않고 디스크를 믿는다. */
async function scanFiles(id) {
  const out = {};
  for (const kind of KINDS) {
    let names = [];
    try { names = await fsp.readdir(resolveIn(id, kind)); } catch { continue; }
    for (const n of names) {
      if (n.startsWith('.')) continue;
      try {
        const st = await fsp.stat(resolveIn(id, kind, n));
        if (st.isFile()) out[`${kind}/${n}`] = { size: st.size, at: st.mtime.toISOString() };
      } catch {}
    }
  }
  return out;
}

/** meta + 실제 파일 목록을 합쳐 화면이 쓸 형태로 만든다 */
async function detail(id) {
  const meta = (await readMeta(id)) || EMPTY_META();
  const disk = await scanFiles(id);
  // meta 에 라벨(act/label)이 있으면 살리고, 크기·시각은 디스크 값을 쓴다
  const files = {};
  for (const [rel, st] of Object.entries(disk)) files[rel] = { ...(meta.files || {})[rel], ...st };
  const bytes = Object.values(files).reduce((n, f) => n + (f.size || 0), 0);
  const pdf = Object.keys(files).find(r => r.startsWith('out/') && r.toLowerCase().endsWith('.pdf'));
  const report = { ...(meta.report || { status: 'none' }) };
  /* 디스크에 PDF 가 있으면 경로는 항상 알려 준다 — 상태와 무관하게 그 파일은 실제로 있다.
     전에는 status==='running' 이면 감췄는데, 서버가 중간에 재시작되면 상태가 running 에
     박히는 바람에 다 만들어진 리포트를 화면에서 영영 열 수 없었다(실제로 겪었다).
     '완료'로 승격하는 것만 running 이 아닐 때로 남긴다 — 도는 중에 완료라고 하면 거짓말이다. */
  if (pdf) {
    report.pdf = pdf;
    if (report.status !== 'running') report.status = 'done';
  }
  return { id, school: meta.school, year: meta.year, created: meta.created, updated: meta.updated,
           files, count: Object.keys(files).length, bytes, report };
}

async function listAll() {
  let ids = [];
  try { ids = await fsp.readdir(ROOT); } catch { return []; }
  const rows = [];
  for (const id of ids) {
    if (id.startsWith('.')) continue;
    try {
      if (!(await fsp.stat(resolveIn(id))).isDirectory()) continue;
      rows.push(await detail(id));
    } catch {}
  }
  rows.sort((a, b) => String(b.updated || b.created || '').localeCompare(String(a.updated || a.created || '')));
  return rows;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const q = req.query || {};
  const id = q.id ? safeName(q.id) : null;

  try {
    if (req.method === 'GET') {
      if (!id) {
        const schools = await listAll();
        res.status(200).json({
          root: ROOT,
          schools,
          count: schools.length,
          bytes: schools.reduce((n, s) => n + s.bytes, 0),
        });
        return;
      }
      res.status(200).json(await detail(id));
      return;
    }

    if (req.method === 'POST') {
      if (!id) { res.status(400).json({ error: 'id 가 필요합니다.' }); return; }

      /* 탐색기에서 열기 — 브라우저는 로컬 경로를 못 연다(file:// 링크도 막혀 있다).
         로컬 전용 서버라 여기서 대신 띄운다. file 을 주면 그 파일을 선택한 채로 연다.

         경로는 반드시 resolveIn 을 거친다 — vault/ 밖으로는 절대 나가지 않는다.
         explorer 는 성공해도 종료코드 1 을 내므로 결과를 보지 않고 그냥 띄운다. */
      if (q.reveal) {
        let target;
        if (q.id === '__root__') {
          target = ROOT;                       // 저장소 최상위 폴더
        } else if (q.file) {
          const rel = String(q.file).split('/');
          if (rel.length !== 2 || !KINDS.has(rel[0])) { res.status(400).json({ error: '잘못된 파일 경로입니다.' }); return; }
          target = resolveIn(id, rel[0], safeName(rel[1]));
        } else {
          target = resolveIn(id);
        }
        if (!fs.existsSync(target)) { res.status(404).json({ error: '그 경로가 없습니다.' }); return; }

        if (process.platform === 'win32') {
          spawn('explorer.exe', q.file ? ['/select,' + target] : [target], { detached: true, stdio: 'ignore' }).unref();
        } else if (process.platform === 'darwin') {
          spawn('open', q.file ? ['-R', target] : [target], { detached: true, stdio: 'ignore' }).unref();
        } else {
          spawn('xdg-open', [q.file ? path.dirname(target) : target], { detached: true, stdio: 'ignore' }).unref();
        }
        res.status(200).json({ ok: true, opened: target });
        return;
      }

      /* meta 병합 — 학교 식별자와 리포트 상태를 갱신한다 */
      if (q.meta) {
        let patch = req.body;
        if (Buffer.isBuffer(patch)) patch = patch.toString('utf8');
        if (typeof patch === 'string') patch = JSON.parse(patch || '{}');
        const meta = (await readMeta(id)) || EMPTY_META();
        const next = { ...meta, ...patch,
                       files: { ...(meta.files || {}), ...(patch.files || {}) },
                       report: { ...(meta.report || {}), ...(patch.report || {}) },
                       created: meta.created };
        await writeMeta(id, next);
        res.status(200).json(await detail(id));
        return;
      }

      /* 파일 저장 */
      const kind = KINDS.has(q.kind) ? q.kind : 'raw';
      const name = safeName(q.name);
      const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '', 'utf8');
      if (!buf.length) { res.status(400).json({ error: '빈 파일입니다.' }); return; }

      await fsp.mkdir(resolveIn(id, kind), { recursive: true });
      await fsp.writeFile(resolveIn(id, kind, name), buf);

      const meta = (await readMeta(id)) || EMPTY_META();
      meta.files = meta.files || {};
      meta.files[`${kind}/${name}`] = {
        act: q.act || null, label: q.label || null,
        size: buf.length, at: new Date().toISOString(),
      };
      if (q.year && !meta.year) meta.year = String(q.year);
      await writeMeta(id, meta);

      res.status(200).json({ ok: true, id, path: `${kind}/${name}`, size: buf.length,
                             url: `/vault/${encodeURIComponent(id)}/${kind}/${encodeURIComponent(name)}` });
      return;
    }

    if (req.method === 'DELETE') {
      if (!id) { res.status(400).json({ error: 'id 가 필요합니다.' }); return; }
      if (q.file) {
        const rel = String(q.file).split('/');
        if (rel.length !== 2 || !KINDS.has(rel[0])) { res.status(400).json({ error: '잘못된 파일 경로입니다.' }); return; }
        await fsp.rm(resolveIn(id, rel[0], safeName(rel[1])), { force: true });
        const meta = (await readMeta(id)) || EMPTY_META();
        if (meta.files) delete meta.files[`${rel[0]}/${safeName(rel[1])}`];
        await writeMeta(id, meta);
        res.status(200).json(await detail(id));
        return;
      }
      await fsp.rm(resolveIn(id), { recursive: true, force: true });
      res.status(200).json({ ok: true, removed: id });
      return;
    }

    res.status(405).json({ error: 'GET · POST · DELETE 만 받습니다.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

module.exports.ROOT = ROOT;
module.exports.folderId = folderId;
module.exports.safeName = safeName;
module.exports.readMeta = readMeta;
module.exports.writeMeta = writeMeta;
module.exports.detail = detail;
module.exports.resolveIn = resolveIn;
