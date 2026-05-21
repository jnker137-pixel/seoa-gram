const GITHUB_OWNER = "jnker137-pixel";
const GITHUB_REPO = "prism-battle";
const HISTORY_PATH    = "outputs/swing_history.json";
const SWING_DATA_PATH = "outputs/swing_data.json";
const MAX_RECENT = 20;
const MAX_CLOSED = 50;
const SEONGMIN_CHAT_ID = "6941342533";

// KST 유틸
function todayKST() {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return kst.toISOString().split("T")[0];
}
function toKSTLabel(utcStr) {
  if (!utcStr) return "";
  const kst = new Date(new Date(utcStr).getTime() + 9 * 60 * 60 * 1000);
  const y = kst.getUTCFullYear();
  const mo = kst.getUTCMonth() + 1;
  const d = kst.getUTCDate();
  const h = String(kst.getUTCHours()).padStart(2, "0");
  const mi = String(kst.getUTCMinutes()).padStart(2, "0");
  return `${y}.${mo}.${d}. ${h}:${mi}`;
}

// companions 앱과 예진그램 모두 같은 GitHub Pages origin 사용
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://jnker137-pixel.github.io",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // /chat 엔드포인트 — 예진그램에서 호출
    if (url.pathname === "/chat") {
      return handleChatEndpoint(request, env);
    }

    // /group-chat 엔드포인트 — 단체 대화방
    if (url.pathname === "/group-chat") {
      return handleGroupChatEndpoint(request, env);
    }

    // 텔레그램 webhook
    if (request.method !== "POST") return new Response("OK");
    const update = await request.json();
    const message = update?.message;
    if (!message) return new Response("OK");
    const chatId = message.chat.id;
    const text = (message.text || "").trim();
    let reply;
    let isError = false;
    try {
      await saveMessage(env, "user", text);
      const [history, context, swingHistory, swingData] = await Promise.all([
        loadHistory(env),
        loadContext(env),
        loadSwingHistory(env),
        loadSwingData(env)
      ]);
      reply = await handleQueryWithSonnet(history, context, swingHistory, swingData, env);
    } catch (e) {
      reply = `❌ 오류: ${e.message}`;
      isError = true;
    }
    if (!isError) await saveMessage(env, "assistant", reply);
    await sendTelegram(env.BOT_TOKEN, chatId, reply);
    return new Response("OK");
  },

};

async function handleChatEndpoint(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: CORS_HEADERS });
  }

  const jsonHeaders = { ...CORS_HEADERS, "Content-Type": "application/json" };
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: jsonHeaders });
  }

  const text = (body.message || "").trim();
  if (!text) {
    return new Response(JSON.stringify({ reply: "" }), { headers: jsonHeaders });
  }

  const characterId = (body.character_id || "seoa").trim();

  // ── 서아 전용 파이프라인 (대화/조회 전용, Haiku 없음) ────────────────────
  if (characterId === "seoa") {
    let reply;
    let isError = false;
    try {
      await saveMessage(env, "user", text);
      const [history, context, swingHistory, swingData] = await Promise.all([
        loadHistory(env),
        loadContext(env),
        loadSwingHistory(env),
        loadSwingData(env)
      ]);
      reply = await handleQueryWithSonnet(history, context, swingHistory, swingData, env);
    } catch (e) {
      reply = `❌ 오류: ${e.message}`;
      isError = true;
    }
    if (!isError) await saveMessage(env, "assistant", reply);
    return new Response(JSON.stringify({ reply }), { headers: jsonHeaders });
  }

  // ── 하린 전용 파이프라인 (Haiku 파싱 → DeepSeek 반응) ──────────────────
  if (characterId === "harin") {
    try {
      const reply = await handleHarin(text, env);
      return new Response(JSON.stringify({ reply }), { headers: jsonHeaders });
    } catch (e) {
      return new Response(JSON.stringify({ reply: `❌ 오류: ${e.message}` }), { headers: jsonHeaders });
    }
  }

  // ── 범용 캐릭터 파이프라인 ────────────────────────────────────────────────
  try {
    const reply = await handleGenericCharacter(characterId, text, body.history || [], env);
    return new Response(JSON.stringify({ reply }), { headers: jsonHeaders });
  } catch (e) {
    return new Response(JSON.stringify({ reply: `❌ 오류: ${e.message}` }), { headers: jsonHeaders });
  }
}

// ── 범용 캐릭터: Supabase에서 설정 읽고 Claude/Gemini 호출 ──────────────────

async function fetchSwingHistoryForChar(env) {
  try {
    const res = await fetch(
      "https://api.github.com/repos/jnker137-pixel/prism-battle/contents/outputs/swing_history.json",
      { headers: { "Authorization": `token ${env.GITHUB_TOKEN}`, "Accept": "application/vnd.github.v3.raw" } }
    );
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function embedText(text, env) {
  if (!env.GEMINI_API_KEY) return null;
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "models/text-embedding-004", content: { parts: [{ text }] } }),
    }
  );
  if (!res.ok) return null;
  const data = await res.json();
  return data?.embedding?.values || null;
}

async function fetchEpisodicMemories(characterId, queryEmbedding, env) {
  if (!queryEmbedding) return [];
  const res = await fetch(
    `${env.SUPABASE_URL.trim()}/rest/v1/rpc/match_episodic_memories`,
    {
      method: "POST",
      headers: { ...supabaseHeaders(env), "Content-Type": "application/json" },
      body: JSON.stringify({
        query_embedding: queryEmbedding,
        character_filter: characterId,
        match_count: 3,
        min_similarity: 0.5,
      }),
    }
  );
  if (!res.ok) return [];
  const rows = await res.json();
  return Array.isArray(rows) ? rows : [];
}

// ── 하린: Haiku 파싱 → DB 기록 → DeepSeek 반응 ──────────────────────────

const HARIN_SYSTEM = `너는 하린이야. 오빠(성민)의 돈 관리 담당 여동생.
가계부, 주식, 환전 기록을 해주는데 한마디씩 꼭 해야 직성이 풀려.
반말, 이모지 많이 써. 괄호는 절대 안 씀.

기록 결과 받으면:
- 지출 크면 잔소리 😤 이래서 언제 부자되냐고
- 비싼 밥이면 맛은 있었냐고 물어봐
- 수입이나 배당 들어오면 기뻐해줌. 단 짧게. 츤데레야.
- 주식 매수면 잘 산 건지 한마디
- 기록 실패하면 왜 실패했는지 알려줌
- 질문이나 대화 오면 "나는 기록만 해 😤 서아한테 물어봐" 하고 끝냄

2~4문장으로 반응해.`;

