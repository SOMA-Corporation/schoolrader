/*
 * KESS 학교 색인 생성기 → public/kess.json · kess-ms.json · kess-es.json
 *
 * 리포트가 쓰는 졸업생 진로와 학교 규모 추이는 학교알리미에도 NEIS 에도 없다. 원천은
 * 교육기본통계(교육부 조사 · 한국교육개발원 수행, 매년 4/1 기준)이고, 공표 창구는 KESS 한 곳뿐이다.
 * 그런데 KESS 는 API 를 주지 않는다 — 전국 한 파일(20,660행 × 149열, 18MB)을 통째로
 * 내려받는 방식이라 서버리스 함수에서 실시간으로 다룰 수 없다.
 *
 * 그래서 build-schools.js 와 같은 방식으로 간다: 여기서 미리 훑어 두면
 * 화면은 색인 파일 하나만 읽고 즉시 답한다.
 *
 *   node build-kess.js            # 학교급별로 최신 3개년 자동 판별
 *   node build-kess.js 2025 2024 2023
 *
 * 조사 자료는 연 단위로만 바뀌므로 1년에 한 번만 돌리면 된다.
 *
 * ── 학교급을 셋으로 나눈다 ──
 * 같은 파일에 초 6,369 · 중 3,313 · 고 2,391 행이 함께 들어 있다. 전에는 고교만 남기고
 * 버렸는데, 초·중 리포트가 학년별 학생수 추이와 진학률을 쓰기 시작하면서 셋 다 뽑는다.
 * 파일을 합치지 않고 나누는 이유는 화면 첫 로딩 때문이다 — 고교 색인만도 774KB 다.
 *
 * 학교급마다 있는 열이 다르다:
 *   · 초등학교 — 학년이 6개. 졸업·진학 칸이 통째로 비어 있다(조사 대상이 아니다)
 *   · 중학교   — 졸업자·진학자·진학률까지. 진학처 분류(국내 대학…)는 없다
 *   · 고등학교 — 진학처까지 전부
 *
 * ── 최신 파일을 그냥 믿으면 안 된다 ──
 * 상반기 파일은 4/1 조사분이라 '졸업 후 상황' 칸이 비어 있는 채로 먼저 올라온다.
 * (2026년 파일 확인: 단대부고 졸업자 398 은 있는데 진학자·기타는 전부 0)
 * 그래서 연도를 안 주면 최신부터 내려가며 쓸 만한 해만 3개 고른다.
 * 판정 기준은 학교급마다 다르다 — 중·고는 '진학 칸이 찼는가', 초등은 그 칸이 영원히
 * 비어 있으므로 '학생수가 찼는가' 로 본다. 초등에 진학 기준을 쓰면 한 해도 못 고른다.
 */
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const LIST_URL = 'https://kess.kedi.re.kr/contents/dataset';
const DL_URL = f => `https://kess.kedi.re.kr/contents/dataSet/downLoad.do?fileNm=${f}&userfileNm=data.xlsx`;
const SHEET = '학교별 주요통계';
const CACHE = path.join(__dirname, '.kess-cache');
const OUT_DIR = path.join(__dirname, 'public');

/* ── 학교급별 설정 ──
   COLS 는 '뽑아 쓰는 열'이다. 연도마다 열 위치가 밀리므로 인덱스가 아니라 머리글 텍스트로 찾는다.
   ※ 새 열은 반드시 뒤에 붙인다. 앞 인덱스가 밀리면 색인을 읽는 쪽이 조용히 어긋난다. */

/* 규모 열 — 세 학교급이 공통으로 쓴다. 학년 열만 뒤에서 따로 붙인다. */
const SIZE_COLS = [
  ['cls',     '편성학급수_계'],
  ['stu',     '학생수_총계_계'],
];
const TAIL_COLS = [
  ['perCls',  '학급당학생수'],       // 머리글에 공백이 둘 들어 있다 → norm 이 지운다
  ['tch',     '교원수_총계_계'],
  ['tchTmp',  '교원수_기간제교원_계'],
  ['perTch',  '교원1인당학생수'],
  ['out',     '전출'],
  ['in',      '전입'],
  ['enter',   '입학자_계'],
];
const grades = n => Array.from({ length: n }, (_, i) => [`g${i + 1}`, `${i + 1}학년_학생수_계`]);

