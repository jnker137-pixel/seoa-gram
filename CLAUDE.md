# seoa-gram Worker 작업 규칙

## ⚠️ 재발 패턴 경고 — 반드시 읽어라

**이 버그들은 이미 4번 재발했다.** 재발 원인: Claude Code가 worker/index.js를 블록 단위로 통째 재작성하면서 아래 핫픽스들을 "교과서 코드"로 복원.

**Worker 수정 원칙:**
- `worker/index.js` 전체를 새로 작성하지 마. **수정이 필요한 함수/섹션만 Edit 도구로 부분 수정.**
- 새 기능 추가 시 관련 provider 블록(callGemini, callClaude 등)을 통째로 재작성하지 마. 필요한 줄만 추가.
- 수정 전 이 파일 전체를 읽고, 아래 체크리스트 반드시 확인.

## 절대 변경 금지 (이유 포함)

### 1. Claude generic 캐릭터 — useWebSearch = false 고정
`handleGenericCharacter` 마지막 줄:
```js
return callClaude(model || "claude-sonnet-4-6", systemPrompt, messages, env, CLAUDE_GENERIC_WEB_SEARCH);
```
`CLAUDE_GENERIC_WEB_SEARCH` 상수가 `false`로 고정되어 있음. **절대 true로 바꾸지 마.**
→ `web_search_20250305` 툴은 일반 Anthropic API 키에서 차단됨. 바꾸면 "request not allowed" 즉시 에러.

### 2. Gemini — googleSearch tool 금지
`callGemini()` 본문에 `tools: [{ googleSearch: {} }]` 추가 금지.
`GEMINI_GOOGLE_SEARCH` 상수가 `false`로 고정되어 있음.
→ Cloudflare Worker가 한국 리전 IP로 라우팅될 때 "지역 사용 불가" 에러 발생. 이전에 두 번 재발한 버그.

### 3. OpenAI/GPT — beta tools 금지
GPT 호출 시 `tools`, `web_search_preview`, `reasoning` 등 beta 기능 추가 금지.
`OPENAI_BETA_TOOLS` 상수가 `false`로 고정되어 있음.
→ Cloudflare COLO가 HKG(홍콩)로 라우팅될 때 OpenAI "지역 사용 불가" 에러 발생.

### 4. DeepSeek 후처리 — cleanRoleplayOutput() 3곳 모두 필수
DeepSeek 응답이 반드시 `cleanRoleplayOutput()`을 통과해야 하는 경로:
- `handleGenericCharacter()` — deepseek provider 분기
- `handleHarin()` — 하린 전용 파이프라인
- `callCharacterForGroup()` — 단체 대화방 DeepSeek 분기

**3곳 중 하나라도 빠지면 연극톤 재발.** 프롬프트 금지만으론 부족함.

### 5. Gemini — 히스토리 타임스탬프 입력 전처리 필수
`handleGenericCharacter()`에서 Gemini 호출 시 messages의 assistant content에서 타임스탬프 제거.
```js
const geminiMessages = messages.map(m => ({
  role: m.role,
  content: m.role === "assistant" ? m.content.replace(timestampRe, "") : m.content,
}));
return callGemini(model, systemPrompt, geminiMessages, env);
```
→ api.ts가 히스토리에 `[2026.5.24. 09:30]` 형식을 붙여서 전달 → Gemini가 이 패턴을 모방해 응답에 날짜 붙임.
→ **callGemini() 출력에 후처리 금지** (정상 응답 깨짐 위험). 입력 전처리만 허용.

### 6. Cloudflare placement — mode="off" 고정 (절대 "smart"로 바꾸지 마)
`mode="smart"` → Cloudflare가 HKG(홍콩)에 Worker 배치 → Gemini "user location not supported" 에러.
한국 IP는 Gemini 사용 가능하지만 HKG 데이터센터 IP는 차단됨. (2026-05-25 wrangler tail GEO 로그로 확인)
`mode="off"` → Worker가 사용자(한국) 기준 ICN(서울)에서 실행 → 한국 IP로 Gemini 호출 → 정상.

### 7. provider/model 불일치 방지
`api_provider`를 바꿀 때 `model` 컬럼을 함께 바꾸지 않으면 오작동.
Worker에 불일치 안전장치 추가됨 (provider=claude인데 model=gemini-*이면 null로 리셋 → 기본값 사용).
캐릭터 DB 수정 시 provider와 model을 항상 같이 확인.

---

## 수정 후 체크리스트

파일 수정 시 반드시 확인:
- [ ] `CLAUDE_GENERIC_WEB_SEARCH` 상수가 `false`인가?
- [ ] `callGemini()` 본문에 `googleSearch` 없는가?
- [ ] `callGemini()` 호출 전 `geminiMessages`로 타임스탬프 제거하는가?
- [ ] `callGemini()` 기본 모델이 `gemini-2.5-flash`인가? (`gemini-3-flash-preview` 금지)
- [ ] DeepSeek 응답 3경로 모두 `cleanRoleplayOutput()` 적용되어 있는가?
- [ ] `handleHarin()` 마지막에 `cleanRoleplayOutput()` 있는가?
- [ ] 수정 후 `wrangler deploy` 실행했는가?

---

## 배포 명령

```bash
cd /workspaces/seoa-gram/worker && CLOUDFLARE_API_TOKEN=<토큰은 .env 또는 메모리 참조> npx wrangler deploy
```