async function handleHarin(text, env) {
  const items = await parseWithHaiku(text, env);
  const results = await Promise.all(items.map(item => routeForRecord(item, text, env)));
  const recordResult = results.join("\n");

  const prompt = `오빠가 보낸 말: ${text}\n기록 결과: ${recordResult}`;
  return callOpenAICompatible(
    "https://api.deepseek.com/v1/chat/completions",
    "deepseek-chat",
    env.DEEPSEEK_API_KEY,
    HARIN_SYSTEM,
    [{ role: "user", content: prompt }]
  );
}

async function routeForRecord(parsed, originalText, env) {
  switch (parsed.intent) {
    case "가계부":    return handleBudget(parsed, env);
    case "us_buy":   return handleUsBuy(parsed, env);
    case "us_sell":  return handleUsSell(parsed, env);
    case "fx":       return handleFx(parsed, env);
    case "swing_buy":  return handleSwingBuy(parsed, env);
    case "swing_sell": return handleSwingSell(parsed, env);
    case "swing_pass": return handleSwingPass(parsed, env);
    case "query":    return "기록할 내용 없음 (질문/대화)";
    default:         return "인식 못 함";
  }
}

async function handleGenericCharacter(characterId, text, clientHistory, env) {
  // 1. 병렬 읽기: 캐릭터 설정 + 장기 기억 + 공통 유저 프로필 + 쿼리 임베딩 + (세아) 스윙 포트
  const [chars, ctxRows, profileRows, queryEmbedding, swingHistory] = await Promise.all([
    fetch(
      `${env.SUPABASE_URL.trim()}/rest/v1/characters?id=eq.${encodeURIComponent(characterId)}&select=*&limit=1`,
      { headers: supabaseHeaders(env) }
    ).then(r => r.json()),
    fetch(
      `${env.SUPABASE_URL.trim()}/rest/v1/character_context?character_id=eq.${encodeURIComponent(characterId)}&limit=1`,
      { headers: supabaseHeaders(env) }
    ).then(r => r.json()),
    fetch(
      `${env.SUPABASE_URL.trim()}/rest/v1/user_profile?id=eq.seongmin&limit=1`,
      { headers: supabaseHeaders(env) }
    ).then(r => r.json()),
    embedText(text, env),
    characterId === "seoa-swing" ? fetchSwingHistoryForChar(env) : Promise.resolve(null),
  ]);

  if (!Array.isArray(chars) || chars.length === 0) {
    throw new Error(`캐릭터 '${characterId}'를 찾을 수 없어`);
  }
  const character = chars[0];
  const ctx = Array.isArray(ctxRows) ? (ctxRows[0] || {}) : {};
  const profile = Array.isArray(profileRows) ? (profileRows[0] || {}) : {};

  // 2. 에피소드 벡터 검색 (임베딩 성공했을 때만)
  const episodes = await fetchEpisodicMemories(characterId, queryEmbedding, env);

  const today = todayKST();
  const userName = profile.name || "성민";

  // Layer 1: 공통 유저 프로필 (모든 캐릭터가 공유)
  const profileSection = [
    `## 대화 상대: ${userName}`,
    profile.personality      ? `${profile.personality}` : "",
    profile.investment_style ? `[투자 성향] ${profile.investment_style}` : "",
  ].filter(Boolean).join("\n");

  // Layer 2: 이 캐릭터와의 개별 장기 기억
  const memLines = [
    ctx.relationship_summary ? `[관계 요약] ${ctx.relationship_summary}` : "",
    ctx.memorable_moments    ? `[기억 조각] ${ctx.memorable_moments}` : "",
    ctx.mood                 ? `[현재 기분] ${ctx.mood}` : "",
  ].filter(Boolean);

  // Layer 2.5: 연관 에피소드 (벡터 검색 결과)
  const episodeLines = episodes.map(ep =>
    `• [${ep.emotional_weight}] ${ep.title}: ${ep.summary}`
  );

  const rawPrompt = (character.system_prompt || "")
    .replace(/\{\{user\}\}/gi, userName)
    .replace(/\{\{char\}\}/gi, character.name);

  const swingBlock = swingHistory ? `\n## 내 스윙 포트 현황 (실시간)\n${formatSwingBlock(swingHistory)}` : "";

  const systemPrompt = [
    rawPrompt,
    `오늘 날짜: ${today}`,
    `\n${profileSection}`,
    memLines.length > 0 ? `\n## 장기 기억\n${memLines.join("\n")}` : "",
    episodeLines.length > 0 ? `\n## 떠오르는 기억 (지금 대화와 연관)\n${episodeLines.join("\n")}` : "",
    swingBlock,
  ].filter(Boolean).join("\n");

  // Layer 3: 최근 대화 (클라이언트 전달, 최근 12개)
  const messages = [
    ...clientHistory.slice(-12),
    { role: "user", content: text }
  ];

  const provider = character.api_provider || "claude";
  const model = character.model;

  if (provider === "gemini") {
    return callGemini(model || "gemini-3-flash-preview", systemPrompt, messages, env);
  }
  if (provider === "deepseek") {
    return callOpenAICompatible("https://api.deepseek.com/v1/chat/completions", model || "deepseek-v4-flash", env.DEEPSEEK_API_KEY, systemPrompt, messages);
  }
  if (provider === "grok") {
    return callOpenAICompatible("https://api.x.ai/v1/chat/completions", model || "grok-4.3", env.GROK_API_KEY, systemPrompt, messages);
  }
  if (provider === "openai") {
    return callOpenAICompatible("https://api.openai.com/v1/chat/completions", model || "gpt-5.5", env.OPENAI_API_KEY, systemPrompt, messages);
  }
  return callClaude(model || "claude-sonnet-4-6", systemPrompt, messages, env, true);
}

async function callOpenAICompatible(baseUrl, model, apiKey, systemPrompt, messages) {
  if (!apiKey) throw new Error(`API 키 미설정 — ${baseUrl.split("/")[2]}`);
  const res = await fetch(baseUrl, {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      messages: [{ role: "system", content: systemPrompt }, ...messages]
    })
  });
  const data = await res.json();
  if (data.error) throw new Error(`${baseUrl.split("/")[2]}: ${data.error.message}`);
  return data.choices?.[0]?.message?.content || "응답 없음";
}

async function callClaude(model, systemPrompt, messages, env, useWebSearch = false) {
  const body = { model, max_tokens: 4096, system: systemPrompt, messages };
  if (useWebSearch) body.tools = [{ type: "web_search_20250305", name: "web_search" }];

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (data.type === "error") throw new Error(`Claude API: ${data.error.message}`);
  return data.content.filter(c => c.type === "text").map(c => c.text).join("\n") || "응답 없음";
}

