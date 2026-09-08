/*
 * 학교알리미 OpenAPI 중계 (Vercel 서버리스 함수)
 *
 * 왜 필요한가 — 학교알리미(schoolinfo.go.kr)는 응답에 CORS 헤더
 * (Access-Control-Allow-Origin)를 내려주지 않는다. 그래서 브라우저가 직접 부르면
 * 요청은 정상적으로 나가고 서버도 200 으로 답하지만, 브라우저가 응답 본문을
 * JS 에 넘겨주지 않는다(fetch → "Failed to fetch", no-cors → 본문 0바이트).
 * 실제 크롬으로 확인한 동작이며, 코드로는 우회할 수 없다.
 *
 * 이 함수가 브라우저 대신 호출해 준다. 프론트(/index.html)와 같은 도메인이라
 * 브라우저 입장에서는 동일 출처 요청이고, CORS 자체가 성립하지 않는다.
 * 덤으로 인증키가 브라우저로 나가지 않는다 — 원장들은 키 없이 URL 만 열면 된다.
 */

const UPSTREAM = 'https://www.schoolinfo.go.kr/openApi.do';

// 인증키는 여기 상수로 박아 둔다 — 클론해서 바로 쓰라는 뜻이다.
// 환경변수 SCHOOLINFO_API_KEY 를 주면 그쪽이 이긴다(키를 갈아끼울 때 쓴다).
const API_KEY = process.env.SCHOOLINFO_API_KEY || 'd2f2ab2ca1aa459ead14c548693e55ba';

// 프론트가 쓰는 파라미터만 통과시킨다. 임의 파라미터를 그대로 흘리면
// 이 엔드포인트가 아무 데나 쓸 수 있는 공개 프록시가 되어 버린다.
const ALLOWED = ['apiType', 'pbanYr', 'schulKndCode', 'sidoCode', 'sggCode'];

module.exports = async (req, res) => {
  const q = new URLSearchParams();
  for (const k of ALLOWED) {
    const v = req.query?.[k];
    if (v !== undefined && v !== '') q.set(k, String(v));
  }

  if (!q.has('apiType')) {
    res.status(400).json({ resultCode: 'fail', resultMsg: 'apiType 파라미터가 필요합니다.' });
    return;
  }
  q.set('apiKey', API_KEY);

  try {
    const upstream = await fetch(`${UPSTREAM}?${q}`, { signal: AbortSignal.timeout(15000) });
    const body = await upstream.text();

    // 공시 데이터는 연 단위로만 바뀐다 → CDN 에 30분 캐시.
    // 원장 여러 명이 같은 지역을 열어도 학교알리미로 나가는 호출은 사실상 한 번.
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, s-maxage=1800, stale-while-revalidate=86400');
    res.status(upstream.status).send(body);
  } catch (e) {
    const timedOut = e.name === 'TimeoutError' || e.name === 'AbortError';
    res.status(502).json({
      resultCode: 'fail',
      resultMsg: timedOut
        ? '학교알리미 응답이 없습니다(15초 초과). 잠시 후 다시 시도해 주세요.'
        : '학교알리미 호출 실패: ' + e.message,
    });
  }
};