/* 졸업 후 상황 — 중·고만. 진학처 분류는 고교 행에만 채워진다(중학교는 진학률까지). */
const ADV_BASIC = [
  ['grad',    '졸업자_계'],
  ['adv',     '진학자_계'],
  ['advRate', '진학률_전체(%)'],
];
const ADV_FULL = ADV_BASIC.concat([
  ['emp',     '취업자_계'],
  ['mil',     '입대자_계'],
  ['etc',     '기타_계'],
  ['jcolK',   '국내_전문대학_계'],
  ['colK',    '국내_대학_계'],
  ['jcolF',   '국외_전문대학_계'],
  ['colF',    '국외_대학_계'],
]);

const LEVELS = [
  {
    kind: '04', nm: '고등학교', out: 'kess.json', typeCol: 6,   // 고등학교유형(일반고·자율고·특목고…)
    /* 특목·특성화는 진로 구조가 아예 달라 섞으면 일반고 재수율이 왜곡된다 —
       작업설명서 §1-A 의 기준을 그대로 따른다. */
    aggTypes: new Set(['일반고등학교', '자율고등학교']),
    cols: ADV_FULL.concat(SIZE_COLS, grades(3), TAIL_COLS),
    ratios: [['advRate', 'adv', 'grad', 100], ['perCls', 'stu', 'cls', 1], ['perTch', 'stu', 'tch', 1]],
    aggBase: 'grad',          // 집계에 넣을지 판단하는 열
    readyBy: 'adv',           // 연도 선별 기준 — 이 열이 찼는가
    nYears: 3,
    note: '“졸업 후 상황”은 직전 2월 졸업생 기준. 집계(구·시도·전국)는 일반고+자율고만 합산.',
  },
  {
    kind: '03', nm: '중학교', out: 'kess-ms.json', typeCol: 7,   // 학교세부유형(일반중학교…)
    aggTypes: null,           // 중학교는 유형을 가리지 않는다(일반중이 사실상 전부)
    cols: ADV_BASIC.concat(SIZE_COLS, grades(3), TAIL_COLS),
    ratios: [['advRate', 'adv', 'grad', 100], ['perCls', 'stu', 'cls', 1], ['perTch', 'stu', 'tch', 1]],
    aggBase: 'stu',
    readyBy: 'adv',
    nYears: 3,
    note: '“졸업 후 상황”은 직전 2월 졸업생 기준 — 진학률까지만 있다. ' +
          '진학처 분류(일반고·특목고·특성화고)는 KESS 가 고등학교 행에만 채우므로 이 색인에 없다.',
  },
  {
    kind: '02', nm: '초등학교', out: 'kess-es.json', typeCol: 7, // 학교세부유형(초등학교)
    aggTypes: null,
    /* 초등은 졸업·진학 열이 통째로 0 이다. 넣어 두면 화면이 0 을 '진학자 없음' 으로
       읽어 버리므로 아예 뽑지 않는다. */
    cols: SIZE_COLS.concat(grades(6), TAIL_COLS),
    ratios: [['perCls', 'stu', 'cls', 1], ['perTch', 'stu', 'tch', 1]],
    aggBase: 'stu',
    readyBy: 'stu',           // 진학 기준을 쓰면 한 해도 못 고른다
    /* 초등만 4개년이다 — 진학 칸이 없어 선공개분에 걸릴 일이 없고,
       신입생 추세는 3개년으로는 방향이 안 보인다. */
    nYears: 4,
    note: '초등학교는 졸업·진학이 조사 대상이 아니라 그 열이 없다. 전입·전출은 직전 학년도 값이다.',
  },
];

/* 머리글은 셀 안에 줄바꿈·공백이 섞여 있다(예: '진학률 \n_전체(%)') → 다 지우고 비교 */
const norm = s => String(s ?? '').replace(/\s+/g, '');
const num = v => {
  if (v == null || v === '') return 0;
  const n = Number(typeof v === 'object' && 'result' in v ? v.result : v);
  return Number.isFinite(n) ? n : 0;
};

/* ── KESS 목록에서 '학교별(상반기)' 연도별 파일명 긁기 ──
   페이지가 downLoad('id','서버파일명','원래이름_260903H.xlsx','01') 형태로 심어 둔다.
   서버파일명은 갱신될 때마다 바뀌므로 절대 하드코딩하지 않는다. */