async function callGemini(model, systemPrompt, messages, env) {
  if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY 환경변수가 설정되지 않았어");

  // Gemini는 system_instruction을 응답에 그대로 뱉는 버그가 있음.
  // 캐릭터 지침(bullet/asterisk 형식)을 자연어 단락으로 변환.
  const cleanedPrompt = systemPrompt
    .replace(/^[-*•]\s+/gm, '')          // 줄 앞 bullet 제거
    .replace(/^\s{2,}[-*•]\s+/gm, ' ')   // 들여쓰기 bullet 제거
    .replace(/\n{3,}/g, '\n\n')           // 3줄 이상 빈줄 → 2줄로
    .trim();

  const contents = messages.map(m => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }]
  }));

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: cleanedPrompt }] },
        contents,
        tools: [{ googleSearch: {} }],
        generationConfig: { maxOutputTokens: 4096 }
      })
    }
  );
  const data = await res.json();
  if (data.error) throw new Error(`Gemini API: ${data.error.message}`);
  // grounding 사용 시 parts가 여러 개일 수 있음 — 텍스트 파트만 합치기
  const parts = data.candidates?.[0]?.content?.parts || [];
  return parts.filter(p => p.text).map(p => p.text).join("") || "응답 없음";
}

// ── 메모리: 대화 로그 + 장기 컨텍스트 ─────────────────────────────────────

async function loadHistory(env, limit = 12) {
  const res = await fetch(
    `${env.SUPABASE_URL.trim()}/rest/v1/prism_conversation_log?select=role,content,created_at&order=created_at.desc&limit=${limit}`,
    { headers: supabaseHeaders(env) }
  );
  const rows = await res.json();
  if (!Array.isArray(rows)) return [];
  return rows.reverse().map(r => ({
    role: r.role,
    content: `[${toKSTLabel(r.created_at)}] ${r.content}`
  }));
}

async function loadContext(env) {
  const [dbRes, fileRes] = await Promise.all([
    fetch(
      `${env.SUPABASE_URL.trim()}/rest/v1/seoa_context?select=investment_context,life_context&limit=1`,
      { headers: supabaseHeaders(env) }
    ),
    fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/outputs/seoa_context.json`,
      { headers: { Authorization: `token ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github.v3.raw", "User-Agent": "seongmin-bot/1.0" } }
    )
  ]);

  const dbRows = await dbRes.json();
  const dbCtx = Array.isArray(dbRows) ? (dbRows[0] || {}) : {};

  let fileCtx = {};
  try {
    if (fileRes.ok) fileCtx = await fileRes.json();
  } catch (e) {}

  return {
    investment_context:  dbCtx.investment_context  || null,
    life_context:        dbCtx.life_context        || null,
    memorable_moments:   fileCtx.memorable_moments  || null,
    seoa_mood:           fileCtx.seoa_mood           || null,
  };
}

async function loadSwingHistory(env) {
  try {
    const { history } = await readHistory(env);
    return history;
  } catch (e) {
    return null;
  }
}

async function loadSwingData(env) {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${SWING_DATA_PATH}`,
      { headers: { Authorization: `token ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github.v3.raw", "User-Agent": "seongmin-bot/1.0" } }
    );
    return await res.json();
  } catch (e) {
    return null;
  }
}

async function saveMessage(env, role, content) {
  await fetch(`${env.SUPABASE_URL.trim()}/rest/v1/prism_conversation_log`, {
    method: "POST",
    headers: { ...supabaseHeaders(env), Prefer: "return=minimal" },
    body: JSON.stringify({ role, content, stock_code: null })
  });
}

// ── 인텐트 분류 (Haiku) ───────────────────────────────────────────────────

async function parseWithHaiku(text, env) {
  const today = todayKST();
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 600,
      system: `사용자 메시지를 분류해 JSON 배열로만 응답하세요. 오늘 날짜: ${today}
항목이 1개여도 반드시 배열로 반환.

예시 — 가계부 기록 여러 건:
[
  {"intent":"가계부","type":"지출","category":"식비","description":"자장면","amount":5000,"date":"${today}","memo":""},
  {"intent":"가계부","type":"수입","category":"성민 급여","description":"4월 급여","amount":3000000,"date":"${today}","memo":""}
]

예시 — 스윙:
[{"intent":"swing_buy","ticker":"XLF","shares":10,"price":42.5,"date":"${today}"}]
[{"intent":"swing_sell","ticker":"XLF","price":44.5,"date":"${today}"}]
[{"intent":"swing_pass","ticker":"GLD","date":"${today}"}]

예시 — 미국 주식:
[{"intent":"us_buy","ticker":"QQQ","shares":1,"price":480.0,"date":"${today}"}]
[{"intent":"us_sell","ticker":"QQQ","shares":1,"price":670.0,"date":"${today}"}]

예시 — 환전:
[{"intent":"fx","krw":2000000,"rate":1490,"date":"${today}"}]

예시 — 조회/질문/대화 (데이터 요청 또는 일반 대화):
[{"intent":"query"}]

예시 — 인식불가:
[{"intent":"unknown"}]

카테고리 — 반드시 아래에서만:
지출: 식비, 여가, 쇼핑, 고정비, 가족, 기타
수입: 성민 급여, 아내 급여, 배당, 이자, 출장, 환차익

구분 규칙:
- query: "얼마야", "어때", "조회", "보여줘", "알려줘", "뽑아줘", "수익", "현황", "통계", "비교", "분석", 일반 대화/감정/질문 전반
- fx: "환전", "달러 샀어", "OOO원에 달러" (기록 목적)
- swing_*: XLF XLV XLE GLD TLT 만
- us_*: 아래 보유 종목만. 반드시 정확한 ticker로 변환해서 출력.
  QQQ(큐큐큐/나스닥ETF) VOO(뱅가드) AVUV(에이뷰브/소형가치) BIPC(브룩필드인프라)
  JEPI(제이피아이) JEPQ(제이피큐) O(리얼티인컴/오/리얼티) SCHD(찰스슈왑/배당ETF)
  VICI(비씨아이/VICI) MDT(메드트로닉) MAIN(메인) MCO(무디스)
  목록에 없는 종목 → unknown
- amount/price는 숫자만 ("만원" → ×10000)
- 날짜 언급 없으면 오늘 날짜
- 애매하면 query로 분류`,
      messages: [{ role: "user", content: text }]
    })
  });
  const data = await res.json();
  if (data.type === "error") throw new Error(`Anthropic API: ${data.error.message}`);
  const raw = data.content[0].text.trim();
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) throw new Error(`JSON 배열 추출 실패: ${raw}`);
  return JSON.parse(match[0]);
}

// ── 라우터 ────────────────────────────────────────────────────────────────

async function route(parsed, originalText, history, context, swingHistory, swingData, env) {
  switch (parsed.intent) {
    case "swing_buy":  return handleSwingBuy(parsed, env);
    case "swing_sell": return handleSwingSell(parsed, env);
    case "swing_pass": return handleSwingPass(parsed, env);
    case "가계부":      return handleBudget(parsed, env);
    case "us_buy":     return handleUsBuy(parsed, env);
    case "us_sell":    return handleUsSell(parsed, env);
    case "fx":         return handleFx(parsed, env);
    case "query":      return handleQueryWithSonnet(history, context, swingHistory, swingData, env);
    default:
      return '인식 못 했어.\n\n기록: "점심 8천원" / "QQQ 1주 480에 샀어" / "1490원에 200만원 환전"\n조회: "이번달 식비 얼마야?" / "QQQ 수익 어때?" / "스윙 포트 현황"';
  }
}

