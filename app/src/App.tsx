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
import { triggerDeploy } from './services/api';
import Sidebar from './components/Sidebar';
import ChatView from './components/ChatView';
import GroupChatView from './components/GroupChatView';
import CharacterEditor from './components/CharacterEditor';
import UserProfileEditor from './components/UserProfileEditor';
import EmptyState from './components/EmptyState';
import ErrorBoundary from './components/ErrorBoundary';

const GROUP_ID = '__group__';

const CACHE_CHARS_KEY = 'sg_characters';
const cacheMsgsKey = (id: string) => `sg_msgs_${id}`;

function resolveActiveId(chars: Character[]): string | null {
  const params = new URLSearchParams(window.location.search);
  const charParam = params.get('character');
  if (charParam && chars.find((c) => c.id === charParam)) return charParam;
  const last = localStorage.getItem('companions_last_char');
  if (last === GROUP_ID) return GROUP_ID;
  if (last && chars.find((c) => c.id === last)) return last;
  return chars[0]?.id ?? null;
}

const PREVIEW_KEY = 'sg_active_preview';
const AVATAR_BASE = 'https://jnker137-pixel.github.io/seoa-gram/avatars/';

function Splash({ character, visible }: { character: Character | null; visible: boolean }) {
  const char = character ?? (() => {
    try {
      const raw = localStorage.getItem(PREVIEW_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  })();

  // avatar_url 없으면 GitHub Pages 호스팅 PNG fallback
  const [imgFailed, setImgFailed] = useState(false);
  const avatarSrc = !imgFailed
    ? (char?.avatar_url || (char?.id ? `${AVATAR_BASE}${char.id}.png` : null))
    : null;

  return (
    <div
      className="fixed inset-0 z-50 pointer-events-none transition-opacity duration-700"
      style={{ opacity: visible ? 1 : 0 }}
    >
      {avatarSrc ? (
        <img
          src={avatarSrc}
          alt={char?.name ?? ''}
          className="absolute inset-0 w-full h-full object-cover object-center"
          onError={() => setImgFailed(true)}
        />
      ) : (
        <div
          className="absolute inset-0"
          style={{
            background: `linear-gradient(160deg, ${char?.color || '#6366f1'}dd, ${char?.color || '#6366f1'}55)`
          }}
        >
          <span className="absolute bottom-32 left-8 text-[12rem] font-black text-white/10 select-none leading-none">
            {char?.name?.slice(0, 1) ?? ''}
          </span>
        </div>
      )}
      <div className="absolute inset-0 bg-gradient-to-b from-black/10 via-transparent to-black/80" />
      <div className="absolute bottom-16 left-0 right-0 px-8">
        <p className="text-white/50 text-sm mb-1">seoa-gram</p>
        <h1 className="text-white text-4xl font-bold drop-shadow-lg">{char?.name ?? ''}</h1>
      </div>
    </div>
  );
}

export default function App() {
  // 첫 렌더부터 캐시 데이터로 시작 (useEffect 기다리지 않음)
  const [characters, setCharacters] = useState<Character[]>(() => {
    try {
      const raw = localStorage.getItem(CACHE_CHARS_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  });
  const [activeId, setActiveId] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search);
    const charParam = params.get('character');
    if (charParam) return charParam;
    return localStorage.getItem('companions_last_char');
  });
  const [messagesByChar, setMessagesByChar] = useState<Record<string, Message[]>>(() => {
    try {
      const raw = localStorage.getItem(CACHE_CHARS_KEY);
      const chars: Character[] = raw ? JSON.parse(raw) : [];
      const msgs: Record<string, Message[]> = {};
      for (const c of chars) {
        const m = localStorage.getItem(cacheMsgsKey(c.id));
        if (m) msgs[c.id] = JSON.parse(m);
      }
      return msgs;
    } catch { return {}; }
  });
  const [loadingChars, setLoadingChars] = useState(
    () => !localStorage.getItem(CACHE_CHARS_KEY)
  );
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingChar, setEditingChar] = useState<Character | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= 768);
  const [notifStatus, setNotifStatus] = useState<'default' | 'granted' | 'denied'>('default');
  const [notifError, setNotifError] = useState<string | null>(null);
  const [splashVisible, setSplashVisible] = useState(true);

  // 스플래시: 메시지 준비되면 페이드 (최소 700ms, 최대 2500ms)
  useEffect(() => {
    const maxTimer = setTimeout(() => setSplashVisible(false), 2500);
    return () => clearTimeout(maxTimer);
  }, []);

  useEffect(() => {
    if (!activeId || !messagesByChar[activeId]) return;
    const t = setTimeout(() => setSplashVisible(false), 2000);
    return () => clearTimeout(t);
  }, [activeId, messagesByChar]);

  // 알림 권한 상태 확인
  useEffect(() => {
    if (!('Notification' in window)) return;
    const perm = Notification.permission as 'default' | 'granted' | 'denied';
    setNotifStatus(perm);
    if (perm === 'granted') {
      subscribeToPush('seoa-gram-seongmin').catch((e) => setNotifError(String(e)));
    }
  }, []);

  // Service Worker 메시지 처리 (알람 탭 시 캐릭터 전환)
  useEffect(() => {
    if (!navigator.serviceWorker) return;
    const handler = (e: MessageEvent) => {
      if (e.data?.type === 'navigate' && e.data.character) {
        setActiveId(e.data.character);
        localStorage.setItem('companions_last_char', e.data.character);
      }
    };
    navigator.serviceWorker.addEventListener('message', handler);
    // SW에 ready 알림 — 새 창으로 열렸을 때 pendingNavigate 수신
    navigator.serviceWorker.ready.then((reg) => {
      reg.active?.postMessage({ type: 'ready' });
    });
    return () => navigator.serviceWorker.removeEventListener('message', handler);
  }, []);

  const handleEnableNotifications = async () => {
    setNotifError(null);
    try {
      await subscribeToPush('seoa-gram-seongmin');
      setNotifStatus('granted');
    } catch (e) {
      setNotifError(String(e));
    }
  };

  // Supabase 백그라운드 갱신 (캐시는 useState 초기값에서 이미 로드됨)
  useEffect(() => {
    fetchCharacters()
      .then((chars) => {
        setCharacters(chars);
        // avatar_url 포함 저장 시도 → 용량 초과 시 avatar_url 제외 후 재시도
        try {
          localStorage.setItem(CACHE_CHARS_KEY, JSON.stringify(chars));
        } catch {
          try {
            localStorage.setItem(CACHE_CHARS_KEY, JSON.stringify(
              chars.map(c => ({ ...c, avatar_url: null }))
            ));
          } catch { /* 저장 실패해도 React state는 정상 */ }
        }
        // 현재 선택이 신규 캐릭터(캐시에 없던)면 그대로 유지, 완전 무효한 경우만 재선택
        setActiveId((prev) => {
          const params = new URLSearchParams(window.location.search);
          const charParam = params.get('character');
          if (charParam && chars.find((c) => c.id === charParam)) return charParam;
          if (prev && chars.find((c) => c.id === prev)) return prev;
          return resolveActiveId(chars);
        });
      })
      .catch((e) => console.error('캐릭터 로드 실패:', e))
      .finally(() => setLoadingChars(false));
  }, []);

  // 캐릭터 로드됐는데 activeId가 없으면 자동 선택 (안전망)
  useEffect(() => {
    if (characters.length > 0 && !activeId) {
      setActiveId(resolveActiveId(characters));
    }
  }, [characters]);

  // 활성 캐릭터 바뀌면 메시지 백그라운드 갱신 (캐시 있어도 새로 fetch)
  useEffect(() => {
    if (!activeId) return;
    fetchMessages(activeId)
      .then((msgs) => {
        setMessagesByChar((prev) => {
          // 캐시보다 길거나 내용이 다를 때만 교체 (불필요한 리렌더 방지)
          const prev_msgs = prev[activeId] ?? [];
          if (msgs.length === prev_msgs.length &&
              msgs[msgs.length - 1]?.id === prev_msgs[prev_msgs.length - 1]?.id) {
            return prev;
          }
          return { ...prev, [activeId]: msgs };
        });
        localStorage.setItem(cacheMsgsKey(activeId), JSON.stringify(msgs.slice(-30)));
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
    try {
      localStorage.setItem(cacheMsgsKey(characterId), JSON.stringify(msgs.slice(-30)));
    } catch {}
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
    const existing = characters.find((c) => c.id === char.id);
    const avatarChanged = char.avatar_url !== existing?.avatar_url;
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
    if (avatarChanged) triggerDeploy().catch(() => {});
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

  const activeCharacter = activeId === GROUP_ID ? null : (characters.find((c) => c.id === activeId) ?? null);
  const activeMessages = activeId ? (messagesByChar[activeId] ?? []) : [];

  // 스플래시용 preview 저장 — activeCharacter 확정 후 저장
  useEffect(() => {
    if (!activeCharacter) return;
    try {
      localStorage.setItem(PREVIEW_KEY, JSON.stringify({
        id: activeCharacter.id,
        name: activeCharacter.name,
        color: activeCharacter.color,
        avatar_url: activeCharacter.avatar_url ?? null,
      }));
    } catch {
      try {
        localStorage.setItem(PREVIEW_KEY, JSON.stringify({
          id: activeCharacter.id,
          name: activeCharacter.name,
          color: activeCharacter.color,
        }));
      } catch { /* 무시 */ }
    }
  }, [activeCharacter]);

  return (
    <div className="flex flex-col h-[100dvh] overflow-hidden bg-gray-50">
      {/* 스플래시 */}
      <Splash character={activeCharacter} visible={splashVisible} />

      {/* 알림 배너 (오류 or 최초 권한 요청만) */}
      {notifError && (
        <div className="flex items-center justify-between px-4 py-2 bg-red-600 text-white text-xs shrink-0">
          <span className="truncate">⚠️ {notifError}</span>
          <button onClick={handleEnableNotifications} className="ml-3 px-2 py-1 bg-white text-red-600 rounded font-medium shrink-0">
            재시도
          </button>
        </div>
      )}
      {!notifError && notifStatus === 'default' && (
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
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <ErrorBoundary>
          {activeId === GROUP_ID ? (
            <GroupChatView characters={characters} roomId="main" />
          ) : activeCharacter ? (
            <ChatView
              character={activeCharacter}
              messages={activeMessages}
              onMessagesChange={(msgs) => handleMessagesChange(activeCharacter.id, msgs)}
            />
          ) : loadingChars || activeId ? (
            <div className="flex-1" />
          ) : (
            <EmptyState onAdd={handleOpenAdd} />
          )}
        </ErrorBoundary>
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
