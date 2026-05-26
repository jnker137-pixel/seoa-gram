// Worker 없이 브라우저 직접 AI API 호출
import type { Character, CharacterContext, UserProfile } from '../types';
import { supabase } from './supabase';

// ── API Keys ──────────────────────────────────────────────────────────────────
const ANTHROPIC_API_KEY = import.meta.env.VITE_ANTHROPIC_API_KEY as string;
const GEMINI_API_KEY    = 'AIzaSyDXzQhqiw45iBwUAuSLP3sVOhLQ8YI5pec';
const DEEPSEEK_API_KEY  = 'sk-b449232911ee4721844178f270f866fa';

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
