/*
 * 리포트 생성 — 저장소에 모인 자료로 클로드코드를 돌려 PDF 를 만든다.
 *
 * 웹이 vault/{학교}_{연도}/ 에 raw·data 를 채워 두면, 여기서 `claude -p` 를 띄워
 * docs/분석리포트_작업설명서.md 를 그대로 따르게 하고, 결과 PDF 를 같은 폴더의
 * out/ 에 넣게 한다. 그러면 vault.html 이 바로 그 PDF 를 열어 보여 준다.
 *
 * 프롬프트 본문은 prompts/분석리포트-생성.md 다 — 지시를 고칠 때 이 파일은 안 건드린다.
 *
 * ⚠️ 프로세스를 띄운다 — 로컬(node dev.js) 전용이다.
 *
 *   POST   /api/report?id=..     생성 시작 (이미 돌고 있으면 그대로 붙는다)
 *   GET    /api/report?id=..     상태 + 로그 꼬리
 *   DELETE /api/report?id=..     돌고 있는 작업 중단
 */
const fsp = require('fs').promises;
const path = require('path');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const vault = require('./vault.js');

const PROJECT = path.join(__dirname, '..');

/* 프롬프트는 학교급마다 다르다 — 초등엔 성취도 공시가 아예 없고, 자유학기는 중학교에만 있고,
   중학교는 석차등급·동점자·등급컷이 제도적으로 없다. 한 프롬프트로 셋을 다루면
   "없는 것을 지어내지 마라"는 지시가 무뎌진다. 학교급은 meta.json 의 school.kind 로 안다. */
const PROMPT_BY_KIND = { '02': '초', '03': '중', '04': '고' };
const promptFile = kind =>
  path.join(PROJECT, 'prompts', `분석리포트-생성-${PROMPT_BY_KIND[String(kind)] || '고'}.md`);

/* 실행 명령은 환경변수로 바꿀 수 있게 둔다 — 설치 방식(nvm·전역·npx)에 따라 다르다. */
const CLAUDE = process.env.SR_CLAUDE_BIN || 'claude';
/* 기본은 acceptEdits + 필요한 도구만. PDF 변환에 크롬을 부르므로 Bash 가 필요하다.
   더 조이려면 SR_CLAUDE_ARGS 로 덮어쓴다.

   stream-json 을 쓰는 이유: 그냥 `-p` 는 다 끝날 때까지 아무것도 안 뱉는다. 몇 분짜리
   작업이라 그동안 화면이 멈춘 것처럼 보인다. 한 줄씩 오는 이벤트를 사람이 읽을 수 있는
   진행 줄로 바꿔서 보여 준다. */
const ARGS = (process.env.SR_CLAUDE_ARGS ||
  '-p --output-format stream-json --verbose --permission-mode acceptEdits ' +
  '--allowedTools Read,Write,Edit,Glob,Grep,Bash').split(/\s+/).filter(Boolean);

const LOG_MAX = 400;                 // 화면에 돌려줄 로그 줄 수 상한
const jobs = new Map();              // id → {status, log[], startedAt, endedAt, child, code, sessionId, attempt}

/* ── 끊기면 이어서 한다 ──
   리포트 한 건이 수십 분짜리라 그 사이 네트워크가 한 번 튀면 전부 날아갔다.
   실제로 저현고 작업이 조립 직전에 ENOTFOUND 로 죽어 40분치가 버려졌다.

   이어붙이는 근거는 둘이다.
     · 세션  — 우리가 --session-id 로 id 를 정해 두고, 다시 띄울 때 --resume 로 같은 대화에 붙는다
     · 디스크 — .scratch/{id}/ 의 중간 산출물이 그대로 남아 있다(프롬프트가 그걸 먼저 보게 한다)
   둘 중 하나만 살아 있어도 처음부터 다시 하지는 않는다. */
const RETRY_MAX = Number(process.env.SR_RETRY_MAX || 3);
const RETRY_WAIT = Number(process.env.SR_RETRY_WAIT_MS || 20000);

