// Worker 없이 브라우저 직접 AI API 호출
import type { Character, CharacterContext, UserProfile, GroupResponse } from '../types';
import { supabase } from './supabase';

// ── API Keys ──────────────────────────────────────────────────────────────────
const ANTHROPIC_API_KEY = import.meta.env.VITE_ANTHROPIC_API_KEY as string;
const GEMINI_API_KEY    = import.meta.env.VITE_GEMINI_API_KEY as string;
const DEEPSEEK_API_KEY  = import.meta.env.VITE_DEEPSEEK_API_KEY as string;
const OPENAI_API_KEY    = import.meta.env.VITE_OPENAI_API_KEY as string;

// ── Types ─────────────────────────────────────────────────────────────────────
interface ChatMessage { role: 'user' | 'assistant'; content: string }

interface OrchestratorTurn {
  speaker: string;  // character id
  target: string;   // 'user' | character id
  intent: string;   // tease | curiosity | challenge | comfort | joke | debate | support | explain
  hint: string;
}

// ── Entry: 1:1 메시지 전송 ─────────────────────────────────────────────────────
export async function sendMessageDirect(
  character: Character,
  userMessage: string
): Promise<string> {
  const [userIdentity, context, recentMsgs, embedding] = await Promise.all([
    fetchUserIdentity(),
    fetchCharacterContext(character.id),
    fetchRecentMessages(character.id),
    embedText(userMessage),
  ]);

  const episodes = embedding ? await fetchEpisodic(character.id, embedding) : [];
  const systemPrompt = buildSystemPrompt(character, userIdentity, context, episodes);
  const messages: ChatMessage[] = [...recentMsgs, { role: 'user', content: userMessage }];

  const provider = character.api_provider || 'claude';
  const model    = resolveModel(provider, character.model);
  let raw: string;

  const useSearch = character.tools_enabled ?? false;
  switch (provider) {
    case 'claude':
    case 'seoa-worker':
      raw = await callClaude(model || 'claude-sonnet-4-6', systemPrompt, messages, useSearch);
      break;
    case 'gemini':
      raw = await callGemini(model || 'gemini-2.5-flash', systemPrompt, messages, useSearch);
      break;
    case 'deepseek':
      raw = await callOpenAICompat('https://api.deepseek.com/v1/chat/completions', model || 'deepseek-chat', DEEPSEEK_API_KEY, systemPrompt, messages);
      break;
    case 'openai':
      raw = await callOpenAICompat('https://api.openai.com/v1/chat/completions', model || 'gpt-4o-mini', OPENAI_API_KEY, systemPrompt, messages);
      break;
    default:
      throw new Error(`지원하지 않는 프로바이더: ${provider}`);
  }

  const reply = provider === 'deepseek' ? cleanRoleplay(raw) : raw;

  void Promise.all([
    saveConversationLog(character.id, 'user', userMessage),
    saveConversationLog(character.id, 'assistant', reply),
    updateL1Memory(character.id, context, recentMsgs, userMessage, reply),
  ]);

  return reply;
}

// ── Supabase fetchers ─────────────────────────────────────────────────────────
async function fetchUserIdentity(): Promise<UserProfile | null> {
  const { data } = await supabase.from('user_profile').select('*').eq('id', 'seongmin').maybeSingle();
  return data;
}

async function fetchCharacterContext(characterId: string): Promise<CharacterContext | null> {
  const { data } = await supabase.from('character_context').select('*').eq('character_id', characterId).maybeSingle();
  return data;
}

async function fetchRecentMessages(characterId: string): Promise<ChatMessage[]> {
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const { data } = await supabase
    .from('conversation_log')
    .select('role, content')
    .eq('character_id', characterId)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(30);
  if (!data) return [];
  return data.reverse() as ChatMessage[];
}

async function saveConversationLog(characterId: string, role: string, content: string) {
  await supabase.from('conversation_log').insert({ character_id: characterId, role, content });
}

// ── Embedding + Episodic ──────────────────────────────────────────────────────
async function embedText(text: string): Promise<number[] | null> {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'models/text-embedding-004', content: { parts: [{ text }] } }),
      }
    );
    const data = await res.json() as { embedding?: { values?: number[] } };
    return data?.embedding?.values ?? null;
  } catch { return null; }
}

