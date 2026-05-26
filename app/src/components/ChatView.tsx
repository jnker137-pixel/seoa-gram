import React, { useEffect, useRef, useState } from 'react';
import type { Character, Message } from '../types';
import TypingIndicator from './TypingIndicator';
import { sendMessage } from '../services/api';
import { saveMessage } from '../services/supabase';

interface ChatViewProps {
  character: Character;
  messages: Message[];
  onMessagesChange: (msgs: Message[]) => void;
}

function formatTime(ts: string | undefined): string {
  if (!ts) return '';
  const kst = new Date(new Date(ts).getTime() + 9 * 60 * 60 * 1000);
  const y = kst.getUTCFullYear();
  const mo = kst.getUTCMonth() + 1;
  const d = kst.getUTCDate();
  const h = String(kst.getUTCHours()).padStart(2, '0');
  const mi = String(kst.getUTCMinutes()).padStart(2, '0');
  return `${y}.${mo}.${d}. ${h}:${mi}`;
}

export default function ChatView({
  character,
  messages,
  onMessagesChange,
}: ChatViewProps) {
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || isLoading) return;

    setInput('');
    setError(null);

    const userMsg: Message = {
      character_id: character.id,
      role: 'user',
      content: text,
      created_at: new Date().toISOString(),
    };

    const updatedMessages = [...messages, userMsg];
    onMessagesChange(updatedMessages);
    setIsLoading(true);

    if (character.id !== 'seoa') {
      await saveMessage({ character_id: character.id, role: 'user', content: text }).catch(() => {});
    }

    try {
      const reply = await sendMessage(character, text, updatedMessages);
      const assistantMsg: Message = {
        character_id: character.id,
        role: 'assistant',
        content: reply,
        created_at: new Date().toISOString(),
      };

      const finalMessages = [...updatedMessages, assistantMsg];
      onMessagesChange(finalMessages);

      if (character.id !== 'seoa') {
        await saveMessage({ character_id: character.id, role: 'assistant', content: reply }).catch(() => {});
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '오류가 발생했어요');
      onMessagesChange(messages);
    } finally {
      setIsLoading(false);
      textareaRef.current?.focus();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex flex-col h-full bg-gray-50">
      {/* Banner */}
      <header
        className="relative h-64 flex-shrink-0 overflow-hidden"
        style={{ background: `linear-gradient(135deg, ${character.color}cc, ${character.color}44)` }}
      >
        {character.avatar_url ? (
          <img
            src={character.avatar_url}
            alt={character.name}
            className="absolute inset-0 w-full h-full object-cover object-center"
          />
        ) : (
          <span className="absolute bottom-4 left-5 text-9xl font-black text-white/15 select-none leading-none">
            {character.name.slice(0, 1)}
          </span>
        )}
        <div className="absolute inset-0 bg-gradient-to-b from-black/20 via-transparent to-black/75 pointer-events-none" />
        {/* 눈 깜빡임 오버레이 — 아바타 있을 때만 */}
        {character.avatar_url && (
          <>
            <div className="blink-top" />
            <div className="blink-bottom" />
          </>
        )}

        {/* Name + model */}
        <div className="absolute bottom-0 left-0 right-0 px-5 pb-4">
          <h2 className="text-2xl font-bold text-white drop-shadow-md leading-tight">{character.name}</h2>
          <p className="text-xs text-white/55 mt-1">{character.api_provider} · {character.model || '기본 모델'}</p>
        </div>
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-6 space-y-3">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-gray-400 gap-2">
            <p className="text-sm">
              <span className="font-medium text-gray-600">{character.name}</span>와 대화를 시작해보세요
            </p>
          </div>
        )}

        {messages.map((msg, idx) => {
          const isUser = msg.role === 'user';
          return (
            <div
              key={msg.id ?? idx}
              className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}
            >
              <div className={`flex flex-col ${isUser ? 'items-end' : 'items-start'} max-w-[92%]`}>
                <div
                  className={`px-4 py-2.5 rounded-2xl text-base leading-relaxed whitespace-pre-wrap break-words ${
                    isUser
                      ? 'text-white rounded-br-sm'
                      : 'bg-white text-gray-800 rounded-bl-sm border border-gray-100 shadow-sm'
                  }`}
                  style={isUser ? { backgroundColor: character.color } : {}}
                >
                  {msg.content}
                </div>
                {msg.created_at && (
                  <span className="text-[10px] text-gray-400 mt-1 px-1">
                    {formatTime(msg.created_at)}
                  </span>
                )}
              </div>
            </div>
          );
        })}

        {isLoading && (
          <div className="flex justify-start">
            <div className="bg-white border border-gray-100 shadow-sm rounded-2xl rounded-bl-sm px-3 py-2">
              <TypingIndicator />
            </div>
          </div>
        )}

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
      <div className="px-4 py-4 bg-white border-t border-gray-200">
        <div className="flex items-end gap-2 bg-gray-50 rounded-2xl border border-gray-200 px-4 py-2 focus-within:border-gray-400 transition-colors">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={`${character.name}에게 메시지 보내기...`}
            rows={1}
            className="flex-1 bg-transparent resize-none outline-none text-base text-gray-800 placeholder-gray-400 max-h-32 py-1.5"
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
            className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center transition-all disabled:opacity-40"
            style={{ backgroundColor: character.color }}
            title="전송 (Enter)"
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
