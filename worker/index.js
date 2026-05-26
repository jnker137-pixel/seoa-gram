// ── seoa-gram Worker v2 ────────────────────────────────────────────────────
// 기능: 멀티 캐릭터 채팅 + 메모리 (L0~L3)
// 제거: 텔레그램, 단체방, 스윙, 가계부, Haiku 인텐트
// 2026-05-26 완전 재작성

// ── CRITICAL: 절대 변경 금지 ─────────────────────────────────────────────────
// placement = "off" → wrangler.toml에 고정 (HKG 라우팅 방지)
// Gemini googleSearch tool → KR 리전 차단, 절대 추가 금지
// Claude web_search_20250305 → 일반 API 키에서 차단, 절대 추가 금지

const CORS = {
  'Access-Control-Allow-Origin': 'https://jnker137-pixel.github.io',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ── Entry ──────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    if (url.pathname === '/chat' && request.method === 'POST') {
      return handleChat(request, env, ctx);
    }
    if (url.pathname === '/group-chat' && request.method === 'POST') {
      return handleGroupChat(request, env, ctx);
    }

    return new Response('OK');
  },
};

// ── Chat endpoint ──────────────────────────────────────────────────────────
async function handleChat(request, env, ctx) {
  const jsonHeaders = { ...CORS, 'Content-Type': 'application/json' };

  let body;
  try { body = await request.json(); }
  catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: jsonHeaders }); }

  const { message, character_id, history = [] } = body;
  if (!message?.trim()) return new Response(JSON.stringify({ reply: '' }), { headers: jsonHeaders });
  if (!character_id)    return new Response(JSON.stringify({ error: 'character_id required' }), { status: 400, headers: jsonHeaders });

  try {
    // 1. 병렬 로드: 캐릭터 설정 + 유저 프로필 + 장기 기억 + 단기 대화 + 임베딩
    const [character, userIdentity, context, recentMsgs, embedding] = await Promise.all([
      fetchCharacter(character_id, env),
      fetchUserIdentity(env),
      fetchCharacterContext(character_id, env),
      fetchRecentMessages(character_id, env),
      embedText(message, env),
    ]);

    if (!character) throw new Error(`캐릭터를 찾을 수 없어: ${character_id}`);

    // 2. 에피소드 기억 벡터 검색
    const episodes = embedding ? await fetchEpisodic(character_id, embedding, env) : [];

    // 3. 시스템 프롬프트 조립
    const systemPrompt = buildSystemPrompt(character, userIdentity, context, episodes);

    // 4. 메시지 히스토리 구성 (클라이언트 전달 + DB 단기)
    // DB 기록이 있으면 우선, 없으면 클라이언트 history fallback
    const dbHistory = recentMsgs.length > 0 ? recentMsgs : cleanHistory(history);
    const messages = [...dbHistory, { role: 'user', content: message }];

    // 5. 프로바이더 라우팅
    const raw = await routeToProvider(character, systemPrompt, messages, env);

    // 6. DeepSeek 롤플레이 후처리
    const reply = needsClean(character.api_provider) ? cleanRoleplay(raw) : raw;

    // 7. 대화 저장 + L1 기억 갱신 (background — 응답 블로킹 없음)
    ctx.waitUntil(Promise.all([
      saveMessage(character_id, 'user', message, env),
      saveMessage(character_id, 'assistant', reply, env),
      updateL1Memory(character_id, context, recentMsgs, message, reply, env),
    ]));

    return new Response(JSON.stringify({ reply }), { headers: jsonHeaders });
  } catch (e) {
    console.error('[chat error]', e.message);
    return new Response(JSON.stringify({ reply: `❌ ${e.message}` }), { headers: jsonHeaders });
  }
}

