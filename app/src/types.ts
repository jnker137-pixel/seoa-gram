export type ApiProvider = 'seoa-worker' | 'claude' | 'gemini' | 'deepseek' | 'grok' | 'openai';

export interface Character {
  id: string;
  name: string;
  system_prompt: string;
  api_provider: ApiProvider;
  model: string;
  avatar_url: string | null;
  color: string;
  tools_enabled: boolean;
  created_at?: string;
}

export interface Message {
  id?: number;
  character_id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at?: string;
}

export interface CharacterContext {
  id?: number;
  character_id: string;
  relationship_summary: string | null;
  memorable_moments: string | null;
  mood: string | null;
  updated_at?: string;
}

export interface UserProfile {
  id: string;
  name: string;
  personality: string | null;
  investment_style: string | null;
  lifestyle: string | null;
  updated_at?: string;
}

// SillyTavern / PocketRisu character card JSON format
export interface CharacterCardV2 {
  spec?: string;
  spec_version?: string;
  data?: {
    name?: string;
    description?: string;
    personality?: string;
    scenario?: string;
    first_mes?: string;
    mes_example?: string;
    system_prompt?: string;
    tags?: string[];
    avatar?: string;
  };
  // Legacy format (V1)
  name?: string;
  description?: string;
  personality?: string;
  scenario?: string;
  system_prompt?: string;
}

export interface ChatState {
  messages: Message[];
  isLoading: boolean;
  error: string | null;
}