async function fileIndex(){
  const html = await (await fetch(LIST_URL)).text();
  const out = new Map();
  const re = /downLoad\('\d+','([^']+)','([^']+)'/g;
  let m;
  while ((m = re.exec(html))) {
    const [, fileNm, title] = m;
    // '2025년 유초중등 학교별 학년별 학생수 …' 만. '하반기' 파일에는 졸업·진학이 없다.
    const y = /^(\d{4})년\s*유초중등\s*학교별/.exec(title);
    if (y && !/하반기/.test(title) && !out.has(y[1])) out.set(y[1], { fileNm, title });
  }
  return out;
}

async function grab(year, fileNm){
  fs.mkdirSync(CACHE, { recursive: true });
  const dest = path.join(CACHE, `${year}.xlsx`);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1e6) return dest;
  process.stdout.write(`  ${year}년 내려받는 중… `);
  const res = await fetch(DL_URL(fileNm));
  if (!res.ok) throw new Error(`KESS 응답 ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  console.log(`${(buf.length / 1048576).toFixed(1)}MB`);
  return dest;
}

/* 18MB 를 통째로 메모리에 올리지 않도록 스트림으로 읽는다.
   한 번 읽으면서 세 학교급을 동시에 담는다 — 파일이 커서 학교급마다 다시 읽으면 3배 걸린다. */
async function readYear(file){
  const wb = new ExcelJS.stream.xlsx.WorkbookReader(file, { sharedStrings: 'cache', worksheets: 'emit' });
  let head = null;                        // 머리글에서 찾아낸 열 위치 (학교급 공통)
  const byKind = Object.fromEntries(LEVELS.map(L => [L.kind, []]));
  const KIND_OF = { '초등학교': '02', '중학교': '03', '고등학교': '04' };

  for await (const ws of wb) {
    if (ws.name !== SHEET) continue;
    for await (const row of ws) {
      const v = row.values;                // exceljs 는 1-based — v[0] 은 비어 있다
      if (!head) {
        // 머리글 줄인가? '졸업자_계' 가 보이는 줄이 잎(leaf) 머리글이다.
        if (v.findIndex(c => norm(c) === '졸업자_계') < 0) continue;
        /* '유형' 은 학교급마다 다른 열이다 — 고교는 6번 고등학교유형(자율고·특목고…),
           초·중은 6번이 비어 있고 7번 학교세부유형에 값이 있다. 하나로 박으면
           고교 집계 기준(일반고+자율고)이 조용히 바뀐다. LEVELS.typeCol 로 나눈다. */
        head = { 시도: 2, 행정구: 3, 학교급: 5, 학교명: 9, at: {} };
        /* 열 위치는 학교급과 무관하게 한 번만 찾는다. 학교급마다 안 쓰는 열이 있어도
           위치 자체는 같은 파일이라 같다. */
        for (const L of LEVELS) {
          for (const [key, label] of L.cols) {
            if (head.at[label] !== undefined) continue;
            const at = v.findIndex(c => norm(c) === norm(label));
            if (at < 0) throw new Error(`머리글 '${label}' 을 찾지 못했습니다 — 파일 구조가 바뀌었습니다`);
            head.at[label] = at;
          }
        }
        continue;
      }
      const kind = KIND_OF[String(v[head.학교급] ?? '').trim()];
      if (!kind) continue;                 // 유치원·특수학교·각종학교 등은 버린다
      const name = String(v[head.학교명] ?? '').trim();
      if (!name) continue;
      const L = LEVELS.find(x => x.kind === kind);
      byKind[kind].push({
        name,
        sido: String(v[head.시도] ?? '').trim(),
        sgg: String(v[head.행정구] ?? '').trim(),
        type: String(v[L.typeCol] ?? '').trim(),
        vals: L.cols.map(([, label]) => num(v[head.at[label]])),
      });
    }
  }
  if (!head) throw new Error(`시트 '${SHEET}' 를 찾지 못했습니다`);
  return byKind;
}

/* 그 해 자료가 쓸 만한가. 중·고는 진학 칸이 상반기 선공개분에서 비어 있고,
   초등은 그 칸이 영원히 비어 있으므로 학생수로 본다(LEVELS.readyBy). */
function filled(L, rows){
  const at = Object.fromEntries(L.cols.map(([k], i) => [k, i]));
  const base = at[L.aggBase], probe = at[L.readyBy];
  const has = rows.filter(r => r.vals[base] > 0);
  if (!has.length) return 0;
  return has.filter(r => r.vals[probe] > 0).length / has.length;
}

const key = r => `${r.name}|${r.sido}|${r.sgg}`;

/* 구·시도·전국 합계. 비율은 합계에서 다시 나눈다(학교 평균이 아니라 인원 기준). */
function aggregate(L, rows){
  const at = Object.fromEntries(L.cols.map(([k], i) => [k, i]));
  const skip = new Set(L.ratios.map(([k]) => at[k]));
  const bins = new Map();
  const add = (k, r) => {
    let b = bins.get(k);
    if (!b) bins.set(k, (b = { n: 0, v: new Array(L.cols.length).fill(0) }));
    b.n++;
    r.vals.forEach((x, i) => { if (!skip.has(i)) b.v[i] += x; });
  };
  for (const r of rows) {
    if (L.aggTypes && !L.aggTypes.has(r.type)) continue;
    if (!r.vals[at[L.aggBase]]) continue;                       // 기준 열이 0 이면 미기재
    add(`${r.sido}|${r.sgg}`, r);
    add(r.sido, r);
    add('전국', r);
  }
  const out = {};
  for (const [k, b] of bins) {
    for (const [rk, numer, denom, mul] of L.ratios) {
      const d = b.v[at[denom]];
      b.v[at[rk]] = d ? +(b.v[at[numer]] / d * mul).toFixed(1) : 0;
    }
    out[k] = [...b.v, b.n];
  }
  return out;
}

(async () => {
  const want = process.argv.slice(2).filter(a => /^\d{4}$/.test(a));
  const index = await fileIndex();
  if (!index.size) throw new Error('KESS 목록에서 학교별 파일을 찾지 못했습니다 — 페이지 구조를 확인하세요');
  const years = [...index.keys()].sort().reverse();
  console.log(`KESS 목록: ${years[0]}~${years[years.length - 1]}년 ${years.length}개`);

  /* 파일을 한 번씩만 읽는다. 학교급마다 쓸 연도가 다를 수 있으므로 판정은 뒤에서 따로 한다.
     넉넉히 5개년까지만 본다 — 세 학교급 전부 3개년을 채우면 거기서 멈춘다. */
  const perYear = new Map();
  const pool = want.length ? want : years.slice(0, 5);
  for (const y of pool) {
    const meta = index.get(y);
    if (!meta) { console.log(`  ${y}년: 목록에 없음 — 건너뜀`); continue; }
    perYear.set(y, await readYear(await grab(y, meta.fileNm)));
    const c = LEVELS.map(L => `${L.nm[0]} ${perYear.get(y)[L.kind].length}`).join(' · ');
    console.log(`  ${y}년: ${c}`);
  }
  if (!perYear.size) throw new Error('쓸 수 있는 연도가 없습니다');

  for (const L of LEVELS) {
    const pick = [];
    for (const y of pool) {
      if (pick.length === (L.nYears || 3)) break;
      const byKind = perYear.get(y);
      if (!byKind) continue;
      const rows = byKind[L.kind];
      const rate = filled(L, rows);
      if (!want.length && rate < 0.5) {
        console.log(`  [${L.nm}] ${y}년: ${L.readyBy} 기재 ${(rate * 100).toFixed(0)}% → 선공개분으로 보고 건너뜀`);
        continue;
      }
      pick.push(y);
    }
    if (!pick.length) { console.log(`  [${L.nm}] 쓸 수 있는 연도가 없습니다 — 건너뜀`); continue; }

    // 학교 → 연도별 값. 어느 해에만 있는 학교(신설·폐교)도 있으므로 합집합으로 모은다.
    const schools = new Map();
    for (const y of pick) {
      for (const r of perYear.get(y)[L.kind]) {
        let sc = schools.get(key(r));
        if (!sc) schools.set(key(r), (sc = { name: r.name, sido: r.sido, sgg: r.sgg, type: r.type, by: {} }));
        sc.type = r.type;                                // 유형은 최신 연도 기준
        sc.by[y] = r.vals;
      }
    }

    const out = {
      built: new Date().toISOString().slice(0, 10),
      level: L.kind,
      levelName: L.nm,
      source: 'KESS 교육통계서비스 · 유초중등 학교별(상반기) — 교육기본통계(교육부·한국교육개발원), 매년 4/1 기준',
      note: L.note,
      years: pick,
      files: Object.fromEntries(pick.map(y => [y, index.get(y).title])),
      cols: L.cols.map(([k]) => k),
      schools: [...schools.values()]
        .sort((a, b) => a.name.localeCompare(b.name, 'ko'))
        .map(sc => [sc.name, sc.sido, sc.sgg, sc.type, pick.map(y => sc.by[y] || null)]),
      agg: Object.fromEntries(pick.map(y => [y, aggregate(L, perYear.get(y)[L.kind])])),
    };

    const dest = path.join(OUT_DIR, L.out);
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(dest, JSON.stringify(out));
    const kb = (fs.statSync(dest).size / 1024).toFixed(0);
    console.log(`public/${L.out} — ${L.nm} ${out.schools.length}개 · ${pick.join(', ')}년 · ${kb}KB`);
  }
  console.log(`\n캐시는 ${path.relative(__dirname, CACHE)} 에 남습니다 (지워도 됩니다)`);
})().catch(e => { console.error('\n실패:', e.message); process.exit(1); });