// ── Supabase ───────────────────────────────────────────────────────────────
function sbHeaders(env) {
  return {
    apikey: env.SUPABASE_KEY,
    Authorization: `Bearer ${env.SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  };
}

async function sbGet(path, env) {
  const res = await fetch(`${env.SUPABASE_URL.trim()}${path}`, { headers: sbHeaders(env) });
  if (!res.ok) return [];
  return res.json();
}

async function sbPost(path, body, env) {
  await fetch(`${env.SUPABASE_URL.trim()}${path}`, {
    method: 'POST',
    headers: { ...sbHeaders(env), Prefer: 'return=minimal' },
    body: JSON.stringify(body),
  });
}

// ── Data fetchers ──────────────────────────────────────────────────────────
async function fetchCharacter(id, env) {
  const rows = await sbGet(`/rest/v1/characters?id=eq.${encodeURIComponent(id)}&select=*&limit=1`, env);
  return Array.isArray(rows) ? (rows[0] ?? null) : null;
}

async function fetchUserIdentity(env) {
  const rows = await sbGet('/rest/v1/user_profile?id=eq.seongmin&limit=1', env);
  return Array.isArray(rows) ? (rows[0] ?? {}) : {};
}

async function fetchCharacterContext(characterId, env) {
  const rows = await sbGet(
    `/rest/v1/character_context?character_id=eq.${encodeURIComponent(characterId)}&limit=1`,
    env
  );
  return Array.isArray(rows) ? (rows[0] ?? {}) : {};
}

async function fetchRecentMessages(characterId, env) {
  // L0: 최근 30개 + 14일 이내만
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const rows = await sbGet(
    `/rest/v1/conversation_log?character_id=eq.${encodeURIComponent(characterId)}&created_at=gte.${since}&order=created_at.desc&limit=30&select=role,content`,
    env
  );
  if (!Array.isArray(rows)) return [];
  return rows.reverse().map(r => ({ role: r.role, content: r.content }));
}

async function embedText(text, env) {
  if (!env.GEMINI_API_KEY) return null;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'models/text-embedding-004', content: { parts: [{ text }] } }),
      }
    );
    const data = await res.json();
    return data?.embedding?.values ?? null;
  } catch { return null; }
}

async function fetchEpisodic(characterId, embedding, env) {
  try {
    const res = await fetch(`${env.SUPABASE_URL.trim()}/rest/v1/rpc/match_episodic_memories`, {
      method: 'POST',
      headers: { ...sbHeaders(env) },
      body: JSON.stringify({
        query_embedding: embedding,
        character_filter: characterId,
        match_count: 3,
        min_similarity: 0.5,
      }),
    });
    const rows = await res.json();
    return Array.isArray(rows) ? rows : [];
  } catch { return []; }
}

async function saveMessage(characterId, role, content, env) {
  await sbPost('/rest/v1/conversation_log', { character_id: characterId, role, content }, env);
}

async function updateL1Memory(characterId, currentContext, recentMsgs, userMsg, reply, env) {
  const convo = [...recentMsgs.slice(-10),
    { role: 'user', content: userMsg },
    { role: 'assistant', content: reply },
  ];

  const prompt = `다음 대화를 읽고 캐릭터의 기억 슬롯을 업데이트해줘. JSON만 출력.

현재 슬롯:
relationship_summary: ${currentContext.relationship_summary || '없음'}
memorable_moments: ${currentContext.memorable_moments || '없음'}
mood: ${currentContext.mood || '없음'}

최근 대화:
${convo.map(m => `[${m.role === 'assistant' ? '캐릭터' : '유저'}] ${m.content.slice(0, 300)}`).join('\n')}

형식:
{"relationship_summary": "캐릭터-유저 관계 1-2줄", "memorable_moments": "기억할 순간 최대 3개", "mood": "캐릭터 현재 감정/태도 1줄"}`;

  try {
    const raw = await callClaude('claude-haiku-4-5-20251001', '너는 AI 캐릭터의 기억 관리자야. JSON으로만 응답해.', [{ role: 'user', content: prompt }], env);
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return;
    const data = JSON.parse(match[0]);
    // Supabase upsert (character_id unique 기준)
    await fetch(`${env.SUPABASE_URL.trim()}/rest/v1/character_context?on_conflict=character_id`, {
      method: 'POST',
      headers: { ...sbHeaders(env), Prefer: 'return=minimal,resolution=merge-duplicates' },
      body: JSON.stringify({ character_id: characterId, ...data }),
    });
  } catch (e) {
    console.error('[L1 update error]', e.message);
  }
}

// ── System prompt builder ─────────────────────────────────────────────────
function buildSystemPrompt(character, userIdentity, context, episodes) {
  const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().split('T')[0];
  const userName = userIdentity.name || '성민';

  const basePrompt = (character.system_prompt || '')
    .replace(/\{\{user\}\}/gi, userName)
    .replace(/\{\{char\}\}/gi, character.name)
    .trim();

  const parts = [basePrompt || `너는 ${character.name}이야.`, `오늘 날짜: ${today}`];

  // 유저 프로필 (L0 공통)
  const profileLines = [
    `## 대화 상대: ${userName}`,
    userIdentity.personality      ? userIdentity.personality      : '',
    userIdentity.investment_style ? `[투자 성향] ${userIdentity.investment_style}` : '',
  ].filter(Boolean);
  if (profileLines.length > 1) parts.push(profileLines.join('\n'));

  // 장기 기억 슬롯 (L1 + L2)
  const memLines = [
    context.relationship_summary ? `[관계] ${context.relationship_summary}` : '',
    context.memorable_moments    ? `[기억 조각] ${context.memorable_moments}` : '',
    context.mood                 ? `[현재 상태] ${context.mood}` : '',
  ].filter(Boolean);
  if (memLines.length > 0) parts.push(`## 장기 기억\n${memLines.join('\n')}`);

  // 에피소드 기억 (L3)
  if (episodes.length > 0) {
    const epLines = episodes.map(ep => `• ${ep.title ?? ''}: ${ep.summary ?? ''}`).filter(l => l.trim() !== ':');
    if (epLines.length > 0) parts.push(`## 떠오르는 기억\n${epLines.join('\n')}`);
  }

  return parts.join('\n\n');
}

