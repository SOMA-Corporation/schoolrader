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
const jobs = new Map();              // id → {status, log[], startedAt, endedAt, child, code}

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
  const job = { status: 'running', log: [], startedAt: new Date().toISOString(), endedAt: null, code: null };
  jobs.set(id, job);
  await markMeta(id, { status: 'running', startedAt: job.startedAt, pdf: null, error: null });

  const child = spawn(CLAUDE, ARGS, {
    cwd: PROJECT,
    shell: process.platform === 'win32',   // 윈도에서 claude 는 .cmd 라 셸을 거쳐야 뜬다
    windowsHide: true,
    env: childEnv(),
  });
  job.child = child;

  /* stream-json 한 줄을 사람이 읽을 한 줄로. 모르는 형태면 원문을 그대로 남긴다 —
     진행 상황을 보려고 켠 것이라 조용히 버리는 쪽이 더 나쁘다. */
  const readable = line => {
    let ev;
    try { ev = JSON.parse(line); } catch { return line; }
    if (ev.type === 'system' && ev.subtype === 'init') return `· 시작 — 모델 ${ev.model || ''}`;
    if (ev.type === 'result') {
      const cost = ev.total_cost_usd != null ? ` · $${Number(ev.total_cost_usd).toFixed(3)}` : '';
      return `· 끝 — ${ev.subtype || ''}${cost}`;
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
  child.stdout.on('data', b => push('out', b));
  child.stderr.on('data', b => push('err', b));

  child.on('error', async e => {
    job.status = 'failed';
    job.endedAt = new Date().toISOString();
    job.log.push(`! 실행 실패: ${e.message} (claude 명령을 찾지 못했다면 SR_CLAUDE_BIN 으로 경로를 지정하세요)`);
    await markMeta(id, { status: 'failed', endedAt: job.endedAt, error: e.message });
  });

  child.on('close', async code => {
    job.code = code;
    job.endedAt = new Date().toISOString();
    const after = await vault.detail(id);
    const pdf = Object.keys(after.files).find(r => r.startsWith('out/') && r.toLowerCase().endsWith('.pdf'));
    // 종료코드보다 결과물을 믿는다 — PDF 가 생겼으면 성공이다
    job.status = pdf ? 'done' : 'failed';
    if (!pdf) job.log.push(`! 끝났지만 out/ 에 PDF 가 없습니다 (종료코드 ${code}).`);
    await markMeta(id, {
      status: job.status, endedAt: job.endedAt, pdf: pdf || null, exitCode: code,
      error: pdf ? null : `PDF 가 생성되지 않았습니다 (종료코드 ${code})`,
    });
  });

  child.stdin.end(prompt, 'utf8');
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
      });
      return;
    }

    if (req.method === 'DELETE') {
      const job = jobs.get(id);
      if (job && job.child && job.status === 'running') {
        job.child.kill();
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