async function fetchEpisodic(characterId: string, embedding: number[]): Promise<{ title?: string; summary?: string }[]> {
  try {
    const { data } = await supabase.rpc('match_episodic_memories', {
      query_embedding: embedding,
      character_filter: characterId,
      match_count: 3,
      min_similarity: 0.5,
    });
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

// ── System prompt builder ─────────────────────────────────────────────────────
function buildSystemPrompt(
  character: Character,
  userIdentity: UserProfile | null,
  context: CharacterContext | null,
  episodes: { title?: string; summary?: string }[]
): string {
  const today    = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().split('T')[0];
  const userName = userIdentity?.name || '성민';

  const basePrompt = (character.system_prompt || '')
    .replace(/\{\{user\}\}/gi, userName)
    .replace(/\{\{char\}\}/gi, character.name)
    .trim();

  const parts = [basePrompt || `너는 ${character.name}이야.`, `오늘 날짜: ${today}`];

  const profileLines = [
    `## 대화 상대: ${userName}`,
    userIdentity?.personality       ?? '',
    userIdentity?.investment_style  ? `[투자 성향] ${userIdentity.investment_style}` : '',
  ].filter(Boolean);
  if (profileLines.length > 1) parts.push(profileLines.join('\n'));

  const memLines = [
    context?.relationship_summary ? `[관계] ${context.relationship_summary}` : '',
    context?.memorable_moments    ? `[기억 조각] ${context.memorable_moments}` : '',
    context?.mood                 ? `[현재 상태] ${context.mood}` : '',
  ].filter(Boolean);
  if (memLines.length > 0) parts.push(`## 장기 기억\n${memLines.join('\n')}`);

  if (episodes.length > 0) {
    const epLines = episodes
      .map(ep => `• ${ep.title ?? ''}: ${ep.summary ?? ''}`)
      .filter(l => l.trim() !== ':');
    if (epLines.length > 0) parts.push(`## 떠오르는 기억\n${epLines.join('\n')}`);
  }

  return parts.join('\n\n');
}

// ── L1 memory updater ─────────────────────────────────────────────────────────
async function updateL1Memory(
  characterId: string,
  currentContext: CharacterContext | null,
  recentMsgs: ChatMessage[],
  userMsg: string,
  reply: string
) {
  if (!ANTHROPIC_API_KEY) return;

  const convo = [
    ...recentMsgs.slice(-10),
    { role: 'user', content: userMsg },
    { role: 'assistant', content: reply },
  ];

  const prompt = `다음 대화를 읽고 캐릭터의 기억 슬롯을 업데이트해줘. JSON만 출력.

현재 슬롯:
relationship_summary: ${currentContext?.relationship_summary || '없음'}
memorable_moments: ${currentContext?.memorable_moments || '없음'}
mood: ${currentContext?.mood || '없음'}

최근 대화:
${convo.map(m => `[${m.role === 'assistant' ? '캐릭터' : '유저'}] ${m.content.slice(0, 300)}`).join('\n')}

형식:
{"relationship_summary": "캐릭터-유저 관계 1-2줄", "memorable_moments": "기억할 순간 최대 3개", "mood": "캐릭터 현재 감정/태도 1줄"}`;

  try {
    const raw = await callClaude('claude-haiku-4-5-20251001', '너는 AI 캐릭터의 기억 관리자야. JSON으로만 응답해.', [{ role: 'user', content: prompt }]);
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return;
    const data = JSON.parse(match[0]) as Partial<CharacterContext>;
    await supabase
      .from('character_context')
      .upsert({ character_id: characterId, ...data, updated_at: new Date().toISOString() }, { onConflict: 'character_id' });
  } catch { /* L1 실패해도 메인 응답에 영향 없음 */ }
}

// ── API callers ────────────────────────────────────────────────────────────────
async function callClaude(model: string, systemPrompt: string, messages: ChatMessage[], useWebSearch = false): Promise<string> {
  const body: Record<string, unknown> = { model, max_tokens: 2048, system: systemPrompt, messages };
  // web_search_20250305 is server-side — Anthropic handles it, no tool_use loop needed
  if (useWebSearch) body['tools'] = [{ type: 'web_search_20250305', name: 'web_search' }];
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json() as { type?: string; error?: { message?: string }; content?: { type: string; text: string }[] };
  if (!res.ok || data.error) throw new Error(`Claude: ${data.error?.message ?? res.status}`);
  return data.content?.filter(c => c.type === 'text').map(c => c.text).join('') || '응답 없음';
}

async function callGemini(model: string, systemPrompt: string, messages: ChatMessage[], useGoogleSearch = false): Promise<string> {
  const cleanedPrompt = systemPrompt.replace(/^[-*•]\s+/gm, '').replace(/\n{3,}/g, '\n\n').trim();
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const body: Record<string, unknown> = {
    system_instruction: { parts: [{ text: cleanedPrompt }] },
    contents,
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
    ],
    generationConfig: { maxOutputTokens: 2048 },
  };
  // googleSearch grounding — 브라우저 직접 호출(한국 IP)에서만 동작, Worker HKG IP에서 차단됨
  if (useGoogleSearch) body['tools'] = [{ googleSearch: {} }];

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
  const data = await res.json() as { error?: { message?: string }; candidates?: { content?: { parts?: { text?: string }[] } }[] };
  if (!res.ok || data.error) throw new Error(`Gemini: ${data.error?.message ?? res.status}`);
  return data.candidates?.[0]?.content?.parts?.filter(p => p.text).map(p => p.text).join('') || '응답 없음';
}

async function callOpenAICompat(
  baseUrl: string,
  model: string,
  apiKey: string,
  systemPrompt: string,
  messages: ChatMessage[]
): Promise<string> {
  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 2048, messages: [{ role: 'system', content: systemPrompt }, ...messages] }),
  });
  const data = await res.json() as { error?: { message?: string }; choices?: { message?: { content?: string } }[] };
  if (!res.ok || data.error) throw new Error(`${new URL(baseUrl).hostname}: ${data.error?.message ?? res.status}`);
  return data.choices?.[0]?.message?.content || '응답 없음';
}

