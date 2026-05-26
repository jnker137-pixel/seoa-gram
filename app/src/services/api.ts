import type { Character, Message } from '../types';
import { sendMessageDirect } from './aiClient';

export async function sendMessage(
  character: Character,
  userMessage: string,
  _history: Message[]
): Promise<string> {
  return sendMessageDirect(character, userMessage);
}

import type { GroupResponse } from '../types';

// group chat — Worker 없이 미구현 (단톡방 기능 복원 시 추가)
export async function sendGroupMessage(
  _roomId: string,
  _message: string
): Promise<{ responses: GroupResponse[]; participantIds: string[] }> {
  throw new Error('단톡방 기능은 현재 비활성화됨');
}