/* 끊긴 것인지 진짜 실패인지. 여기 걸리는 것만 재시도한다 —
   자료가 모자라서 못 만드는 건 몇 번을 돌려도 같은 자리에서 죽는다. */
const TRANSIENT = /ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|network|Can't reach the API server|Connection error|fetch failed|502|503|504|overloaded_error|Internal server error|rate.?limit/i;

const RESUME_NOTE = [
  '이전 실행이 네트워크 문제로 중간에 끊겼다. 처음부터 다시 하지 마라.',
  '',
  '1. `.scratch/` 안의 이 작업 폴더를 먼저 열어 어디까지 했는지 확인해라 —',
  '   추출해 둔 텍스트·중간 스크립트·report.html 조각이 그대로 남아 있다.',
  '2. 이미 만들어 둔 것은 다시 만들지 말고 그대로 쓴다.',
  '3. 남은 단계부터 이어서 끝내라 — 최종 산출물은 vault 의 out/ 에 PDF 와 제작메모.md 다.',
].join('\n');

/* 구독 전용. 클로드코드는 환경에 이 값들이 있으면 claude.ai 로그인보다 그쪽을 먼저 쓰고
   조용히 API 과금으로 넘어가므로, 자식에게 넘기기 전에 지운다. 선택지는 두지 않는다. */
function childEnv() {
  const env = { ...process.env };
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
                   'ANTHROPIC_API_URL', 'ANTHROPIC_CUSTOM_HEADERS']) delete env[k];
  return env;
}

/* 서버가 뜰 때 한 번 — 'running' 으로 남아 있는 meta 를 정리한다.
   진행 상태는 이 프로세스의 메모리(jobs)에만 있다. 서버가 재시작되면 돌던 자식은
   우리 손을 떠나고 close 핸들러도 같이 사라져서, meta 가 running 에 영원히 박힌다.
   그러면 화면은 끝나지 않는 작업을 계속 기다린다 — 실제로 그렇게 물렸다.
   결과물을 믿는 규칙은 여기서도 같다: PDF 가 있으면 완료, 없으면 중단으로 적는다. */
(async function sweepStale(){
  try {
    const ids = await fsp.readdir(vault.ROOT);
    for (const id of ids) {
      const meta = await vault.readMeta(id);
      if (!meta || !meta.report || meta.report.status !== 'running') continue;
      const info = await vault.detail(id);
      const pdf = info.report && info.report.pdf;
      await markMeta(id, pdf
        ? { status: 'done', pdf, error: null }
        : { status: 'failed', error: '서버가 다시 시작되어 진행 상태를 잃었습니다. 다시 만들어 주세요.' });
    }
  } catch {}                       // vault/ 가 아직 없을 수 있다
})();

const tail = j => j.log.slice(-LOG_MAX).join('\n');

async function markMeta(id, report) {
  try {
    const meta = (await vault.readMeta(id)) || {};
    meta.report = { ...(meta.report || {}), ...report };
    await vault.writeMeta(id, meta);
  } catch {}
}

/** 프롬프트 본문 — 학교급에 맞는 것을 고르고 대상 폴더를 박아 넣는다 */
async function buildPrompt(id, info) {
  const kind = (info.school && info.school.kind) || '04';
  const file = promptFile(kind);
  let body;
  try {
    body = await fsp.readFile(file, 'utf8');
  } catch {
    throw new Error(`프롬프트 파일이 없습니다: ${path.relative(PROJECT, file)}`);
  }
  const nm = (info.school && info.school.nm) || id;
  const files = Object.keys(info.files || {}).sort().map(f => ` - ${f}`).join('\n') || ' (없음)';
  return body
    .replaceAll('{{VAULT_ID}}', id)
    .replaceAll('{{SCHOOL}}', nm)
    .replaceAll('{{YEAR}}', String(info.year || ''))
    .replaceAll('{{FILES}}', files);
}