// ── Group Chat: Orchestrator ──────────────────────────────────────────────────

// Haiku가 이번 턴 시나리오를 결정:
// - 누가 말할지 (1~3명, 매번 모두가 답할 필요 없음)
// - 어떤 순서로
// - 누구를 향해 (user인지, 다른 캐릭터인지)
async function orchestrateTurns(
  participants: Character[],
  userMessage: string,
  recentCtx: string,
  roomCtx: string,
): Promise<OrchestratorTurn[]> {
  if (!ANTHROPIC_API_KEY || participants.length === 0) {
    return participants.map(c => ({ speaker: c.id, target: 'user', hint: '' }));
  }

  const participantDesc = participants
    .map(c => `- ${c.name} (id: ${c.id}): ${(c.system_prompt || '').slice(0, 120).replace(/\n/g, ' ')}`)
    .join('\n');

  const prompt = `너는 단체 대화방 연출가야. 이번 턴 시나리오를 딱 정해줘.

핵심 원칙 — 성민 중심 중력장:
이 단톡방은 성민이라는 사람 주변으로 형성된 관계장이야.
캐릭터들끼리 대화할 수 있지만, 항상 성민의 발언/반응/상태와 연결되어야 해.

참여자:
${participantDesc}

방 맥락:
${roomCtx || '없음'}

최근 대화 흐름:
${recentCtx || '없음'}

성민이 방금 한 말:
"${userMessage}"

결정 기준:
- 모두가 매번 답할 필요 없어. 1명만 말해도 충분히 자연스러워.
- 캐릭터끼리 직접 대화할 수 있어. 단, 성민의 말에 대한 반응/해석/농담/의견 충돌 형태여야 자연스러워.
- 캐릭터간 direct relay는 최대 1회까지. 2턴 이상 이어지면 성민에게 시선을 돌리는 흐름을 우선해.
- 성민을 완전히 배제한 채 캐릭터들끼리만 이어가지 마.
- hint는 딱 한 줄, 짧게. 말투까지 지정하지 마 — 캐릭터가 알아서 해.
- intent는 아래 중 하나: tease / curiosity / challenge / comfort / joke / debate / support / explain
- 최소 1턴, 최대 3턴.

JSON만 출력:
{"turns": [{"speaker": "캐릭터id", "target": "user 또는 캐릭터id", "intent": "...", "hint": "..."}]}`;

  try {
    const raw = await callClaude(
      'claude-haiku-4-5-20251001',
      '단체 대화방 연출가. JSON만 응답.',
      [{ role: 'user', content: prompt }]
    );
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('no json');
    const parsed = JSON.parse(match[0]) as { turns?: OrchestratorTurn[] };
    const validIds = new Set(participants.map(p => p.id));
    const turns = (parsed.turns || []).filter(t => validIds.has(t.speaker) && t.target);
    if (turns.length === 0) throw new Error('empty turns');
    return turns;
  } catch {
    // fallback: 랜덤 순서로 전원 응답
    return [...participants]
      .sort(() => Math.random() - 0.5)
      .map(c => ({ speaker: c.id, target: 'user', intent: 'support', hint: '' }));
  }
}

