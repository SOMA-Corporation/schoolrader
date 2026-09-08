/*
 * 전국 학교 색인 생성기 → public/schools.json
 *
 * 화면에서 시·도 → 시·군·구 → 학교급을 고르게 하지 않고, 학교 이름만 쳐서 고르게 하려면
 * 전국 학교가 미리 한 파일에 들어 있어야 한다. 공시 목록(apiType=0)은 지역 단위로만
 * 응답하므로, 여기서 모든 (시도 × 시군구 × 학교급) 조합을 한 번씩 훑어 모아 둔다.
 *
 *   node build-schools.js            # 기본 연도(2026)
 *   node build-schools.js 2025
 *
 * 공시 데이터는 연 단위로만 바뀌므로 1년에 한 번만 돌리면 된다.
 */
const fs = require('fs');
const path = require('path');

const YEAR = process.argv[2] || '2026';
/* 인증키는 .env 또는 환경변수에서 온다 — 소스에 상수로 두지 않는다.
   이 스크립트는 dev.js 를 거치지 않고 단독 실행되므로 .env 를 직접 읽는다.
     SCHOOLINFO_API_KEY=... node build-schools.js 2026   ← 이렇게 줘도 된다 */
function readEnv(name) {
  try {
    const txt = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      if (line.trimStart().startsWith('#')) continue;
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (m && m[1] === name) return m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch {}
  return '';
}

const KEY = process.env.SCHOOLINFO_API_KEY || readEnv('SCHOOLINFO_API_KEY');
const KINDS = [['02', '초'], ['03', '중'], ['04', '고']];
const CONCURRENCY = 8;

// 시도·시군구 코드표(학교알리미 배포 코드표). 화면에서는 더 이상 쓰지 않고 이 색인을 만들 때만 쓴다.
const SIDO = JSON.parse(fs.readFileSync(path.join(__dirname, 'regions.json'), 'utf8'));

// 드롭다운 오른쪽에 붙는 주소는 짧을수록 읽기 쉽다 → 시·도 이름을 줄여 쓴다.
const SHORT = {
  '서울특별시': '서울', '부산광역시': '부산', '대구광역시': '대구', '인천광역시': '인천',
  '대전광역시': '대전', '울산광역시': '울산', '세종특별자치시': '세종', '경기도': '경기',
  '충청북도': '충북', '충청남도': '충남', '경상북도': '경북', '경상남도': '경남',
  '제주특별자치도': '제주', '강원특별자치도': '강원', '전북특별자치도': '전북',
  '전남광주통합특별시': '전남광주',
};
const shortAddr = a => {
  const s = String(a || '').trim();
  const head = Object.keys(SHORT).find(k => s.startsWith(k));
  return head ? SHORT[head] + s.slice(head.length) : s;
};
// '특수목적고등학교' 같은 긴 이름은 뱃지로 쓰기엔 길다.
const shortKnd = v => String(v || '').replace(/고등학교$/, '고').replace(/^자율형/, '자율');

const jobs = [];
for (const sido of Object.keys(SIDO))
  for (const [sgg] of SIDO[sido].s)
    for (const [kind] of KINDS) jobs.push({ sido, sgg, kind });

async function fetchOne(j, tries = 3) {
  const qs = new URLSearchParams({
    apiType: '0', pbanYr: YEAR, schulKndCode: j.kind,
    sidoCode: j.sido, sggCode: j.sgg, apiKey: KEY,
  });
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(`https://www.schoolinfo.go.kr/openApi.do?${qs}`, { signal: AbortSignal.timeout(20000) });
      const json = await r.json();
      if (json.resultCode !== 'success') throw new Error(json.resultMsg || 'fail');
      return json.list || [];
    } catch (e) {
      if (i === tries) { console.error(`  ! ${j.sido}/${j.sgg}/${j.kind} 실패: ${e.message}`); return []; }
      await new Promise(r => setTimeout(r, 600 * i));
    }
  }
}

(async () => {
  const out = [];
  let done = 0;
  const queue = jobs.slice();
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const j = queue.shift();
      const list = await fetchOne(j);
      for (const s of list) {
        if (s.CLOSE_YN === 'Y') continue;            // 폐교는 검색에 나오면 안 된다
        out.push([
          s.SCHUL_NM,                                 // 0 학교명
          s.SCHUL_CODE,                               // 1 표준학교코드
          j.sido,                                     // 2 시도코드   (공시 항목 조회에 그대로 필요)
          j.sgg,                                      // 3 시군구코드
          j.kind,                                     // 4 학교급코드
          shortAddr(s.SCHUL_RDNMA || s.ADRES_BRKDN),  // 5 주소(드롭다운 오른쪽에 표시)
          shortKnd(s.HS_KND_SC_NM),                   // 6 고교 유형(일반고/특목고…)
          s.FOND_SC_CODE || '',                       // 7 설립(공립/사립…)
          s.SHL_IDF_CD || '',                         // 8 학교알리미 사이트 UUID (공시 원문 크롤용)
        ]);
      }
      if (++done % 40 === 0) console.log(`  ${done}/${jobs.length} … ${out.length}개교`);
    }
  }));

  // 학교코드 중복 제거 후 가나다순
  const seen = new Set();
  const rows = out.filter(r => !seen.has(r[1]) && seen.add(r[1]))
                  .sort((a, b) => String(a[0]).localeCompare(String(b[0]), 'ko'));

  const file = path.join(__dirname, 'public', 'schools.json');
  fs.writeFileSync(file, JSON.stringify({ year: YEAR, rows }));
  const kb = (fs.statSync(file).size / 1024).toFixed(0);
  const byKind = KINDS.map(([k, n]) => `${n} ${rows.filter(r => r[4] === k).length}`).join(' · ');
  console.log(`\n완료: ${rows.length}개교 (${byKind}) → public/schools.json (${kb}KB)`);
})();
