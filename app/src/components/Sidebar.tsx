import type { Character } from '../types';

interface SidebarProps {
  characters: Character[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onAddCharacter: () => void;
  onEditCharacter: (char: Character) => void;
  onOpenProfile: () => void;
}

const GROUP_ID = '__group__';

function getInitials(name: string): string {
  return name
    .split(' ')
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

export default function Sidebar({
  characters,
  activeId,
  onSelect,
  onAddCharacter,
  onEditCharacter,
  onOpenProfile,
}: SidebarProps) {
  return (
    <aside className="flex flex-col w-64 min-w-[64px] max-w-xs bg-white border-r border-gray-200 h-[100dvh]">
      {/* Header */}
      <div className="px-4 py-5 border-b border-gray-100">
        <h1 className="text-lg font-bold tracking-tight text-gray-900">Companions</h1>
        <p className="text-xs text-gray-400 mt-0.5">AI 캐릭터 모음</p>
      </div>

      {/* Character list */}
      <nav className="flex-1 overflow-y-auto py-3 space-y-0.5 px-2">
        {/* 단체 대화방 */}
        <button
          onClick={() => onSelect(GROUP_ID)}
          className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-all ${
            activeId === GROUP_ID
              ? 'bg-gray-100 text-gray-900'
              : 'text-gray-500 hover:bg-gray-50 hover:text-gray-700'
          }`}
        >
          <div className="w-9 h-9 rounded-full flex items-center justify-center bg-gray-100 flex-shrink-0">
            <svg className="w-4 h-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <span className="text-sm font-medium">단체 대화방</span>
            <p className="text-[11px] text-gray-400">group</p>
          </div>
        </button>

        {/* 구분선 */}
        <div className="border-t border-gray-100 my-1.5 mx-1" />

        {characters.map((char) => {
          const isActive = char.id === activeId;
          return (
            <div key={char.id} className="group relative">
              <button
                onClick={() => onSelect(char.id)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-all pr-10 ${
                  isActive
                    ? 'bg-gray-100 text-gray-900'
                    : 'text-gray-600 hover:bg-gray-50 hover:text-gray-800'
                }`}
              >
                <div
                  className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-semibold flex-shrink-0 overflow-hidden"
                  style={{ backgroundColor: char.color }}
                >
                  {char.avatar_url ? (
                    <img
                      src={char.avatar_url}
                      alt={char.name}
                      className="w-full h-full object-cover"
                      onError={(e) => {
                        (e.currentTarget as HTMLImageElement).style.display = 'none';
                      }}
                    />
                  ) : (
                    <span className="text-white">{getInitials(char.name)}</span>
                  )}
                </div>

                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium truncate block">{char.name}</span>
                  <p className="text-[11px] text-gray-400 truncate">{char.api_provider}</p>
                </div>
              </button>

              <button
                onClick={(e) => { e.stopPropagation(); onEditCharacter(char); }}
                title="캐릭터 설정"
                className={`absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-lg transition-all
                  ${isActive
                    ? 'opacity-50 hover:opacity-100 hover:bg-gray-200 text-gray-600'
                    : 'opacity-0 group-hover:opacity-50 hover:!opacity-100 hover:bg-gray-200 text-gray-400'
                  }`}
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                </svg>
              </button>
            </div>
          );
        })}

        {characters.length === 0 && (
          <div className="text-center text-gray-400 text-sm py-8 px-4">
            캐릭터가 없어요<br />아래에서 추가해보세요
          </div>
        )}
      </nav>

      {/* Bottom buttons */}
      <div className="p-3 border-t border-gray-100 space-y-1.5">
        <button
          onClick={onAddCharacter}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border-2 border-dashed border-gray-200 hover:border-gray-300 hover:bg-gray-50 text-gray-500 hover:text-gray-700 text-sm font-medium transition-all"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          캐릭터 추가
        </button>
        <button
          onClick={onOpenProfile}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-gray-400 hover:text-gray-600 hover:bg-gray-50 text-sm transition-all"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
          </svg>
          내 프로필
        </button>
      </div>
    </aside>
  );
}
