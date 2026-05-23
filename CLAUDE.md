# seoa-gram Worker 작업 규칙

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

---

## 수정 후 체크리스트

파일 수정 시 반드시 확인:
- [ ] `CLAUDE_GENERIC_WEB_SEARCH` 상수가 `false`인가?
- [ ] `callGemini()` 본문에 `googleSearch` 없는가?
- [ ] DeepSeek 응답 3경로 모두 `cleanRoleplayOutput()` 적용되어 있는가?
- [ ] `handleHarin()` 마지막에 `cleanRoleplayOutput()` 있는가?
- [ ] 수정 후 `wrangler deploy` 실행했는가?

---

## 배포 명령

```bash
cd /workspaces/seoa-gram/worker && CLOUDFLARE_API_TOKEN=<토큰은 .env 또는 메모리 참조> npx wrangler deploy
```