// ── Group Chat: 캐릭터 한 턴 실행 ─────────────────────────────────────────────
async function callCharacterForGroupTurn(
  char: Character,
  userMessage: string,
  recentCtx: string,
  roomCtx: string,
  priorTurnCtx: string,  // 이번 턴에 앞서 나온 다른 캐릭터들의 대사
  hint: string,
  intent: string,
  targetChar: Character | null,  // null = 유저 타겟
  userName: string,
  today: string,
): Promise<string> {
  const base = (char.system_prompt || `너는 ${char.name}이야.`)
    .replace(/\{\{user\}\}/gi, userName)
    .replace(/\{\{char\}\}/gi, char.name)
    .trim();

  const targetLine = targetChar
    ? `지금은 ${targetChar.name}한테 직접 말해. 성민은 잠시 옆에 있어.`
    : `${userName}에게 반응해.`;

  const systemPrompt = [
    base,
    `오늘 날짜: ${today}`,
    roomCtx ? `## 단체 대화방 맥락\n${roomCtx}` : '',
    recentCtx ? `## 최근 대화\n${recentCtx}` : '',
    `## 이번 네 차례\n${targetLine}${intent ? `\n태도: ${intent}` : ''}${hint ? `\n방향: ${hint}` : ''}\n짧고 자연스럽게, ${char.name}답게. 단체방에서 하는 말임.`,
  ].filter(Boolean).join('\n\n');

  // 유저 메시지 + 이번 턴에 앞서 나온 대사 포함
  const userContent = priorTurnCtx
    ? `[${userName}] ${userMessage}\n${priorTurnCtx}`
    : `[${userName}] ${userMessage}`;

  const msgs: ChatMessage[] = [{ role: 'user', content: userContent }];
  const provider = char.api_provider || 'claude';
  const model    = resolveModel(provider, char.model);
  const useSearch = char.tools_enabled ?? false;

  let raw: string;
  switch (provider) {
    case 'claude':
    case 'seoa-worker':
      raw = await callClaude(model || 'claude-sonnet-4-6', systemPrompt, msgs, useSearch);
      break;
    case 'gemini':
      raw = await callGemini(model || 'gemini-2.5-flash', systemPrompt, msgs, useSearch);
      break;
    case 'deepseek':
      raw = await callOpenAICompat('https://api.deepseek.com/v1/chat/completions', model || 'deepseek-chat', DEEPSEEK_API_KEY, systemPrompt, msgs);
      break;
    case 'openai':
      raw = await callOpenAICompat('https://api.openai.com/v1/chat/completions', model || 'gpt-4o-mini', OPENAI_API_KEY, systemPrompt, msgs);
      break;
    default:
      raw = await callClaude('claude-sonnet-4-6', systemPrompt, msgs, useSearch);
  }

  return provider === 'deepseek' ? cleanRoleplay(raw) : raw;
}

