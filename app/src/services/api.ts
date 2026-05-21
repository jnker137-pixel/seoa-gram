import type { Character, Message, GroupResponse } from '../types';

const WORKER_URL = 'https://seongmin-bot.jnkre137.workers.dev';

function toKSTLabel(utcStr: string): string {
  const kst = new Date(new Date(utcStr).getTime() + 9 * 60 * 60 * 1000);
  const y = kst.getUTCFullYear();
  const mo = kst.getUTCMonth() + 1;
  const d = kst.getUTCDate();
  const h = String(kst.getUTCHours()).padStart(2, '0');
  const mi = String(kst.getUTCMinutes()).padStart(2, '0');
  return `${y}.${mo}.${d}. ${h}:${mi}`;
}

export async function sendMessage(
  character: Character,
  userMessage: string,
  history: Message[]
): Promise<string> {
  if (character.api_provider === 'seoa-worker') {
    return sendToWorker(userMessage, character.id);
  }

  // For non-seoa characters, route through the Worker's /chat endpoint
  // Worker will handle Claude/Gemini dispatch based on character settings
  return sendToWorker(userMessage, character.id, history);
}

async function sendToWorker(
  message: string,
  characterId: string,
  history?: Message[]
): Promise<string> {
  const body: Record<string, unknown> = {
    message,
    character_id: characterId,
  };

  // Pass recent history for non-seoa characters (seoa handles its own history via Supabase)
  // slice(0, -1): exclude the latest user message — Worker appends it separately
  if (characterId !== 'seoa' && history && history.length > 1) {
    body.history = history.slice(0, -1).slice(-20).map((m) => ({
      role: m.role,
      content: m.created_at ? `[${toKSTLabel(m.created_at)}] ${m.content}` : m.content,
    }));
  }

  const res = await fetch(`${WORKER_URL}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => `HTTP ${res.status}`);
    throw new Error(`Worker error: ${text}`);
  }

  const data = await res.json() as { reply?: string; error?: string };
  if (data.error) throw new Error(data.error);
  return data.reply ?? '';
}

export async function sendGroupMessage(
  roomId: string,
  message: string
): Promise<GroupResponse[]> {
  const res = await fetch(`${WORKER_URL}/group-chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, room_id: roomId }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => `HTTP ${res.status}`);
    throw new Error(`Worker error: ${text}`);
  }
  const data = await res.json() as { responses?: GroupResponse[]; error?: string };
  if (data.error) throw new Error(data.error);
  return data.responses ?? [];
}
