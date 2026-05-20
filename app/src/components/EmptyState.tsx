interface EmptyStateProps {
  onAdd: () => void;
}

export default function EmptyState({ onAdd }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center flex-1 gap-6 text-gray-400 p-8">
      <div className="w-20 h-20 rounded-full bg-gray-100 flex items-center justify-center">
        <svg className="w-10 h-10 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M17 8h2a2 2 0 012 2v6a2 2 0 01-2 2h-2v4l-4-4H9a1.994 1.994 0 01-1.414-.586m0 0L11 14h4a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2v4l.586-.586z"
          />
        </svg>
      </div>
      <div className="text-center">
        <h3 className="text-lg font-semibold text-gray-600 mb-1">캐릭터를 선택하세요</h3>
        <p className="text-sm text-gray-400">
          왼쪽 목록에서 캐릭터를 선택하거나
          <br />새 캐릭터를 추가해보세요
        </p>
      </div>
      <button
        onClick={onAdd}
        className="px-5 py-2.5 rounded-xl bg-gray-900 text-white text-sm font-medium hover:bg-gray-700 transition-colors"
      >
        첫 번째 캐릭터 추가
      </button>
    </div>
  );
}