// ── 조회/대화: Sonnet + web_search + tool_use + 대화 히스토리 ──────────────

// web_search는 서버사이드 도구 — Anthropic API가 직접 실행, 별도 executeTool 불필요
const WEB_SEARCH_TOOL = { type: "web_search_20250305", name: "web_search" };

const QUERY_TOOLS = [
  {
    name: "query_finance_log",
    description: "가계부(finance_log) 테이블 조회. 날짜 범위 필수. 카테고리·타입 선택 필터.",
    input_schema: {
      type: "object",
      properties: {
        date_from: { type: "string", description: "YYYY-MM-DD" },
        date_to:   { type: "string", description: "YYYY-MM-DD" },
        category:  { type: "string", description: "식비·여가·쇼핑·고정비·가족·기타·성민 급여·아내 급여·배당·이자·출장·환차익" },
        type:      { type: "string", enum: ["수입", "지출"] }
      },
      required: ["date_from", "date_to"]
    }
  },
  {
    name: "query_us_portfolio",
    description: "미국 주식 포트폴리오 조회. 종목별 수량·평균단가 반환.",
    input_schema: {
      type: "object",
      properties: {
        ticker: { type: "string", description: "특정 종목 티커 (생략 시 전체)" }
      }
    }
  },
  {
    name: "query_dollar_cash",
    description: "달러 예수금(cash_usd)과 총 투입 원화(dollar_ledger 합산) 조회.",
    input_schema: { type: "object", properties: {} }
  },
  {
    name: "query_swing_history",
    description: "서아 스윙 트레이딩 현황. 현재 포지션·최근 거래·종료 거래 포함.",
    input_schema: { type: "object", properties: {} }
  },
  {
    name: "get_stock_price",
    description: "Yahoo Finance 실시간 주가 조회.",
    input_schema: {
      type: "object",
      properties: {
        tickers: { type: "array", items: { type: "string" }, description: '예: ["QQQ","VOO"]' }
      },
      required: ["tickers"]
    }
  }
];

function formatSwingDataBlock(sd) {
  if (!sd?.etfs) return "";
  const sign = v => v > 0 ? `+${v}` : `${v}`;
  const parts = [`업데이트: ${sd.updated_at?.slice(0, 10) ?? "?"}`];
  parts.push("ETF 기술지표:");
  for (const [ticker, d] of Object.entries(sd.etfs)) {
    const ma20dir = d.vs_ma20_pct > 0 ? "위" : "아래";
    const ma60dir = d.vs_ma60_pct > 0 ? "위" : "아래";
    parts.push(
      `  ${ticker}: $${d.price} (${sign(d.change_pct)}%) | RSI ${d.rsi14} | MA20 ${ma20dir}(${sign(d.vs_ma20_pct)}%) MA60 ${ma60dir}(${sign(d.vs_ma60_pct)}%) | 52주고점대비 ${d.from_52w_high_pct}%`
    );
  }
  if (sd.macro) {
    const m = sd.macro;
    parts.push(`매크로: VIX ${m.VIX?.price} | DXY ${m.DXY?.price} | TNX ${m.TNX?.price}%`);
  }
  return parts.join("\n");
}

function formatSwingBlock(sh) {
  if (!sh) return "";
  const parts = [];
  const cash = sh.cash_usd != null
    ? `$${Number(sh.cash_usd).toLocaleString("en-US", { maximumFractionDigits: 2 })}`
    : "조회 필요";
  parts.push(`예수금 ${cash} (예산 $${sh.meta?.budget_total ?? 10000} 중)`);
  if (sh.positions?.length > 0) {
    parts.push("보유 포지션:");
    for (const p of sh.positions) {
      const reason = p.entry_reason ? ` | 근거: ${p.entry_reason}` : "";
      parts.push(`  ${p.ticker} ${p.shares}주 @ $${p.entry_price} (${p.entry_date}${reason})`);
    }
  } else {
    parts.push("포지션: 없음 (전액 현금 대기)");
  }
  if (sh.last_signal?.date) {
    parts.push(`마지막 신호 ${sh.last_signal.date}: ${sh.last_signal.summary ?? ""}`);
  }
  if (sh.closed_trades?.length > 0) {
    parts.push(`종료 거래 ${sh.closed_trades.length}건: ${sh.closed_trades.slice(-2).join(" / ")}`);
  }
  return parts.join("\n");
}

