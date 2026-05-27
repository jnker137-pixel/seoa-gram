import type { Character, Message, GroupResponse } from '../types';
import { sendMessageDirect, sendGroupMessageDirect } from './aiClient';

export async function sendMessage(
  character: Character,
  userMessage: string,
  _history: Message[]
): Promise<string> {
  return sendMessageDirect(character, userMessage);
}

export async function sendGroupMessage(
  roomId: string,
  message: string,
): Promise<{ responses: GroupResponse[]; participantIds: string[] }> {
  return sendGroupMessageDirect(roomId, message);
}