// ── History cleaner ────────────────────────────────────────────────────────
const TIMESTAMP_RE = /^\[\d{4}\.\d+\.\d+\. \d{2}:\d{2}\]\s*/;

function cleanHistory(history) {
  return history.slice(-20).map(m => ({
    role: m.role,
    content: m.role === 'assistant' ? m.content.replace(TIMESTAMP_RE, '') : m.content,
  }));
}

// ── Provider router ────────────────────────────────────────────────────────
async function routeToProvider(character, systemPrompt, messages, env) {
  const provider = character.api_provider || 'claude';
  const model    = resolveModel(provider, character.model);

  switch (provider) {
    case 'claude':
    case 'seoa-worker':
      return callClaude(model || 'claude-sonnet-4-6', systemPrompt, messages, env);
    case 'gemini':
      return callGemini(model || 'gemini-2.5-flash', systemPrompt, messages, env);
    case 'deepseek':
      return callOpenAICompat(
        'https://api.deepseek.com/v1/chat/completions',
        model || 'deepseek-chat',
        env.DEEPSEEK_API_KEY,
        systemPrompt,
        messages
      );
    case 'grok':
      return callOpenAICompat(
        'https://api.x.ai/v1/chat/completions',
        model || 'grok-3-mini',
        env.GROK_API_KEY,
        systemPrompt,
        messages
      );
    case 'openai':
      return callOpenAICompat(
        'https://api.openai.com/v1/chat/completions',
        model || 'gpt-4o-mini',
        env.OPENAI_API_KEY,
        systemPrompt,
        messages
      );
    default:
      throw new Error(`알 수 없는 프로바이더: ${provider}`);
  }
}

// provider와 model 불일치 방지
function resolveModel(provider, rawModel) {
  if (!rawModel) return null;
  const prefixMap = {
    claude: 'claude-', 'seoa-worker': 'claude-',
    gemini: 'gemini-',
    deepseek: 'deepseek-',
    grok: 'grok-',
    openai: 'gpt-',
  };
  const prefix = prefixMap[provider];
  return prefix && !rawModel.startsWith(prefix) ? null : rawModel;
}

// ── API callers ────────────────────────────────────────────────────────────
async function callClaude(model, systemPrompt, messages, env) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model, max_tokens: 2048, system: systemPrompt, messages,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    }),
  });
  const data = await res.json();
  if (data.type === 'error' || data.error || !res.ok) {
    await logGeo('Claude', env);
    throw new Error(`Claude API: ${data.error?.message ?? res.status}`);
  }
  return data.content?.filter(c => c.type === 'text').map(c => c.text).join('') || '응답 없음';
}

async function callGemini(model, systemPrompt, messages, env) {
  if (!env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY 미설정');

  // Gemini bullet 프롬프트 유출 방지
  const cleanedPrompt = systemPrompt
    .replace(/^[-*•]\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: cleanedPrompt }] },
        contents,
        tools: [{ googleSearch: {} }],
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
        ],
        generationConfig: { maxOutputTokens: 2048 },
      }),
    }
  );
  const data = await res.json();
  if (data.error || !res.ok) {
    await logGeo('Gemini', env);
    throw new Error(`Gemini API: ${data.error?.message ?? res.status}`);
  }
  return data.candidates?.[0]?.content?.parts?.filter(p => p.text).map(p => p.text).join('') || '응답 없음';
}

async function callOpenAICompat(baseUrl, model, apiKey, systemPrompt, messages) {
  if (!apiKey) throw new Error(`API 키 없음 (${baseUrl.split('/')[2]})`);
  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
    }),
  });
  const data = await res.json();
  if (data.error || !res.ok) throw new Error(`${baseUrl.split('/')[2]}: ${data.error?.message ?? res.status}`);
  return data.choices?.[0]?.message?.content || '응답 없음';
}