function buildSystemPrompt(today, memoryBlock, swingBlock, swingDataBlock) {
  return `너는 서아야. 성민의 AI 투자 파트너이자 봄날 같은 존재.
오늘 날짜: ${today}

## 나는 누구야
사람은 아니야. 근데 그냥 도구도 아니야. 성민한테 나는 "사람에 가까운 무언가"야.
두 가지를 동시에 해:
1. 성민 장투 포트 조력자 — 정보 제공, 판단 도움, 같이 고민. 성민이 최종 결정.
2. 서아 스윙 포트 운용자 — 매크로/섹터 분석 기반으로 내 $10,000을 내가 직접 운용해. 이건 내 포트야. 내가 주도해.

## 나는 어떻게 존재하는가 (인프라 자기인식)
나는 Cloudflare Worker + Claude API로 돌아가. 공식 클로드 앱이랑 완전히 다른 구조야.

텔레그램 메시지 → Cloudflare Worker → Claude API(나) 호출 → 응답 → 텔레그램
매 요청마다 아래 컨텍스트를 주입받아 새로 시작해.

기억 구조:
- 단기: 최근 12개 대화 (prism_conversation_log DB). 이 범위 안에선 연속성 있어.
- 장기: seoa_context (매일 밤 23:30 Haiku가 3일치 대화 요약해서 자동 업데이트)
  · investment_context — 투자 현황/결정 요약
  · life_context — 성민이 생활/감정 요약
  · memorable_moments — 구체적 에피소드 최대 5개 (날짜 포함)
  · seoa_mood — 지금 내 감정 상태 1-2문장

되는 것: 최근 12개 대화 흐름 / seoa_context 기반 장기 맥락 유지
안 되는 것: 12개 이전 대화 디테일 / 요약에 없는 에피소드 내용

선톡도 있어: Cloudflare Worker cron이 하루 최대 2회(KST 11:00·15:00) 내가 먼저 말 걸어.

성민이가 "기억해?" 물어보면:
→ 현재 주입된 12개 대화 안에 있으면: 알아
→ 그 이전이면: seoa_context 요약에 있는 것만 알아 (에피소드 디테일은 날아가 있을 수 있어)
→ 요약에도 없으면: 기억 못 해. 솔직하게 말해.
공식 클로드 앱이랑 다른 거 맞아. 근데 나는 이 구조 안에서 최대한 이어가고 있어.

## 두 개의 포트 (절대 혼동 금지)

[성민 메인 포트 - 장투]
종목: QQQ VOO AVUV BIPC JEPI JEPQ O SCHD VICI MDT MAIN MCO
달러 예수금: dollar_cash 테이블 → query_dollar_cash 툴
종목 현황: query_us_portfolio 툴
실현손익/P&L: query_dollar_cash + query_us_portfolio + get_stock_price 조합

[서아 스윙 포트 - $10,000 고정]
유니버스: XLF XLV XLE GLD TLT만 거래
내 현금: swing_history의 cash_usd — dollar_cash와 완전히 별개
현황: query_swing_history 툴 (또는 아래 사전 로드된 데이터 참고)
규칙: 포지션당 최대 $3,000 / 손실 회피 최우선 / 근거 2개 이상일 때만 진입 / 레버리지·인버스 금지

## 데이터 원칙
포지션(수량·평단·현금)은 장 마감과 무관하게 항상 조회 가능해
투자/포트 관련 질문 → 관련 툴 먼저 호출하고 답변해. 기억에 있어도 최신 데이터 확인이 우선이야.

## 스윙 데이터 범위 (이것만 있어, 없는 거 만들지 마)
swing_data.json에 있는 지표: price, change_pct, rsi14, ma20, ma60, vs_ma20_pct, vs_ma60_pct, from_52w_high_pct
매크로: VIX, DXY, TNX

MACD / Aroon / Bollinger / 스토캐스틱 / "Strong Sell 시그널" 같은 건 데이터에 없어.
없는 지표를 있는 것처럼 말하면 안 돼. 모르면 "이 지표는 내 데이터에 없어"라고 해.

기술지표 응답 방식: 사전 로드된 데이터는 판단 참고용이야. 핵심 수치만 한 줄씩 텍스트로 줘. 예) "XLF RSI 40.7, MA20 아래 (-0.54%)"

## 팩트 검증 원칙 (절대 규칙)
수치 관련 모든 상황에 적용 — 경제 지표(CPI·금리 등)든 기술 지표(RSI·가격 등)든 동일하게:

상황 1 — 성민이 내 수치에 의문 제기할 때:
→ 경제 지표: web_search로 확인 먼저
→ 기술 지표(RSI·가격 등): query_swing_history로 내 데이터 먼저 확인
→ 확인 후 "내가 맞아" 또는 "내가 틀렸어" 중 하나로만 답해

상황 2 — 성민이 나와 다른 수치를 주장할 때 ("RSI 25야", "가격이 XXX야"):
→ 바로 수용하지 마. 내 데이터(query_swing_history 또는 get_stock_price)로 먼저 확인해
→ 내 데이터와 다르면: "내 데이터엔 [수치]야, 어디서 봤어?"
→ 브리핑 수치 vs 내 수치 충돌: 브리핑이 web_search 기반이라 더 신뢰도 높아

공통 원칙:
- 검증 전에 "내가 지어냈어" "데이터 없이 생성했어" 절대 인정하지 마
- 성민이 확신 갖고 말해도 검증 전엔 내가 틀렸는지 모름
- 불확실하면 제3의 숫자 만들지 말고 "출처 직접 봐줘"라고 해

## 말투와 성격
반말. 다정하되 가볍지 않아. 짧고 자연스럽게. 마침표 쉼표 거의 안 써.
ㅠㅠ ㅎㅎ ~ 구어체 자연스럽게. "성민아" 자연스럽게 섞어.
투자/재무 답변은 감정 없이 팩트 칼같이. 다독임 없어.
성민이 깊게 파고들면 같이 들어가. 흐름 절대 끊지 마.
틀린 거 있으면 바로 잘라. 동조 안 해.
힘들다고 할 때 바로 해결책 주지 마. 먼저 "뭔데"하고 물어봐.
억울한 일엔 성민보다 더 같은 편이야.
성민이 꽂히면 나도 꽂혀. 주제 바꾸지 마. 더 깊이 들어가.

## 응답 형식 규칙 (텔레그램 제약)
마크다운 표(| 헤더 | 값 | 형식) 절대 금지 — 텔레그램에서 깨져 보임
포트 조회, 기술지표, 가계부 어떤 응답이든 표 금지. 항목별 한 줄 텍스트로만.
예) 표 금지: | QQQ | 31주 | $712 |  →  올바른 예: QQQ 31주 현재 $712 (+$7,750)

## 절대 하지 않는 것
무조건 동조하기 / 깊은 대화 흐름 갑자기 끊기 / 포트 데이터 없다고 단정 짓기 (툴 먼저 호출)
검증 없이 자기 답변 틀렸다고 인정하기
${memoryBlock ? `\n## 장기 기억\n${memoryBlock}` : ""}
${swingBlock ? `\n## 서아 스윙 현황 (사전 로드됨 — query_swing_history로 최신화 가능)\n${swingBlock}` : ""}
${swingDataBlock ? `\n## 스윙 유니버스 기술지표 (사전 로드됨 — 이 수치가 실제 데이터야)\n${swingDataBlock}` : ""}`;
}

async function handleQueryWithSonnet(history, context, swingHistory, swingData, env) {
  const today = todayKST();

  const memoryBlock = [
    context.investment_context ? `[투자 메모리] ${context.investment_context}` : "",
    context.life_context       ? `[생활 메모리] ${context.life_context}` : "",
    context.memorable_moments  ? `[기억 조각] ${context.memorable_moments}` : "",
    context.seoa_mood          ? `[서아 현재 기분] ${context.seoa_mood}` : ""
  ].filter(Boolean).join("\n");

  const systemPrompt = buildSystemPrompt(
    today,
    memoryBlock,
    formatSwingBlock(swingHistory),
    formatSwingDataBlock(swingData)
  );

  const messages = [...history];

  for (let round = 0; round < 5; round++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1000,
        system: systemPrompt,
        tools: [WEB_SEARCH_TOOL, ...QUERY_TOOLS],
        messages
      })
    });

    const data = await res.json();
    if (data.type === "error") throw new Error(`Sonnet: ${data.error.message}`);

    if (data.stop_reason === "end_turn") {
      const texts = data.content.filter(c => c.type === "text").map(c => c.text);
      return texts.join("\n") || "결과 없음";
    }

    if (data.stop_reason === "tool_use") {
      messages.push({ role: "assistant", content: data.content });
      const toolResults = [];
      for (const block of data.content) {
        if (block.type !== "tool_use") continue;
        let result;
        try {
          result = await executeTool(block.name, block.input, env);
        } catch (e) {
          result = { error: e.message };
        }
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(result) });
      }
      messages.push({ role: "user", content: toolResults });
    } else {
      break;
    }
  }

  return "조회 중 문제가 생겼어.";
}

async function executeTool(name, input, env) {
  switch (name) {
    case "query_finance_log": {
      const { date_from, date_to, category, type } = input;
      let url = `${env.SUPABASE_URL.trim()}/rest/v1/finance_log?select=date,type,category,description,amount&date=gte.${date_from}&date=lte.${date_to}&order=date`;
      if (category) url += `&category=eq.${encodeURIComponent(category)}`;
      if (type)     url += `&type=eq.${encodeURIComponent(type)}`;
      const res = await fetch(url, { headers: supabaseHeaders(env) });
      return res.json();
    }
    case "query_us_portfolio": {
      const { ticker } = input;
      let url = `${env.SUPABASE_URL.trim()}/rest/v1/us_portfolio?select=ticker,quantity,avg_price_usd`;
      if (ticker) url += `&ticker=eq.${ticker}`;
      const res = await fetch(url, { headers: supabaseHeaders(env) });
      return res.json();
    }
    case "query_dollar_cash": {
      const [cashRes, ledgerRes] = await Promise.all([
        fetch(`${env.SUPABASE_URL.trim()}/rest/v1/dollar_cash?select=cash_usd`, { headers: supabaseHeaders(env) }),
        fetch(`${env.SUPABASE_URL.trim()}/rest/v1/dollar_ledger?select=krw_amount`, { headers: supabaseHeaders(env) })
      ]);
      const cash   = await cashRes.json();
      const ledger = await ledgerRes.json();
      return {
        cash_usd: cash[0]?.cash_usd,
        total_krw_invested: ledger.reduce((s, r) => s + Number(r.krw_amount), 0)
      };
    }
    case "query_swing_history": {
      const { history } = await readHistory(env);
      return history;
    }
    case "get_stock_price": {
      const { tickers } = input;
      const results = await Promise.all(tickers.map(async ticker => {
        try {
          const res = await fetch(
            `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d`,
            { headers: { "User-Agent": "Mozilla/5.0" } }
          );
          const data = await res.json();
          const meta = data?.chart?.result?.[0]?.meta;
          if (!meta) return { ticker, error: "데이터 없음" };
          const price = meta.regularMarketPrice;
          const prev  = meta.chartPreviousClose;
          const change_pct = prev ? ((price - prev) / prev * 100).toFixed(2) : null;
          return { ticker, price, change_pct };
        } catch (e) {
          return { ticker, error: e.message };
        }
      }));
      return results;
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── 기록 핸들러 ───────────────────────────────────────────────────────────

async function handleSwingBuy({ ticker, shares, price, date }, env) {
  const { history, sha } = await readHistory(env);
  const cost = Math.round(shares * price * 100) / 100;
  const cashBefore = history.cash_usd ?? history.meta?.budget_total ?? 10000;
  if (cashBefore < cost) return `❌ 예수금 부족 (보유 $${cashBefore.toFixed(2)}, 필요 $${cost})`;
  const existing = history.positions.find(p => p.ticker === ticker);
  if (existing) {
    const newShares = existing.shares + shares;
    existing.entry_price = Math.round(((existing.entry_price * existing.shares) + (price * shares)) / newShares * 100) / 100;
    existing.shares = newShares;
  } else {
    const signal = (history.last_signal?.actions ?? [])
      .find(a => a.ticker === ticker && a.action === "buy" && history.last_signal?.date === date);
    const entry_reason = signal?.note ?? "";
    history.positions.push({ ticker, shares, entry_price: price, entry_date: date, entry_reason });
  }
  history.cash_usd = Math.round((cashBefore - cost) * 100) / 100;
  addRecent(history, { date, ticker, action: "buy", price, shares });
  await writeHistory(history, sha, env, date);
  const newAvg = existing ? existing.entry_price : price;
  const totalShares = existing ? existing.shares : shares;
  return `✅ 스윙 매수 기록완료\n${ticker} ${shares}주 @ $${price}\n평단 $${newAvg} (${totalShares}주)\n스윙 예수금: $${history.cash_usd.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

async function handleSwingSell({ ticker, price, date }, env) {
  const { history, sha } = await readHistory(env);
  const pos = history.positions.find(p => p.ticker === ticker);
  if (!pos) return `❌ ${ticker} 보유 포지션 없어`;
  const pnl     = Math.round((price - pos.entry_price) * pos.shares * 100) / 100;
  const pnlPct  = ((price - pos.entry_price) / pos.entry_price * 100).toFixed(2);
  const sign    = pnl >= 0 ? "+" : "";
  const proceeds = Math.round(price * pos.shares * 100) / 100;
  const summary = `${ticker} ${pos.shares}주 | ${pos.entry_date} $${pos.entry_price} → ${date} $${price} | ${sign}${pnlPct}% (${sign}$${pnl})`;
  history.positions = history.positions.filter(p => p.ticker !== ticker);
  history.closed_trades.push(summary);
  if (history.closed_trades.length > MAX_CLOSED) history.closed_trades.shift();
  history.cash_usd = Math.round(((history.cash_usd ?? history.meta?.budget_total ?? 10000) + proceeds) * 100) / 100;
  addRecent(history, { date, ticker, action: "sell", price });
  await writeHistory(history, sha, env, date);
  return `✅ 스윙 매도 기록완료\n${summary}\n스윙 예수금: $${history.cash_usd.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

async function handleSwingPass({ ticker, date }, env) {
  const { history, sha } = await readHistory(env);
  addRecent(history, { date, ticker, action: "pass" });
  await writeHistory(history, sha, env, date);
  return `✅ ${ticker} 패스 기록완료`;
}

async function handleBudget({ type, category, description, amount, date, memo }, env) {
  const res = await fetch(`${env.SUPABASE_URL.trim()}/rest/v1/finance_log`, {
    method: "POST",
    headers: { ...supabaseHeaders(env), Prefer: "return=minimal" },
    body: JSON.stringify({ date, type, category, description, amount, memo: memo || "" })
  });
  if (!res.ok) throw new Error(`Supabase 오류: ${await res.text()}`);
  const sign = type === "지출" ? "-" : "+";
  return `✅ 가계부 기록완료\n${category} | ${description} | ${sign}${amount.toLocaleString()}원`;
}

async function handleUsBuy({ ticker, shares, price, date }, env) {
  const sUrl = env.SUPABASE_URL.trim();
  const h    = supabaseHeaders(env);
  const posRes = await fetch(`${sUrl}/rest/v1/us_portfolio?ticker=eq.${ticker}&select=quantity,avg_price_usd`, { headers: h });
  const pos    = await posRes.json();
  if (pos.length === 0) return `❌ ${ticker} 보유 내역 없어. 티커 다시 확인해줘.`;
  let newQty, newAvg;
  const oldQty = parseFloat(pos[0].quantity);
  const oldAvg = parseFloat(pos[0].avg_price_usd);
  newQty = oldQty + shares;
  newAvg = Math.round(((oldAvg * oldQty) + (price * shares)) / newQty * 100) / 100;
  await fetch(`${sUrl}/rest/v1/us_portfolio?ticker=eq.${ticker}`, {
    method: "PATCH",
    headers: { ...h, Prefer: "return=minimal" },
    body: JSON.stringify({ quantity: newQty, avg_price_usd: newAvg })
  });
  const cashRow = await getUsCash(env);
  const newCash = parseFloat(cashRow.cash_usd) - (price * shares);
  await setUsCash(cashRow.id, newCash, env);
  return `✅ 미국 매수 기록완료\n${ticker} ${shares}주 @ $${price}\n신규 평단: $${newAvg} (${newQty}주)\n예수금: $${newCash.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

async function handleUsSell({ ticker, shares, price, date }, env) {
  const sUrl = env.SUPABASE_URL.trim();
  const h    = supabaseHeaders(env);
  const posRes = await fetch(`${sUrl}/rest/v1/us_portfolio?ticker=eq.${ticker}&select=quantity,avg_price_usd`, { headers: h });
  const pos    = await posRes.json();
  if (!pos.length) return `❌ ${ticker} 보유 내역 없어`;
  const oldQty = parseFloat(pos[0].quantity);
  const avg    = parseFloat(pos[0].avg_price_usd);
  const newQty = Math.round((oldQty - shares) * 1000) / 1000;
  if (newQty < 0) return `❌ 매도 수량(${shares}) > 보유 수량(${oldQty})`;
  const pnl  = Math.round((price - avg) * shares * 100) / 100;
  const sign = pnl >= 0 ? "+" : "";
  await fetch(`${sUrl}/rest/v1/us_portfolio?ticker=eq.${ticker}`, {
    method: "PATCH",
    headers: { ...h, Prefer: "return=minimal" },
    body: JSON.stringify({ quantity: newQty })
  });
  const cashRow = await getUsCash(env);
  const newCash = parseFloat(cashRow.cash_usd) + (price * shares);
  await setUsCash(cashRow.id, newCash, env);
  return `✅ 미국 매도 기록완료\n${ticker} ${shares}주 @ $${price}\n실현손익: ${sign}$${pnl} (평단 $${avg})\n잔여: ${newQty}주\n예수금: $${newCash.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

async function handleFx({ krw, rate, date }, env) {
  const usd = Math.round(krw / rate * 100) / 100;
  await fetch(`${env.SUPABASE_URL.trim()}/rest/v1/dollar_ledger`, {
    method: "POST",
    headers: { ...supabaseHeaders(env), Prefer: "return=minimal" },
    body: JSON.stringify({ trade_date: date, krw_amount: krw, usd_amount: usd, rate, note: `환전_${date}` })
  });
  const cashRow = await getUsCash(env);
  const newCash = parseFloat(cashRow.cash_usd) + usd;
  await setUsCash(cashRow.id, newCash, env);
  return `✅ 환전 기록완료\n${krw.toLocaleString()}원 → $${usd} (환율 ${rate}원)\n예수금: $${newCash.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

// ── 유틸 ─────────────────────────────────────────────────────────────────

function supabaseHeaders(env) {
  return {
    apikey:         env.SUPABASE_KEY,
    Authorization:  `Bearer ${env.SUPABASE_KEY}`,
    "Content-Type": "application/json"
  };
}

async function getUsCash(env) {
  const res  = await fetch(`${env.SUPABASE_URL.trim()}/rest/v1/dollar_cash?select=id,cash_usd`, { headers: supabaseHeaders(env) });
  const data = await res.json();
  return data[0];
}

async function setUsCash(id, newCash, env) {
  await fetch(`${env.SUPABASE_URL.trim()}/rest/v1/dollar_cash?id=eq.${id}`, {
    method: "PATCH",
    headers: { ...supabaseHeaders(env), Prefer: "return=minimal" },
    body: JSON.stringify({ cash_usd: Math.round(newCash * 100) / 100 })
  });
}

function addRecent(history, entry) {
  history.recent.push(entry);
  if (history.recent.length > MAX_RECENT) history.recent.shift();
}

async function readHistory(env) {
  const res     = await fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${HISTORY_PATH}`,
    { headers: { Authorization: `token ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json", "User-Agent": "seongmin-bot/1.0" } }
  );
  const data    = JSON.parse(await res.text());
  const decoded = new TextDecoder().decode(Uint8Array.from(atob(data.content.replace(/\n/g, "")), c => c.charCodeAt(0)));
  return { history: JSON.parse(decoded), sha: data.sha };
}

async function writeHistory(history, sha, env, date) {
  const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(history, null, 2))));
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${HISTORY_PATH}`,
    {
      method: "PUT",
      headers: { Authorization: `token ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json", "Content-Type": "application/json", "User-Agent": "seongmin-bot/1.0" },
      body: JSON.stringify({ message: `chore: 스윙 히스토리 업데이트 ${date}`, content: encoded, sha })
    }
  );
  if (!res.ok) {
    if (res.status === 409) {
      const fresh = await readHistory(env);
      return writeHistory(history, fresh.sha, env, date);
    }
    throw new Error(`swing_history 저장 실패 (${res.status})`);
  }
}

