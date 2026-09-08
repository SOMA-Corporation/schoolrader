/* 접속 코드 — 랜딩(index.html)과 도구(app.html)가 같은 값을 봐야 하므로 한 곳에 둔다.

   확인은 브라우저 안에서만 일어난다 — 이 파일을 열면 코드가 그대로 보인다.
   아무나 못 들어오게 하는 잠금이 아니라 '링크를 받은 사람만 바로 쓰게' 하는 문턱이다.
   실제로 막아야 할 때가 오면 서버(api/)에서 확인하고 도구 자체를 그때 내려 줘야 한다.

   코드를 바꾸면 저장값이 달라져 모두에게 다시 묻는다 — 따로 초기화할 필요가 없다. */
const CODE = '1234';
const UNLOCK_KEY = 'schoolradar.unlocked';
const APP_URL = 'app.html';
const unlocked = () => { try { return localStorage.getItem(UNLOCK_KEY) === CODE; } catch { return false; } };
const pass = () => { try { localStorage.setItem(UNLOCK_KEY, CODE); } catch {} };
