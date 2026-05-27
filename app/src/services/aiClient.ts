// Worker 없이 브라우저 직접 AI API 호출
import type { Character, CharacterContext, UserProfile, GroupResponse } from '../types';
import { supabase } from './supabase';

// ── API Keys ──────────────────────────────────────────────────────────────────
const ANTHROPIC_API_KEY = import.meta.env.VITE_ANTHROPIC_API_KEY as string;
const GEMINI_API_KEY    = import.meta.env.VITE_GEMINI_API_KEY as string;
const DEEPSEEK_API_KEY  = import.meta.env.VITE_DEEPSEEK_API_KEY as string;

// ── Types ─────────────────────────────────────────────────────────────────────
interface ChatMessage { role: 'user' | 'assistant'; content: string }

// ── Entry: 메시지 전송 ─────────────────────────────────────────────────────────
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

  switch (provider) {
    case 'claude':
    case 'seoa-worker':
      raw = await callClaude(model || 'claude-sonnet-4-6', systemPrompt, messages);
      break;
    case 'gemini':
      raw = await callGemini(model || 'gemini-2.5-flash', systemPrompt, messages);
      break;
    case 'deepseek':
      raw = await callOpenAICompat('https://api.deepseek.com/v1/chat/completions', model || 'deepseek-chat', DEEPSEEK_API_KEY, systemPrompt, messages);
      break;
    default:
      throw new Error(`지원하지 않는 프로바이더: ${provider}`);
  }

  const reply = provider === 'deepseek' ? cleanRoleplay(raw) : raw;

  // 저장 + L1 갱신 (background, 응답 블로킹 없음)
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
async function callClaude(model: string, systemPrompt: string, messages: ChatMessage[]): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({ model, max_tokens: 2048, system: systemPrompt, messages }),
  });
  const data = await res.json() as { type?: string; error?: { message?: string }; content?: { type: string; text: string }[] };
  if (!res.ok || data.error) throw new Error(`Claude: ${data.error?.message ?? res.status}`);
  return data.content?.filter(c => c.type === 'text').map(c => c.text).join('') || '응답 없음';
}

async function callGemini(model: string, systemPrompt: string, messages: ChatMessage[]): Promise<string> {
  const cleanedPrompt = systemPrompt.replace(/^[-*•]\s+/gm, '').replace(/\n{3,}/g, '\n\n').trim();
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: cleanedPrompt }] },
        contents,
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

// ── Group Chat Entry ──────────────────────────────────────────────────────────
export async function sendGroupMessageDirect(
  roomId: string,
  userMessage: string,
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
  const recentMsgs = (recentResult.data ?? []).reverse();
  const userName = userIdentity?.name || '성민';

  await supabase.from('group_messages').insert({
    room_id: roomId,
    character_id: 'user',
    character_name: userName,
    content: userMessage,
  });

  const today    = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().split('T')[0];
  const names    = participants.map(c => c.name).join(', ');
  const recentCtx = recentMsgs
    .map(m => `[${m.character_name || m.character_id}] ${m.content.slice(0, 200)}`)
    .join('\n');
  const roomCtx = roomState
    ? [`주제: ${roomState['topic'] || ''}`, `분위기: ${roomState['tone'] || ''}`, `최근 흐름: ${roomState['recent_events'] || ''}`].filter(l => !l.endsWith(': ')).join('\n')
    : '';

  const results = await Promise.allSettled(
    participants.map(async (char): Promise<GroupResponse> => {
      const base = (char.system_prompt || `너는 ${char.name}이야.`)
        .replace(/\{\{user\}\}/gi, userName)
        .replace(/\{\{char\}\}/gi, char.name)
        .trim();

      const systemPrompt = [
        base,
        `오늘 날짜: ${today}`,
        roomCtx ? `## 단체 대화방 맥락\n${roomCtx}` : '',
        recentCtx ? `## 최근 대화\n${recentCtx}` : '',
        `## 지금 네 역할\n- 참여자: ${names}\n- 성민의 새 메시지에 자연스럽게 반응해\n- 짧고 자연스럽게, ${char.name}답게`,
      ].filter(Boolean).join('\n\n');

      const msgs: ChatMessage[] = [{ role: 'user', content: userMessage }];
      const provider = char.api_provider || 'claude';
      const model    = resolveModel(provider, char.model);

      let raw: string;
      switch (provider) {
        case 'claude':
        case 'seoa-worker':
          raw = await callClaude(model || 'claude-sonnet-4-6', systemPrompt, msgs);
          break;
        case 'gemini':
          raw = await callGemini(model || 'gemini-2.5-flash', systemPrompt, msgs);
          break;
        case 'deepseek':
          raw = await callOpenAICompat('https://api.deepseek.com/v1/chat/completions', model || 'deepseek-chat', DEEPSEEK_API_KEY, systemPrompt, msgs);
          break;
        default:
          raw = await callClaude('claude-sonnet-4-6', systemPrompt, msgs);
      }

      return {
        character_id: char.id,
        name: char.name,
        color: char.color,
        reply: provider === 'deepseek' ? cleanRoleplay(raw) : raw,
      };
    })
  );

  const responses: GroupResponse[] = results
    .filter((r): r is PromiseFulfilledResult<GroupResponse> => r.status === 'fulfilled')
    .map(r => r.value);

  if (responses.length > 0) {
    await supabase.from('group_messages').insert(
      responses.map(r => ({
        room_id: roomId,
        character_id: r.character_id,
        character_name: r.name,
        content: r.reply,
      }))
    );
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