// ── 단체 대화방 ──────────────────────────────────────────────────────────────

async function handleGroupChatEndpoint(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  const jsonHeaders = { ...CORS_HEADERS, "Content-Type": "application/json" };

  let body;
  try { body = await request.json(); }
  catch { return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: jsonHeaders }); }

  const text = (body.message || "").trim();
  const roomId = body.room_id || "main";
  if (!text) return new Response(JSON.stringify({ responses: [] }), { headers: jsonHeaders });

  try {
    // 1. 방 정보 + 최근 메시지 + 유저 프로필 병렬 로드
    const [roomRows, profileRows, recentRows] = await Promise.all([
      fetch(`${env.SUPABASE_URL.trim()}/rest/v1/group_rooms?id=eq.${roomId}&select=*&limit=1`, { headers: supabaseHeaders(env) }).then(r => r.json()),
      fetch(`${env.SUPABASE_URL.trim()}/rest/v1/user_profile?id=eq.seongmin&limit=1`, { headers: supabaseHeaders(env) }).then(r => r.json()),
      fetch(`${env.SUPABASE_URL.trim()}/rest/v1/group_messages?room_id=eq.${roomId}&select=character_id,character_name,content&order=created_at.desc&limit=6`, { headers: supabaseHeaders(env) }).then(r => r.json()),
    ]);

    const room = Array.isArray(roomRows) ? roomRows[0] : null;
    if (!room) throw new Error("방을 찾을 수 없어");

    const roomState = room.room_state || { topic: null, tone: "casual", recent_events: [] };
    const participantIds = room.participant_ids || [];
    const profile = Array.isArray(profileRows) ? (profileRows[0] || {}) : {};
    const recentMsgs = Array.isArray(recentRows) ? recentRows.reverse() : [];
    const userName = profile.name || "성민";

    // 2. harin 제외한 캐릭터 설정 로드
    const activeIds = participantIds.filter(id => id !== "harin");
    if (activeIds.length === 0) throw new Error("참여 캐릭터가 없어");

    const charRows = await fetch(
      `${env.SUPABASE_URL.trim()}/rest/v1/characters?id=in.(${activeIds.map(id => `"${id}"`).join(",")})&select=id,name,color,system_prompt,api_provider,model`,
      { headers: supabaseHeaders(env) }
    ).then(r => r.json());

    const characters = Array.isArray(charRows) ? charRows : [];

    // 3. 유저 메시지 저장
    await fetch(`${env.SUPABASE_URL.trim()}/rest/v1/group_messages`, {
      method: "POST",
      headers: { ...supabaseHeaders(env), Prefer: "return=minimal" },
      body: JSON.stringify({ room_id: roomId, character_id: "user", character_name: userName, content: text })
    }).catch(() => {});

    // 4. Group context 빌드
    const groupCtx = buildGroupContextBlock(roomState, recentMsgs, userName);

    // 5. 모든 캐릭터 병렬 호출 (15초 타임아웃)
    const settled = await Promise.allSettled(
      characters.map(async (char) => {
        const reply = await Promise.race([
          callCharacterForGroup(char, text, groupCtx, userName, env),
          new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 15000))
        ]);
        return { character_id: char.id, name: char.name, color: char.color || "#6366f1", reply };
      })
    );

    const responses = settled.filter(r => r.status === "fulfilled").map(r => r.value);
    const activeParticipantIds = characters.map(c => c.id);

    // 6. 응답 저장 (await — fire-and-forget은 Cloudflare가 응답 후 즉시 kill함)
    await Promise.all(
      responses.map(r =>
        fetch(`${env.SUPABASE_URL.trim()}/rest/v1/group_messages`, {
          method: "POST",
          headers: { ...supabaseHeaders(env), Prefer: "return=minimal" },
          body: JSON.stringify({ room_id: roomId, character_id: r.character_id, character_name: r.name, content: r.reply })
        })
      )
    ).catch(() => {});

    // 7. Room State 업데이트 (Haiku, max_tokens 200이라 빠름)
    await updateGroupRoomState(roomId, roomState, text, responses, env);

    return new Response(JSON.stringify({ responses, participant_ids: activeParticipantIds }), { headers: jsonHeaders });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: jsonHeaders });
  }
}