async function start(id) {
  const existing = jobs.get(id);
  if (existing && existing.status === 'running') return existing;

  const info = await vault.detail(id);
  if (!info.count) throw new Error('저장소에 자료가 없습니다 — 먼저 파일을 받아 주세요.');

  const prompt = await buildPrompt(id, info);
  const job = {
    status: 'running', log: [], startedAt: new Date().toISOString(),
    endedAt: null, code: null, attempt: 0, stopped: false,
    /* 세션 id 를 우리가 정한다. 그래야 끊겼을 때 같은 대화로 이어붙일 수 있다 —
       클로드코드가 뱉는 id 를 로그에서 주워 담는 것보다 확실하다. */
    sessionId: (await vault.readMeta(id))?.report?.sessionId || randomUUID(),
  };
  jobs.set(id, job);
  await markMeta(id, {
    status: 'running', startedAt: job.startedAt, pdf: null, error: null,
    sessionId: job.sessionId,
  });

  /* stream-json 한 줄을 사람이 읽을 한 줄로. 모르는 형태면 원문을 그대로 남긴다 —
     진행 상황을 보려고 켠 것이라 조용히 버리는 쪽이 더 나쁘다. */
  const readable = line => {
    let ev;
    try { ev = JSON.parse(line); } catch { return line; }
    if (ev.type === 'system' && ev.subtype === 'init') return `· 시작 — 모델 ${ev.model || ''}`;
    if (ev.type === 'result') {
      /* 이 값은 '얼마가 청구됐나'가 아니라 사용량을 달러로 환산한 것이다.
         구독 로그인으로 돌아도 찍힌다 — 과금 여부와 헷갈리지 않게 라벨을 붙인다. */
      const cost = ev.total_cost_usd != null ? ` · 사용량 $${Number(ev.total_cost_usd).toFixed(3)} 어치` : '';
      const bad = ev.is_error || /error/i.test(String(ev.subtype || ''));
      return `· ${bad ? '중단' : '끝'} — ${ev.subtype || ''}${cost}`;
    }
    if (ev.type === 'assistant' || ev.type === 'user') {
      const parts = ((ev.message && ev.message.content) || []).map(c => {
        if (c.type === 'text') return String(c.text || '').trim().split('\n')[0].slice(0, 200);
        if (c.type === 'tool_use') {
          const i = c.input || {};
          const arg = i.file_path || i.command || i.pattern || i.path || '';
          return `▸ ${c.name} ${String(arg).slice(0, 140)}`.trim();
        }
        if (c.type === 'tool_result') {
          return c.is_error ? `  ✗ 실패` : null;      // 성공 결과 본문은 길기만 하다
        }
        return null;
      }).filter(Boolean);
      return parts.join('\n') || null;
    }
    return null;
  };

  let carry = '';                                     // 줄이 청크 경계에서 잘릴 수 있다
  const push = (src, buf) => {
    if (src === 'err') {
      for (const l of String(buf).split(/\r?\n/)) if (l.trim()) job.log.push(`! ${l}`);
    } else {
      carry += String(buf);
      const lines = carry.split(/\r?\n/);
      carry = lines.pop();
      for (const l of lines) {
        if (!l.trim()) continue;
        const out = readable(l);
        if (out) job.log.push(out);
      }
    }
    if (job.log.length > LOG_MAX * 4) job.log = job.log.slice(-LOG_MAX * 2);
  };

  /** 한 번 띄우고 끝날 때까지 기다린다. resume 이면 같은 세션에 이어붙인다. */
  function runOnce(resume) {
    return new Promise(resolve => {
      const args = resume
        ? ['--resume', job.sessionId, ...ARGS]
        : ['--session-id', job.sessionId, ...ARGS];
      const child = spawn(CLAUDE, args, {
        cwd: PROJECT,
        shell: process.platform === 'win32',   // 윈도에서 claude 는 .cmd 라 셸을 거쳐야 뜬다
        windowsHide: true,
        env: childEnv(),
      });
      job.child = child;
      carry = '';

      child.stdout.on('data', b => push('out', b));
      child.stderr.on('data', b => push('err', b));
      child.on('error', e => {
        job.log.push(`! 실행 실패: ${e.message} (claude 명령을 찾지 못했다면 SR_CLAUDE_BIN 으로 경로를 지정하세요)`);
        resolve({ code: -1, spawnError: e.message });
      });
      child.on('close', code => resolve({ code }));

      /* 이어붙일 때는 프롬프트를 다시 밀어 넣지 않는다 — 세션에 이미 다 들어 있다.
         무엇 때문에 끊겼는지와 어디서부터 하면 되는지만 알려 준다. */
      child.stdin.end(resume ? RESUME_NOTE : prompt, 'utf8');
    });
  }

  /* 실패해도 결과물이 있으면 성공이다(기존 규칙 유지). 결과물이 없을 때만 재시도한다. */
  const madePdf = async () => {
    const after = await vault.detail(id);
    return Object.keys(after.files).find(r => r.startsWith('out/') && r.toLowerCase().endsWith('.pdf')) || null;
  };

  (async () => {
    let pdf = null, last = null;
    for (let n = 1; n <= RETRY_MAX + 1; n++) {
      job.attempt = n;
      if (n > 1) {
        job.log.push(`· 이어서 다시 시도 ${n - 1}/${RETRY_MAX} — 같은 세션(${job.sessionId.slice(0, 8)}…)에 이어붙입니다`);
        await markMeta(id, { attempt: n });
      }
      last = await runOnce(n > 1);
      job.code = last.code;
      pdf = await madePdf();
      if (pdf || job.stopped) break;

      /* 끊긴 것인지 진짜 실패인지 가른다. 끊긴 거면 자료도 .scratch 작업물도 그대로라
         이어서 하면 된다. 진짜 실패면 몇 번을 더 돌려도 같은 자리에서 죽는다. */
      const tail = job.log.slice(-40).join('\n');
      if (!TRANSIENT.test(tail) || n > RETRY_MAX) break;
      job.log.push(`! 네트워크로 끊긴 것으로 보입니다 — ${RETRY_WAIT / 1000}초 뒤 이어서 계속합니다.`);
      await new Promise(r => setTimeout(r, RETRY_WAIT));
      if (job.stopped) break;
    }

    job.endedAt = new Date().toISOString();
    job.status = pdf ? 'done' : 'failed';
    if (!pdf && !job.stopped) {
      job.log.push(`! ${job.attempt}번 시도했지만 out/ 에 PDF 가 없습니다 (마지막 종료코드 ${job.code}).`);
    }
    await markMeta(id, {
      status: job.status, endedAt: job.endedAt, pdf, exitCode: job.code,
      attempt: job.attempt, sessionId: job.sessionId,
      error: pdf ? null
        : job.stopped ? '중단됨'
        : `PDF 가 생성되지 않았습니다 (${job.attempt}번 시도, 종료코드 ${job.code})`,
    });
  })();

  return job;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const id = req.query && req.query.id ? vault.safeName(req.query.id) : null;
  if (!id) { res.status(400).json({ error: 'id 가 필요합니다.' }); return; }

  try {
    if (req.method === 'POST') {
      const job = await start(id);
      res.status(200).json({ ok: true, status: job.status, startedAt: job.startedAt, log: tail(job) });
      return;
    }

    if (req.method === 'GET') {
      const job = jobs.get(id);
      const info = await vault.detail(id);
      if (!job) { res.status(200).json({ status: info.report.status || 'none', report: info.report, log: '' }); return; }
      res.status(200).json({
        status: job.status, startedAt: job.startedAt, endedAt: job.endedAt,
        code: job.code, report: info.report, log: tail(job),
        attempt: job.attempt, retryMax: RETRY_MAX,
      });
      return;
    }

    if (req.method === 'DELETE') {
      const job = jobs.get(id);
      if (job && job.status === 'running') {
        /* stopped 를 먼저 세운다 — 이게 없으면 재시도 루프가 죽은 자식을
           '끊긴 것'으로 보고 20초 뒤에 되살린다. */
        job.stopped = true;
        if (job.child) job.child.kill();
        job.status = 'failed';
        job.log.push('! 사용자가 중단했습니다.');
        await markMeta(id, { status: 'failed', error: '중단됨' });
      }
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: 'GET · POST · DELETE 만 받습니다.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
