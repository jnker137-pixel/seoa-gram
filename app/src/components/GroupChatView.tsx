import { useEffect, useRef, useState } from 'react';
import type { Character, GroupMessage } from '../types';
import { fetchGroupMessages, updateGroupParticipants, supabase } from '../services/supabase';
import { sendGroupMessage } from '../services/api';
import TypingIndicator from './TypingIndicator';

interface GroupChatViewProps {
  characters: Character[];
  roomId?: string;
}

function formatTime(ts: string | undefined): string {
  if (!ts) return '';
  const kst = new Date(new Date(ts).getTime() + 9 * 60 * 60 * 1000);
  const h = String(kst.getUTCHours()).padStart(2, '0');
  const mi = String(kst.getUTCMinutes()).padStart(2, '0');
  return `${h}:${mi}`;
}

function CharAvatar({ character, size = 'md' }: { character: Character; size?: 'sm' | 'md' | 'lg' }) {
  const dim = size === 'sm' ? 'w-6 h-6 text-[10px]' : size === 'lg' ? 'w-10 h-10 text-sm' : 'w-8 h-8 text-xs';
  return (
    <div
      className={`${dim} rounded-full flex items-center justify-center font-bold flex-shrink-0 overflow-hidden`}
      style={{ backgroundColor: character.color }}
    >
      {character.avatar_url ? (
        <img src={character.avatar_url} alt={character.name} className="w-full h-full object-cover" />
      ) : (
        <span className="text-white">{character.name.slice(0, 1)}</span>
      )}
    </div>
  );
}