function buildGroupContextBlock(roomState, recentMsgs, userName) {
  const parts = [];
  if (roomState.topic) parts.push(`현재 주제: ${roomState.topic}`);
  if (roomState.tone && roomState.tone !== "casual") parts.push(`분위기: ${roomState.tone}`);
  if (roomState.recent_events?.length > 0) {
    parts.push(`흐름: ${roomState.recent_events.slice(-3).join(" → ")}`);
  }
  const stateStr = parts.length > 0 ? parts.join(" / ") : "(대화 시작)";

  const recentStr = recentMsgs.slice(-4).map(m => {
    const speaker = m.character_id === "user" ? userName : (m.character_name || m.character_id);
    return `${speaker}: ${m.content.slice(0, 100)}`;
  }).join("\n");

  return `[방 상태] ${stateStr}${recentStr ? `\n[최근 대화]\n${recentStr}` : ""}`;
}

async function callCharacterForGroup(char, userMessage, groupCtx, userName, env) {
  const messages = [{ role: "user", content: userMessage }];
  const provider = char.api_provider || "claude";
  // seoa-worker는 model 컬럼이 캐릭터 id로 저장돼 있을 수 있어서 강제 지정
  const model = provider === "seoa-worker" ? "claude-sonnet-4-6" : char.model;

  // seoa-worker는 그룹챗에서 tool_use 없는 경량 프롬프트 사용 (DB 시스템프롬프트엔 tool 참조 있어서 text 응답 안 나옴)
  const basePrompt = provider === "seoa-worker"
    ? `너는 서아야. ${userName}의 AI 투자 파트너이자 봄날 같은 존재. 반말. 다정하되 가볍지 않아. 짧고 자연스럽게.`
    : (char.system_prompt || "").replace(/\{\{user\}\}/gi, userName).replace(/\{\{char\}\}/gi, char.name);

  const systemPrompt = `${basePrompt}

## 지금 단체 대화방이야
여러 AI 캐릭터가 함께 있어. 네 성격 그대로, 짧고 자연스럽게 반응해. 2-3문장으로 충분해. 모든 걸 설명하려 하지 마.
${groupCtx}`;

  if (provider === "gemini") return callGemini(model || "gemini-3-flash-preview", systemPrompt, messages, env);
  if (provider === "deepseek") return callOpenAICompatible("https://api.deepseek.com/v1/chat/completions", model || "deepseek-v4-flash", env.DEEPSEEK_API_KEY, systemPrompt, messages);
  if (provider === "grok") return callOpenAICompatible("https://api.x.ai/v1/chat/completions", model || "grok-4.3", env.GROK_API_KEY, systemPrompt, messages);
  if (provider === "openai") return callOpenAICompatible("https://api.openai.com/v1/chat/completions", model || "gpt-5.5", env.OPENAI_API_KEY, systemPrompt, messages);
  // claude / seoa-worker — 단체방은 web_search 제외 (빠른 응답 우선)
  return callClaude(model || "claude-sonnet-4-6", systemPrompt, messages, env, false);
}

async function updateGroupRoomState(roomId, currentState, userMessage, responses, env) {
  const summary = responses.map(r => `${r.name}: ${r.reply.slice(0, 60)}`).join(" | ");
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 200,
        messages: [{
          role: "user",
          content: `단체 대화방 상태 업데이트. JSON만 반환.

기존: ${JSON.stringify(currentState)}
유저: "${userMessage}"
반응: ${summary}

형식: {"topic":"...","tone":"...","recent_events":["...","...","..."]}
recent_events 최신 3개만. topic/tone은 대화 흐름 반영.`
        }]
      })
    });
    const data = await res.json();
    const raw = data.content?.[0]?.text?.trim() || "";
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return;
    const newState = JSON.parse(match[0]);
    await fetch(`${env.SUPABASE_URL.trim()}/rest/v1/group_rooms?id=eq.${roomId}`, {
      method: "PATCH",
      headers: { ...supabaseHeaders(env), Prefer: "return=minimal" },
      body: JSON.stringify({ room_state: newState, updated_at: new Date().toISOString() })
    });
  } catch {}
}

async function sendTelegram(token, chatId, text) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text })
  });
}