// ── Group Chat Entry ──────────────────────────────────────────────────────────
export async function sendGroupMessageDirect(
  roomId: string,
  userMessage: string,
  onResponse?: (r: GroupResponse) => void,
  onPlanReady?: (speakerIds: string[]) => void,
): Promise<{ responses: GroupResponse[]; participantIds: string[] }> {
  const { data: roomData } = await supabase
    .from('group_rooms')
    .select('participant_ids, room_state')
    .eq('id', roomId)
    .single();

  const participantIds: string[] = roomData?.participant_ids ?? [];
  const roomState = roomData?.room_state as Record<string, string> | null;

  if (participantIds.length === 0) return { responses: [], participantIds: [] };

  const [charsResult, userIdentity, recentResult] = await Promise.all([
    supabase.from('characters').select('*').in('id', participantIds),
    fetchUserIdentity(),
    supabase
      .from('group_messages')
      .select('character_id, character_name, content')
      .eq('room_id', roomId)
      .order('created_at', { ascending: false })
      .limit(8),
  ]);

  const participants = (charsResult.data ?? []) as Character[];
  const recentMsgs   = (recentResult.data ?? []).reverse();
  const userName     = userIdentity?.name || '성민';

  // 유저 메시지 먼저 저장
  await supabase.from('group_messages').insert({
    room_id: roomId,
    character_id: 'user',
    character_name: userName,
    content: userMessage,
  });

  const today    = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().split('T')[0];
  const recentCtx = recentMsgs
    .map(m => `[${m.character_name || m.character_id}] ${m.content.slice(0, 200)}`)
    .join('\n');
  const roomCtx = roomState
    ? [`주제: ${roomState['topic'] || ''}`, `분위기: ${roomState['tone'] || ''}`, `최근 흐름: ${roomState['recent_events'] || ''}`]
        .filter(l => !l.endsWith(': '))
        .join('\n')
    : '';

  // Orchestrator: 이번 턴 시나리오 결정
  const turns = await orchestrateTurns(participants, userMessage, recentCtx, roomCtx);
  const charById = Object.fromEntries(participants.map(c => [c.id, c]));

  // 타이핑 인디케이터 업데이트 (계획된 화자만 표시)
  const plannedSpeakers = [...new Set(turns.map(t => t.speaker))];
  onPlanReady?.(plannedSpeakers);

  // Sequential relay: 앞 캐릭터 응답을 다음 캐릭터가 보고 반응
  const thisRoundReplies: { name: string; reply: string }[] = [];
  const responses: GroupResponse[] = [];

  for (const turn of turns) {
    const char = charById[turn.speaker];
    if (!char) continue;

    const targetChar = turn.target !== 'user' ? (charById[turn.target] || null) : null;

    // 이번 턴에 이미 나온 대사 컨텍스트로 주입
    const priorTurnCtx = thisRoundReplies.length > 0
      ? '\n[이번 대화]\n' + thisRoundReplies.map(r => `[${r.name}] ${r.reply}`).join('\n')
      : '';

    const reply = await callCharacterForGroupTurn(
      char, userMessage, recentCtx, roomCtx,
      priorTurnCtx, turn.hint, turn.intent || '', targetChar, userName, today
    );

    const response: GroupResponse = {
      character_id: char.id,
      name: char.name,
      color: char.color,
      reply,
    };

    thisRoundReplies.push({ name: char.name, reply });
    responses.push(response);

    // UI에 즉시 표시 + DB 저장
    onResponse?.(response);
    await supabase.from('group_messages').insert({
      room_id: roomId,
      character_id: char.id,
      character_name: char.name,
      content: reply,
    });
  }

  void updateGroupRoomState(roomId, roomState, userMessage, responses);

  return { responses, participantIds };
}

async function updateGroupRoomState(
  roomId: string,
  current: Record<string, string> | null,
  userMsg: string,
  responses: GroupResponse[]
) {
  if (!ANTHROPIC_API_KEY) return;
  const convo = [
    `[성민] ${userMsg}`,
    ...responses.map(r => `[${r.name}] ${r.reply}`),
  ].join('\n');

  const prompt = `다음 단체 대화를 읽고 방 상태를 업데이트해줘. JSON만 출력.

현재 상태:
topic: ${current?.['topic'] || '없음'}
tone: ${current?.['tone'] || '없음'}
recent_events: ${current?.['recent_events'] || '없음'}

새 대화:
${convo}

형식:
{"topic": "현재 주제 1줄", "tone": "대화 분위기 1줄", "recent_events": "최근 흐름 1-2줄"}`;

  try {
    const raw = await callClaude(
      'claude-haiku-4-5-20251001',
      '너는 단체 대화방 상태 관리자야. JSON으로만 응답해.',
      [{ role: 'user', content: prompt }]
    );
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return;
    await supabase.from('group_rooms').update({ room_state: JSON.parse(match[0]) }).eq('id', roomId);
  } catch { /* 실패해도 메인 기능에 영향 없음 */ }
}

// ── Utils ─────────────────────────────────────────────────────────────────────
function cleanRoleplay(text: string): string {
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

function resolveModel(provider: string, rawModel: string): string | null {
  if (!rawModel) return null;
  const prefixMap: Record<string, string> = {
    claude: 'claude-', 'seoa-worker': 'claude-',
    gemini: 'gemini-', deepseek: 'deepseek-', grok: 'grok-', openai: 'gpt-',
  };
  const prefix = prefixMap[provider];
  return prefix && !rawModel.startsWith(prefix) ? null : rawModel;
}