export default function GroupChatView({ characters, roomId = 'main' }: GroupChatViewProps) {
  const [messages, setMessages] = useState<GroupMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [roomParticipantIds, setRoomParticipantIds] = useState<string[]>(
    characters.filter(c => c.id !== 'harin' && c.id !== 'seoa' && c.id !== 'seoa-swing').map(c => c.id)
  );
  const [typingIds, setTypingIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [manageOpen, setManageOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 단체방에 초대 가능한 캐릭터 (seoa-worker, seoa-swing, harin 제외)
  const invitableChars = characters.filter(c => c.id !== 'harin' && c.id !== 'seoa' && c.id !== 'seoa-swing');
  const charById = Object.fromEntries(characters.map(c => [c.id, c]));
  const participants = roomParticipantIds.map(id => charById[id]).filter(Boolean) as Character[];

  useEffect(() => {
    Promise.all([
      fetchGroupMessages(roomId),
      supabase.from('group_rooms').select('participant_ids').eq('id', roomId).single(),
    ]).then(([msgs, { data }]) => {
      setMessages(msgs);
      if (data?.participant_ids?.length) setRoomParticipantIds(data.participant_ids);
    }).catch((e) => setError(String(e)));
  }, [roomId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, typingIds]);

  const handleToggleParticipant = async (charId: string) => {
    const next = roomParticipantIds.includes(charId)
      ? roomParticipantIds.filter(id => id !== charId)
      : [...roomParticipantIds, charId];
    setRoomParticipantIds(next);
    await updateGroupParticipants(roomId, next).catch(() => {});
  };

  const handleSend = async () => {
    const text = input.trim();
    if (!text || isLoading) return;

    setInput('');
    setError(null);

    const userMsg: GroupMessage = {
      room_id: roomId,
      character_id: 'user',
      character_name: '성민',
      content: text,
      created_at: new Date().toISOString(),
    };
    setMessages(prev => [...prev, userMsg]);
    setTypingIds(roomParticipantIds);
    setIsLoading(true);

    try {
      const { responses, participantIds } = await sendGroupMessage(roomId, text);
      if (participantIds.length > 0) setRoomParticipantIds(participantIds);

      const sorted = [...responses].sort((a, b) => a.reply.length - b.reply.length);
      for (let i = 0; i < sorted.length; i++) {
        if (i > 0) await new Promise(r => setTimeout(r, 450));
        const r = sorted[i];
        setTypingIds(prev => prev.filter(id => id !== r.character_id));
        setMessages(prev => [...prev, {
          room_id: roomId,
          character_id: r.character_id,
          character_name: r.name,
          content: r.reply,
          created_at: new Date().toISOString(),
        }]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '오류가 발생했어요');
    } finally {
      setIsLoading(false);
      setTypingIds([]);
      textareaRef.current?.focus();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-gray-50">
      {/* Header */}
      <header className="relative flex-shrink-0 bg-white border-b border-gray-200 px-5 pt-5 pb-4">
        <div className="flex items-start justify-between">
          <div>
            {/* 참여자 아바타 */}
            <div className="flex items-center mb-3">
              {participants.map((char, i) => (
                <div key={char.id} style={{ marginLeft: i > 0 ? '-8px' : 0, zIndex: participants.length - i }} className="relative ring-2 ring-white rounded-full">
                  <CharAvatar character={char} size="lg" />
                </div>
              ))}
              {participants.length === 0 && (
                <div className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center text-gray-400 text-xs">?</div>
              )}
            </div>
            <h2 className="text-lg font-bold text-gray-900">단체 대화방</h2>
            <p className="text-xs text-gray-400 mt-0.5">
              {participants.length > 0 ? participants.map(c => c.name).join(' · ') : '참여자 없음'}
            </p>
          </div>
          {/* 참여자 관리 버튼 */}
          <button
            onClick={() => setManageOpen(o => !o)}
            className={`p-2 rounded-xl transition-colors ${manageOpen ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}
            title="참여자 관리"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>
        </div>

        {/* 참여자 관리 패널 */}
        {manageOpen && (
          <div className="mt-3 pt-3 border-t border-gray-100">
            <p className="text-[11px] text-gray-400 mb-2 font-medium uppercase tracking-wide">캐릭터 초대 / 강퇴</p>
            <div className="flex flex-wrap gap-2">
              {invitableChars.map(char => {
                const isIn = roomParticipantIds.includes(char.id);
                return (
                  <button
                    key={char.id}
                    onClick={() => handleToggleParticipant(char.id)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all ${
                      isIn
                        ? 'text-white shadow-sm'
                        : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                    }`}
                    style={isIn ? { backgroundColor: char.color } : {}}
                  >
                    <span>{char.name}</span>
                    <span className="opacity-70">{isIn ? '✕' : '+'}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-2">
        {messages.length === 0 && !isLoading && (
          <div className="flex flex-col items-center justify-center h-full text-gray-400 text-sm gap-1">
            <p className="font-medium text-gray-500">단체 대화방</p>
            <p>메시지를 보내면 모두가 반응해</p>
          </div>
        )}

        {messages.map((msg, idx) => {
          const isUser = msg.character_id === 'user';
          const char = isUser ? null : charById[msg.character_id];

          if (isUser) {
            return (
              <div key={msg.id ?? idx} className="flex justify-end">
                <div className="flex flex-col items-end max-w-[80%]">
                  <div className="px-4 py-2.5 rounded-2xl rounded-br-sm text-white text-base leading-relaxed whitespace-pre-wrap break-words bg-gray-800">
                    {msg.content}
                  </div>
                  <span className="text-[10px] text-gray-400 mt-0.5 px-1">{formatTime(msg.created_at)}</span>
                </div>
              </div>
            );
          }

          return (
            <div key={msg.id ?? idx} className="flex items-end gap-2 max-w-[85%]">
              {char ? (
                <CharAvatar character={char} />
              ) : (
                <div className="w-8 h-8 rounded-full bg-gray-200 flex-shrink-0" />
              )}
              <div className="flex flex-col items-start">
                <span className="text-[11px] font-semibold mb-0.5 px-1" style={{ color: char?.color || '#6366f1' }}>
                  {msg.character_name || msg.character_id}
                </span>
                <div className="px-4 py-2.5 rounded-2xl rounded-bl-sm bg-white text-gray-800 text-base leading-relaxed whitespace-pre-wrap break-words border border-gray-100 shadow-sm">
                  {msg.content}
                </div>
                <span className="text-[10px] text-gray-400 mt-0.5 px-1">{formatTime(msg.created_at)}</span>
              </div>
            </div>
          );
        })}

        {typingIds.map(charId => {
          const char = charById[charId];
          if (!char) return null;
          return (
            <div key={`typing-${charId}`} className="flex items-end gap-2">
              <CharAvatar character={char} />
              <div className="flex flex-col items-start">
                <span className="text-[11px] font-semibold mb-0.5 px-1" style={{ color: char.color }}>{char.name}</span>
                <div className="px-4 py-2.5 rounded-2xl rounded-bl-sm bg-white border border-gray-100 shadow-sm">
                  <TypingIndicator />
                </div>
              </div>
            </div>
          );
        })}

        {error && (
          <div className="flex justify-center">
            <div className="bg-red-50 border border-red-200 text-red-600 text-sm px-4 py-2 rounded-xl">{error}</div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="flex-shrink-0 px-4 py-4 bg-white border-t border-gray-200">
        <div className="flex items-end gap-2 bg-gray-50 rounded-2xl border border-gray-200 px-4 py-2 focus-within:border-gray-400 transition-colors">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="모두에게 메시지 보내기..."
            rows={1}
            disabled={isLoading}
            className="flex-1 bg-transparent resize-none outline-none text-base text-gray-800 placeholder-gray-400 max-h-32 py-1.5 disabled:opacity-50"
            style={{ lineHeight: '1.5' }}
            onInput={(e) => {
              const el = e.currentTarget;
              el.style.height = 'auto';
              el.style.height = el.scrollHeight + 'px';
            }}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || isLoading}
            className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center bg-gray-800 transition-all disabled:opacity-40"
          >
            <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 19V5m-7 7l7-7 7 7" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
