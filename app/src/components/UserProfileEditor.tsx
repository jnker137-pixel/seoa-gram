import { useState, useEffect } from 'react';
import type { UserProfile } from '../types';
import { fetchUserProfile, upsertUserProfile } from '../services/supabase';

interface Props {
  onClose: () => void;
}

const DEFAULT_PROFILE: UserProfile = {
  id: 'seongmin',
  name: '성민',
  personality: null,
  investment_style: null,
  lifestyle: null,
};

export default function UserProfileEditor({ onClose }: Props) {
  const [profile, setProfile] = useState<UserProfile>(DEFAULT_PROFILE);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchUserProfile()
      .then((p) => { if (p) setProfile(p); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await upsertUserProfile(profile);
      onClose();
    } catch (e) {
      alert('저장 실패: ' + String(e));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
        <div className="bg-gray-900 rounded-2xl p-6 text-white text-sm">불러오는 중...</div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-full max-w-lg bg-gray-900 rounded-t-2xl md:rounded-2xl p-6 text-white space-y-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">내 프로필</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-xl leading-none">✕</button>
        </div>

        <p className="text-xs text-gray-400">
          모든 캐릭터가 공통으로 참고하는 정보야. 캐릭터별 대화 경험은 자동으로 쌓여.
        </p>

        <div className="space-y-4">
          <div>
            <label className="text-xs text-gray-400 mb-1 block">이름</label>
            <input
              className="w-full bg-gray-800 rounded-xl px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-indigo-500"
              value={profile.name}
              onChange={(e) => setProfile((p) => ({ ...p, name: e.target.value }))}
            />
          </div>

          <div>
            <label className="text-xs text-gray-400 mb-1 block">성격 / 특징</label>
            <textarea
              rows={3}
              placeholder="예: 겉보다 속이 복잡함. 이해받는 것보다 이해하는 게 익숙함..."
              className="w-full bg-gray-800 rounded-xl px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
              value={profile.personality ?? ''}
              onChange={(e) => setProfile((p) => ({ ...p, personality: e.target.value || null }))}
            />
          </div>

          <div>
            <label className="text-xs text-gray-400 mb-1 block">투자 성향</label>
            <textarea
              rows={2}
              placeholder="예: 장기 ETF 보유, 배당 중시, 손실 포지션 원금 회복 후 정리..."
              className="w-full bg-gray-800 rounded-xl px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
              value={profile.investment_style ?? ''}
              onChange={(e) => setProfile((p) => ({ ...p, investment_style: e.target.value || null }))}
            />
          </div>

          <div>
            <label className="text-xs text-gray-400 mb-1 block">생활 패턴 (선택)</label>
            <textarea
              rows={2}
              placeholder="예: 늦게 자는 편, 퇴근 후 주식 체크, 주말엔 덕질..."
              className="w-full bg-gray-800 rounded-xl px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
              value={profile.lifestyle ?? ''}
              onChange={(e) => setProfile((p) => ({ ...p, lifestyle: e.target.value || null }))}
            />
          </div>
        </div>

        <button
          onClick={handleSave}
          disabled={saving}
          className="w-full py-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-semibold text-sm transition-colors"
        >
          {saving ? '저장 중...' : '저장'}
        </button>
      </div>
    </div>
  );
}