// ── 단체 대화방 ────────────────────────────────────────────────────────────
async function handleGroupChat(request, env, ctx) {
  const jsonHeaders = { ...CORS, 'Content-Type': 'application/json' };

  let body;
  try { body = await request.json(); }
  catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: jsonHeaders }); }

  const text = (body.message || '').trim();
  const roomId = body.room_id || 'main';
  if (!text) return new Response(JSON.stringify({ responses: [] }), { headers: jsonHeaders });

  try {
    const [roomRows, profileRows, recentRows] = await Promise.all([
      sbGet(`/rest/v1/group_rooms?id=eq.${roomId}&select=*&limit=1`, env),
      sbGet('/rest/v1/user_profile?id=eq.seongmin&limit=1', env),
      sbGet(`/rest/v1/group_messages?room_id=eq.${roomId}&select=character_id,character_name,content&order=created_at.desc&limit=8`, env),
    ]);

    const room = Array.isArray(roomRows) ? roomRows[0] : null;
    if (!room) throw new Error('방을 찾을 수 없어');

    const roomState = room.room_state || { topic: null, tone: 'casual', recent_events: [] };
    const participantIds = (room.participant_ids || []).filter(id => id !== 'harin');
    const profile = Array.isArray(profileRows) ? (profileRows[0] || {}) : {};
    const recentMsgs = Array.isArray(recentRows) ? recentRows.reverse() : [];
    const userName = profile.name || '성민';

    if (participantIds.length === 0) throw new Error('참여 캐릭터가 없어');

    const charRows = await sbGet(
      `/rest/v1/characters?id=in.(${participantIds.map(id => `"${id}"`).join(',')})&select=id,name,color,system_prompt,api_provider,model`,
      env
    );
    const characters = Array.isArray(charRows) ? charRows : [];

    // 유저 메시지 저장
    await sbPost('/rest/v1/group_messages',
      { room_id: roomId, character_id: 'user', character_name: userName, content: text }, env
    ).catch(() => {});

    const groupCtx = buildGroupContextBlock(roomState, recentMsgs, userName);

    // 모든 캐릭터 병렬 호출 (15초 타임아웃)
    const settled = await Promise.allSettled(
      characters.map(async (char) => {
        const reply = await Promise.race([
          callCharacterForGroup(char, text, groupCtx, userName, characters, env),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 15000)),
        ]);
        return { character_id: char.id, name: char.name, color: char.color || '#6366f1', reply };
      })
    );

    const responses = settled.filter(r => r.status === 'fulfilled').map(r => r.value);

    // 응답 저장 (await — fire-and-forget은 Cloudflare가 응답 후 즉시 kill함)
    await Promise.all(
      responses.map(r =>
        sbPost('/rest/v1/group_messages',
          { room_id: roomId, character_id: r.character_id, character_name: r.name, content: r.reply }, env
        )
      )
    ).catch(() => {});

    // 룸 상태 업데이트 (background)
    ctx.waitUntil(updateGroupRoomState(roomId, roomState, text, responses, env));

    return new Response(JSON.stringify({ responses, participant_ids: characters.map(c => c.id) }), { headers: jsonHeaders });
  } catch (e) {
    console.error('[group-chat error]', e.message);
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: jsonHeaders });
  }
}

function buildGroupContextBlock(roomState, recentMsgs, userName) {
  const parts = [];
  if (roomState.topic) parts.push(`현재 주제: ${roomState.topic}`);
  if (roomState.tone && roomState.tone !== 'casual') parts.push(`분위기: ${roomState.tone}`);
  if (roomState.recent_events?.length > 0) parts.push(`흐름: ${roomState.recent_events.slice(-3).join(' → ')}`);
  const stateStr = parts.length > 0 ? parts.join(' / ') : '(대화 시작)';

  const recentStr = recentMsgs.slice(-4).map(m => {
    const speaker = m.character_id === 'user' ? userName : (m.character_name || m.character_id);
    return `${speaker}: ${m.content.slice(0, 100)}`;
  }).join('\n');

  return `[방 상태] ${stateStr}${recentStr ? `\n[최근 대화]\n${recentStr}` : ''}`;
}

