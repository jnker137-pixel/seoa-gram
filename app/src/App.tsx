import { useEffect, useState } from 'react';
import type { Character, Message } from './types';
import {
  fetchCharacters,
  upsertCharacter,
  deleteCharacter,
  fetchMessages,
  clearMessages,
} from './services/supabase';
import { subscribeToPush } from './services/pushSubscription';
import Sidebar from './components/Sidebar';
import ChatView from './components/ChatView';
import CharacterEditor from './components/CharacterEditor';
import UserProfileEditor from './components/UserProfileEditor';
import EmptyState from './components/EmptyState';

export default function App() {
  const [characters, setCharacters] = useState<Character[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messagesByChar, setMessagesByChar] = useState<Record<string, Message[]>>({});
  const [loadingChars, setLoadingChars] = useState(true);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingChar, setEditingChar] = useState<Character | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [notifStatus, setNotifStatus] = useState<'default' | 'granted' | 'denied'>('default');
  const [notifError, setNotifError] = useState<string | null>(null);
  const [notifDone, setNotifDone] = useState(false);

  // 알림 권한 상태 확인 + 이미 granted면 자동 구독 시도
  useEffect(() => {
    if (!('Notification' in window)) return;
    const perm = Notification.permission as 'default' | 'granted' | 'denied';
    setNotifStatus(perm);
    if (perm === 'granted') {
      subscribeToPush('seoa-gram-seongmin')
        .then(() => setNotifDone(true))
        .catch((e) => setNotifError(String(e)));
    }
  }, []);

  const handleEnableNotifications = async () => {
    setNotifError(null);
    try {
      await subscribeToPush('seoa-gram-seongmin');
      setNotifStatus('granted');
      setNotifDone(true);
    } catch (e) {
      setNotifError(String(e));
    }
  };

  // Load characters from Supabase on mount
  useEffect(() => {
    fetchCharacters()
      .then((chars) => {
        setCharacters(chars);
        // URL 파라미터 ?character=xxx 우선 처리 (FCM 알림 탭 시)
        const params = new URLSearchParams(window.location.search);
        const charParam = params.get('character');
        if (charParam && chars.find((c) => c.id === charParam)) {
          setActiveId(charParam);
        } else {
          const last = localStorage.getItem('companions_last_char');
          if (last && chars.find((c) => c.id === last)) {
            setActiveId(last);
          } else if (chars.length > 0) {
            setActiveId(chars[0].id);
          }
        }
      })
      .catch((e) => console.error('캐릭터 로드 실패:', e))
      .finally(() => setLoadingChars(false));
  }, []);

  // Load messages when active character changes
  useEffect(() => {
    if (!activeId) return;
    if (messagesByChar[activeId]) return;

    fetchMessages(activeId)
      .then((msgs) => {
        setMessagesByChar((prev) => ({ ...prev, [activeId]: msgs }));
      })
      .catch((e) => console.error('메시지 로드 실패:', e));
  }, [activeId]);

  // Persist last active char
  useEffect(() => {
    if (activeId) localStorage.setItem('companions_last_char', activeId);
  }, [activeId]);

  const handleSelectChar = (id: string) => {
    setActiveId(id);
    if (window.innerWidth < 768) setSidebarOpen(false);
  };

  const handleMessagesChange = (characterId: string, msgs: Message[]) => {
    setMessagesByChar((prev) => ({ ...prev, [characterId]: msgs }));
  };

  const handleOpenAdd = () => {
    setEditingChar(null);
    setEditorOpen(true);
  };

  const handleOpenEdit = (char: Character) => {
    setEditingChar(char);
    setEditorOpen(true);
  };

  const handleSaveCharacter = async (char: Character) => {
    const saved = await upsertCharacter(char);
    setCharacters((prev) => {
      const idx = prev.findIndex((c) => c.id === saved.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = saved;
        return next;
      }
      return [...prev, saved];
    });
    setActiveId(saved.id);
    setEditorOpen(false);
  };

  const handleDeleteCharacter = async (id: string) => {
    await deleteCharacter(id);
    if (id !== 'seoa') {
      await clearMessages(id).catch(() => {});
    }
    setCharacters((prev) => prev.filter((c) => c.id !== id));
    setMessagesByChar((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    if (activeId === id) {
      const remaining = characters.filter((c) => c.id !== id);
      setActiveId(remaining[0]?.id ?? null);
    }
    setEditorOpen(false);
  };

  const handleClearMessages = async (id: string) => {
    if (id === 'seoa') return;
    await clearMessages(id).catch(() => {});
    setMessagesByChar((prev) => ({ ...prev, [id]: [] }));
  };

  const activeCharacter = characters.find((c) => c.id === activeId) ?? null;
  const activeMessages = activeId ? (messagesByChar[activeId] ?? []) : [];

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-gray-50">
      {/* 알림 배너 */}
      {notifError && (
        <div className="flex items-center justify-between px-4 py-2 bg-red-600 text-white text-xs shrink-0">
          <span className="truncate">⚠️ {notifError}</span>
          <button onClick={handleEnableNotifications} className="ml-3 px-2 py-1 bg-white text-red-600 rounded font-medium shrink-0">
            재시도
          </button>
        </div>
      )}
      {!notifError && notifDone && (
        <div className="px-4 py-1 bg-green-600 text-white text-xs shrink-0 text-center">
          ✅ 알림 구독 완료
        </div>
      )}
      {!notifError && !notifDone && notifStatus === 'default' && (
        <div className="flex items-center justify-between px-4 py-2 bg-indigo-600 text-white text-sm shrink-0">
          <span>브리핑 알림을 받으려면 알림을 허용해줘</span>
          <button onClick={handleEnableNotifications} className="ml-4 px-3 py-1 bg-white text-indigo-600 rounded-lg font-medium text-xs">
            알림 허용
          </button>
        </div>
      )}
    <div className="flex flex-1 overflow-hidden">
      {/* Mobile sidebar toggle */}
      <button
        onClick={() => setSidebarOpen((o) => !o)}
        className="fixed top-3 left-3 z-30 p-2 rounded-xl bg-gray-900 text-white shadow-lg md:hidden"
      >
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>

      {/* Sidebar overlay (mobile) */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/40 z-20 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <div
        className={`
          fixed md:static z-20 h-full transition-transform duration-200
          ${sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}
        `}
      >
        <Sidebar
          characters={characters}
          activeId={activeId}
          onSelect={handleSelectChar}
          onAddCharacter={handleOpenAdd}
          onEditCharacter={handleOpenEdit}
          onOpenProfile={() => setProfileOpen(true)}
        />
      </div>

      {/* Main area */}
      <main className="flex-1 flex flex-col min-w-0">
        {loadingChars ? (
          <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
            로딩 중...
          </div>
        ) : activeCharacter ? (
          <ChatView
            character={activeCharacter}
            messages={activeMessages}
            onMessagesChange={(msgs) => handleMessagesChange(activeCharacter.id, msgs)}
          />
        ) : (
          <EmptyState onAdd={handleOpenAdd} />
        )}
      </main>

      {/* Character editor modal */}
      {editorOpen && (
        <CharacterEditor
          character={editingChar}
          onSave={handleSaveCharacter}
          onDelete={handleDeleteCharacter}
          onClearMessages={editingChar ? () => handleClearMessages(editingChar.id) : undefined}
          onClose={() => setEditorOpen(false)}
        />
      )}

      {/* User profile editor modal */}
      {profileOpen && (
        <UserProfileEditor onClose={() => setProfileOpen(false)} />
      )}
    </div>
    </div>
  );
}
