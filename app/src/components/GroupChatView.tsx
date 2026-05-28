import { useEffect, useRef, useState } from 'react';
import type { Character, GroupMessage } from '../types';
import { fetchGroupMessages, supabase } from '../services/supabase';
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

function CharAvatar({ character, size = 'md' }: { character: Character; size?: 'sm' | 'md' }) {
  const dim = size === 'sm' ? 'w-6 h-6 text-[10px]' : 'w-8 h-8 text-xs';
  return (
    <div
      className={`${dim} rounded-full flex items-center justify-center font-bold flex-shrink-0 overflow-hidden`}
      style={{ backgroundColor: character.color }}
    >
      {character.avatar_url ? (
        <img src={character.avatar_url} alt={character.name} className="w-full h-full object-cover" />
      ) : (
        <span className="text-white">{character.name.slice(0, 1).toUpperCase()}</span>
      )}
    </div>
  );
}

export default function GroupChatView({ characters, roomId = 'main' }: GroupChatViewProps) {
  const [messages, setMessages] = useState<GroupMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [roomParticipantIds, setRoomParticipantIds] = useState<string[]>(
    characters.filter(c => c.id !== 'harin').map(c => c.id)
  );
  const [typingIds, setTypingIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showMemberPanel, setShowMemberPanel] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const charById = Object.fromEntries(characters.map(c => [c.id, c]));
  const participants = roomParticipantIds.map(id => charById[id]).filter(Boolean) as Character[];
  // harin은 단체방 미지원, 나머지 전체
  const availableChars = characters.filter(c => c.id !== 'harin');

  useEffect(() => {
    Promise.all([
      fetchGroupMessages(roomId),
      supabase.from('group_rooms').select('participant_ids').eq('id', roomId).single(),
    ]).then(([msgs, { data }]) => {
      setMessages(msgs);
      if (data && data.participant_ids?.length) setRoomParticipantIds(data.participant_ids);
    }).catch((e) => setError(String(e)));
  }, [roomId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, typingIds]);

  const toggleMember = async (charId: string) => {
    const isIn = roomParticipantIds.includes(charId);
    const newIds = isIn
      ? roomParticipantIds.filter(id => id !== charId)
      : [...roomParticipantIds, charId];
    setRoomParticipantIds(newIds);
    await supabase.from('group_rooms').update({ participant_ids: newIds }).eq('id', roomId);
  };

  const handleSend = async () => {
    const text = input.trim();
    if (!text || isLoading) return;

    setInput('');
    setError(null);
    setShowMemberPanel(false);

    const userMsg: GroupMessage = {
      room_id: roomId,
      character_id: 'user',
      character_name: '성민',
      content: text,
      created_at: new Date().toISOString(),
    };
    setMessages(prev => [...prev, userMsg]);
    // 초기: 전원 타이핑 표시 (Orchestrator 결과 오기 전)
    setTypingIds(roomParticipantIds);
    setIsLoading(true);

    try {
      const { participantIds } = await sendGroupMessage(
        roomId,
        text,
        // onResponse: 생성 즉시 메시지 표시
        (response) => {
          setTypingIds(prev => prev.filter(id => id !== response.character_id));
          setMessages(prev => [...prev, {
            room_id: roomId,
            character_id: response.character_id,
            character_name: response.name,
            content: response.reply,
            created_at: new Date().toISOString(),
          }]);
        },
        // onPlanReady: Orchestrator가 결정한 화자만 타이핑 표시
        (speakerIds) => {
          setTypingIds(speakerIds);
        },
      );

      if (participantIds.length > 0) setRoomParticipantIds(participantIds);
    } catch (e) {
      setError(e instanceof Error ? e.message : '오류가 발생했어요');
    } finally {
      setIsLoading(false);
      setTypingIds([]);
      // 자동 포커스 없음 — 읽은 후 직접 탭해서 입력
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-gray-50">
      {/* Header */}
      <header className="flex-shrink-0 bg-white border-b border-gray-200 shadow-sm">
        <div className="px-5 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex items-center">
              {participants.slice(0, 4).map((char, i) => (
                <div key={char.id} style={{ marginLeft: i > 0 ? '-6px' : 0, zIndex: 10 - i }} className="relative">
                  <CharAvatar character={char} size="sm" />
                </div>
              ))}
              {participants.length > 4 && (
                <div className="w-6 h-6 rounded-full bg-gray-200 flex items-center justify-center text-[9px] text-gray-500 font-bold" style={{ marginLeft: '-6px', zIndex: 5 }}>
                  +{participants.length - 4}
                </div>
              )}
            </div>
            <div>
              <h2 className="text-base font-bold text-gray-900 leading-tight">단체 대화방</h2>
              <p className="text-[11px] text-gray-400 leading-tight">
                {participants.map(c => c.name).join(' · ')}
              </p>
            </div>
          </div>
          <button
            onClick={() => setShowMemberPanel(v => !v)}
            className={`text-xs font-medium px-3 py-1.5 rounded-full border transition-colors ${
              showMemberPanel
                ? 'bg-gray-800 text-white border-gray-800'
                : 'bg-white text-gray-600 border-gray-300 hover:border-gray-400'
            }`}
          >
            멤버
          </button>
        </div>

        {/* 멤버 관리 패널 */}
        {showMemberPanel && (
          <div className="px-5 pb-3 border-t border-gray-100">
            <p className="text-[11px] text-gray-400 mt-2 mb-2">탭해서 초대 · 강퇴</p>
            <div className="flex flex-wrap gap-2">
              {availableChars.map(char => {
                const isIn = roomParticipantIds.includes(char.id);
                return (
                  <button
                    key={char.id}
                    onClick={() => toggleMember(char.id)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${
                      isIn
                        ? 'text-white border-transparent'
                        : 'bg-white text-gray-500 border-gray-300'
                    }`}
                    style={isIn ? { backgroundColor: char.color, borderColor: char.color } : {}}
                  >
                    <CharAvatar character={char} size="sm" />
                    {char.name}
                    {isIn && (
                      <svg className="w-3 h-3 ml-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    )}
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
                  <div className="px-4 py-2.5 rounded-2xl rounded-br-sm text-white text-base leading-relaxed whitespace-pre-wrap break-words bg-indigo-500">
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
                <div className="w-8 h-8 rounded-full bg-gray-300 flex-shrink-0" />
              )}
              <div className="flex flex-col items-start">
                <span
                  className="text-[11px] font-semibold mb-0.5 px-1"
                  style={{ color: char?.color || '#6366f1' }}
                >
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
                <span className="text-[11px] font-semibold mb-0.5 px-1" style={{ color: char.color }}>
                  {char.name}
                </span>
                <div className="px-4 py-2.5 rounded-2xl rounded-bl-sm bg-white border border-gray-100 shadow-sm">
                  <TypingIndicator />
                </div>
              </div>
            </div>
          );
        })}

        {error && (
          <div className="flex justify-center">
            <div className="bg-red-50 border border-red-200 text-red-600 text-sm px-4 py-2 rounded-xl">
              {error}
            </div>
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
            title="전송 (Enter)"
          >
            <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 19V5m-7 7l7-7 7 7" />
            </svg>
          </button>
        </div>
        <p className="text-[10px] text-gray-400 mt-1.5 text-center">Enter로 전송 · Shift+Enter로 줄바꿈</p>
      </div>
    </div>
  );
}
