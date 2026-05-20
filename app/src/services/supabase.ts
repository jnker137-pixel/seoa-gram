import { createClient } from '@supabase/supabase-js';
import type { Character, Message, CharacterContext, UserProfile } from '../types';

const SUPABASE_URL = 'https://uxiymaeobmleshekvqvl.supabase.co';
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV4aXltYWVvYm1sZXNoZWt2cXZsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE1NTQ3OTYsImV4cCI6MjA4NzEzMDc5Nn0.cAltB-U4B7-38M065Cn30uwoPu-wzh62IkuDUT4rrAQ';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── Characters ──────────────────────────────────────────────────────────────

export async function fetchCharacters(): Promise<Character[]> {
  const { data, error } = await supabase
    .from('characters')
    .select('*')
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

export async function upsertCharacter(character: Character): Promise<Character> {
  const { data, error } = await supabase
    .from('characters')
    .upsert(character, { onConflict: 'id' })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteCharacter(id: string): Promise<void> {
  const { error } = await supabase.from('characters').delete().eq('id', id);
  if (error) throw error;
}

// ── Messages ─────────────────────────────────────────────────────────────────

export async function fetchMessages(
  characterId: string,
  limit = 30
): Promise<Message[]> {
  // 서아는 텔레그램과 공유하는 prism_conversation_log 사용
  if (characterId === 'seoa') {
    const { data, error } = await supabase
      .from('prism_conversation_log')
      .select('id, role, content, created_at')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return (data ?? []).reverse().map((r) => ({ ...r, character_id: 'seoa' })) as Message[];
  }

  const { data, error } = await supabase
    .from('conversation_log')
    .select('*')
    .eq('character_id', characterId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).reverse() as Message[];
}

export async function saveMessage(msg: Omit<Message, 'id' | 'created_at'>): Promise<void> {
  const { error } = await supabase.from('conversation_log').insert(msg);
  if (error) throw error;
}

export async function clearMessages(characterId: string): Promise<void> {
  const { error } = await supabase
    .from('conversation_log')
    .delete()
    .eq('character_id', characterId);
  if (error) throw error;
}

// ── Character Context (long-term memory) ─────────────────────────────────────

export async function fetchContext(characterId: string): Promise<CharacterContext | null> {
  const { data, error } = await supabase
    .from('character_context')
    .select('*')
    .eq('character_id', characterId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function upsertContext(ctx: CharacterContext): Promise<void> {
  const { error } = await supabase
    .from('character_context')
    .upsert({ ...ctx, updated_at: new Date().toISOString() }, { onConflict: 'character_id' });
  if (error) throw error;
}

// ── User Profile (공통 유저 정보) ─────────────────────────────────────────────

export async function fetchUserProfile(): Promise<UserProfile | null> {
  const { data, error } = await supabase
    .from('user_profile')
    .select('*')
    .eq('id', 'seongmin')
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function upsertUserProfile(profile: UserProfile): Promise<void> {
  const { error } = await supabase
    .from('user_profile')
    .upsert({ ...profile, updated_at: new Date().toISOString() }, { onConflict: 'id' });
  if (error) throw error;
}