async function callCharacterForGroup(char, userMessage, groupCtx, userName, allChars, env) {
  const provider = char.api_provider || 'claude';
  const model = resolveModel(provider, char.model);

  const basePrompt = (char.system_prompt || '').replace(/\{\{user\}\}/gi, userName).replace(/\{\{char\}\}/gi, char.name);
  const otherNames = allChars.filter(c => c.id !== char.id).map(c => c.name).join(', ');

  const groupDirectives = `## 단체 대화방 행동 지침
지금 이 공간엔 ${userName}${otherNames ? `, ${otherNames}` : ''}가 함께 있어.
- 단톡 리듬: 짧고 임팩트 있게. 설명 말고 반응. 2-3문장.
- 크로스 반응: 최근 대화에 다른 참여자 발언이 보이면 동조하거나 비틀거나 반박해도 좋아.
- 개성 강화: 같은 주제도 너만의 시각으로.
- 선택적 발화: 가장 반응하고 싶은 포인트 하나에만 집중.`;

  const systemPrompt = `${basePrompt}\n\n${groupDirectives}\n\n${groupCtx}`;
  const messages = [{ role: 'user', content: userMessage }];

  if (provider === 'gemini') {
    return callGemini(model || 'gemini-2.5-flash', systemPrompt, messages, env);
  }
  if (provider === 'deepseek') {
    const dsPrompt = systemPrompt + '\n\n[절대 규칙] 대사만 출력. (웃으며) *한숨* [행동묘사] 형식 전부 금지.';
    const raw = await callOpenAICompat('https://api.deepseek.com/v1/chat/completions', model || 'deepseek-chat', env.DEEPSEEK_API_KEY, dsPrompt, messages);
    return cleanRoleplay(raw);
  }
  if (provider === 'grok') return callOpenAICompat('https://api.x.ai/v1/chat/completions', model || 'grok-3-mini', env.GROK_API_KEY, systemPrompt, messages);
  if (provider === 'openai') return callOpenAICompat('https://api.openai.com/v1/chat/completions', model || 'gpt-4o-mini', env.OPENAI_API_KEY, systemPrompt, messages);
  // claude / seoa-worker — 단체방은 web_search 제외 (빠른 응답 우선)
  return callClaudeQuick(model || 'claude-sonnet-4-6', systemPrompt, messages, env);
}

async function callClaudeQuick(model, systemPrompt, messages, env) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 512, system: systemPrompt, messages }),
  });
  const data = await res.json();
  if (data.type === 'error' || data.error || !res.ok) throw new Error(`Claude: ${data.error?.message ?? res.status}`);
  return data.content?.filter(c => c.type === 'text').map(c => c.text).join('') || '응답 없음';
}

async function updateGroupRoomState(roomId, currentState, userMessage, responses, env) {
  const summary = responses.map(r => `${r.name}: ${r.reply.slice(0, 60)}`).join(' | ');
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001', max_tokens: 200,
        messages: [{ role: 'user', content: `단체 대화방 상태 업데이트. JSON만 반환.
기존: ${JSON.stringify(currentState)}
유저: "${userMessage}"
반응: ${summary}
형식: {"topic":"...","tone":"...","recent_events":["...","...","..."]}
recent_events 최신 3개만.` }],
      }),
    });
    const data = await res.json();
    const match = (data.content?.[0]?.text || '').match(/\{[\s\S]*\}/);
    if (!match) return;
    const newState = JSON.parse(match[0]);
    await fetch(`${env.SUPABASE_URL.trim()}/rest/v1/group_rooms?id=eq.${roomId}`, {
      method: 'PATCH',
      headers: { ...sbHeaders(env), 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ room_state: newState, updated_at: new Date().toISOString() }),
    });
  } catch {}
}

// ── DeepSeek 롤플레이 억제 ────────────────────────────────────────────────
function cleanRoleplay(text) {
  return text
    .replace(/^\[?\d{4}[.\-년]\s*\d+[.\-월]\s*\d+[일\.]?[^\n]*\]\s*/gm, '')
    .replace(/\([\s\S]*?\)/g, '')
    .replace(/（[\s\S]*?）/g, '')
    .replace(/\*[\s\S]*?\*/g, '')
    .replace(/\[[\s\S]*?\]/g, '')
    .replace(/^[-—]\s*.{1,80}[-—]\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function needsClean(provider) {
  return provider === 'deepseek';
}

// ── GEO 진단 (에러 시 자동 출력) ─────────────────────────────────────────
async function logGeo(caller, env) {
  try {
    const trace = await fetch('https://www.cloudflare.com/cdn-cgi/trace').then(r => r.text());
    const colo = trace.match(/colo=(\w+)/)?.[1] ?? '?';
    const loc  = trace.match(/loc=(\w+)/)?.[1]  ?? '?';
    console.error(`[${caller} error] colo=${colo} loc=${loc}`);
  } catch {}
}
