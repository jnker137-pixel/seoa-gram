import React, { useRef, useState } from 'react';
import type { ApiProvider, Character, CharacterCardV2 } from '../types';

interface CharacterEditorProps {
  character: Character | null; // null = create new
  onSave: (char: Character) => void;
  onDelete?: (id: string) => void;
  onClearMessages?: () => void;
  onClose: () => void;
}

const API_PROVIDERS: ApiProvider[] = ['claude', 'gemini', 'deepseek', 'grok', 'openai'];

const DEFAULT_MODELS: Record<ApiProvider, string> = {
  'seoa-worker': 'seoa',
  claude: 'claude-sonnet-4-6',
  gemini: 'gemini-3-flash-preview',
  deepseek: 'deepseek-v4-flash',
  grok: 'grok-4.3',
  openai: 'gpt-5.4-mini',
};

const MODEL_OPTIONS: Record<string, string[]> = {
  claude: ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001', 'claude-opus-4-5-20251101'],
  gemini: ['gemini-3-flash-preview', 'gemini-2.5-flash', 'gemini-2.5-pro'],
  deepseek: ['deepseek-v4-flash', 'deepseek-v4-pro'],
  grok: ['grok-4.3', 'grok-4.20'],
  openai: ['gpt-5.5', 'gpt-5.4-mini', 'gpt-5.4-nano'],
};

const ACCENT_COLORS = [
  '#7c3aed', // purple
  '#db2777', // pink
  '#059669', // green
  '#d97706', // amber
  '#2563eb', // blue
  '#dc2626', // red
  '#0891b2', // cyan
  '#65a30d', // lime
];

function generateId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    + '_' + Date.now().toString(36);
}

function parseCharacterCard(json: CharacterCardV2): Partial<Character> {
  // V2 format
  if (json.spec === 'chara_card_v2' && json.data) {
    const d = json.data;
    const parts = [
      d.description,
      d.personality && `성격: ${d.personality}`,
      d.scenario && `상황: ${d.scenario}`,
      d.mes_example && `대화 예시:\n${d.mes_example}`,
    ].filter(Boolean);
    return {
      name: d.name ?? '',
      system_prompt: d.system_prompt || parts.join('\n\n'),
      avatar_url: d.avatar ?? null,
    };
  }

  // V1 / generic format
  const parts = [
    json.description,
    json.personality && `성격: ${json.personality}`,
    json.scenario && `상황: ${json.scenario}`,
  ].filter(Boolean);
  return {
    name: json.name ?? '',
    system_prompt: json.system_prompt || parts.join('\n\n'),
  };
}

export default function CharacterEditor({
  character,
  onSave,
  onDelete,
  onClearMessages,
  onClose,
}: CharacterEditorProps) {
  const isNew = !character;
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [form, setForm] = useState<Omit<Character, 'id' | 'created_at'>>({
    name: character?.name ?? '',
    system_prompt: character?.system_prompt ?? '',
    api_provider: character?.api_provider ?? 'claude',
    model: character?.model ?? DEFAULT_MODELS['claude'],
    avatar_url: character?.avatar_url ?? null,
    color: character?.color ?? ACCENT_COLORS[0],
    tools_enabled: character?.tools_enabled ?? false,
  });
  const [idInput, setIdInput] = useState(character?.id ?? '');
  const [importError, setImportError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const handleProviderChange = (p: ApiProvider) => {
    set('api_provider', p);
    set('model', DEFAULT_MODELS[p]);
    if (p === 'seoa-worker') {
      set('tools_enabled', true);
    }
  };

  // PNG 파일에서 "chara" tEXt 청크 추출 (SillyTavern/PocketRisu 형식)
  function extractCharaFromPng(buffer: ArrayBuffer): string | null {
    const view = new DataView(buffer);
    let offset = 8; // PNG signature skip
    while (offset < buffer.byteLength - 12) {
      const length = view.getUint32(offset, false);
      offset += 4;
      const type = String.fromCharCode(
        view.getUint8(offset), view.getUint8(offset + 1),
        view.getUint8(offset + 2), view.getUint8(offset + 3)
      );
      offset += 4;
      if (type === 'tEXt') {
        let keyEnd = offset;
        while (keyEnd < offset + length && view.getUint8(keyEnd) !== 0) keyEnd++;
        const keyword = new TextDecoder().decode(new Uint8Array(buffer, offset, keyEnd - offset));
        if (keyword === 'chara') {
          const text = new TextDecoder().decode(new Uint8Array(buffer, keyEnd + 1, length - (keyEnd - offset) - 1));
          return text;
        }
      }
      offset += length + 4; // data + CRC
    }
    return null;
  }

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportError(null);

    if (file.type === 'image/png' || file.name.endsWith('.png')) {
      // PNG 캐릭터카드: tEXt 청크에서 JSON 추출 + 이미지 자체를 아바타로
      const reader = new FileReader();
      reader.onload = (ev) => {
        const buffer = ev.target?.result as ArrayBuffer;
        const base64Chara = extractCharaFromPng(buffer);
        if (!base64Chara) {
          setImportError('이 PNG에는 캐릭터카드 데이터가 없어요.');
          return;
        }
        try {
          const json = JSON.parse(atob(base64Chara)) as CharacterCardV2;
          const parsed = parseCharacterCard(json);
          // PNG 자체를 아바타로
          const blob = new Blob([buffer], { type: 'image/png' });
          const imgReader = new FileReader();
          imgReader.onload = (ie) => {
            setForm((f) => ({ ...f, ...parsed, avatar_url: ie.target?.result as string }));
          };
          imgReader.readAsDataURL(blob);
          if (parsed.name && !idInput) setIdInput(generateId(parsed.name));
        } catch {
          setImportError('캐릭터카드 JSON 파싱에 실패했어요.');
        }
      };
      reader.readAsArrayBuffer(file);
    } else {
      // JSON 파일
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const json = JSON.parse(ev.target?.result as string) as CharacterCardV2;
          const parsed = parseCharacterCard(json);
          if (parsed.name) setForm((f) => ({ ...f, ...parsed }));
          if (parsed.name && !idInput) setIdInput(generateId(parsed.name));
        } catch {
          setImportError('JSON 파싱에 실패했어요. 올바른 캐릭터카드 파일인지 확인해주세요.');
        }
      };
      reader.readAsText(file);
    }
    e.target.value = '';
  };

  const handleSave = async () => {
    if (!form.name.trim()) return;
    setSaving(true);
    const id = character?.id ?? (idInput.trim() || generateId(form.name));
    try {
      await onSave({ ...form, id });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = () => {
    if (!character) return;
    if (!confirm(`"${character.name}" 캐릭터를 삭제할까요? 대화 기록도 함께 삭제됩니다.`)) return;
    onDelete?.(character.id);
  };

  const handleClearMessages = () => {
    if (!character) return;
    if (!confirm(`"${character.name}"와의 대화를 모두 초기화할까요?`)) return;
    onClearMessages?.();
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-lg shadow-2xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-base font-semibold text-gray-900">
            {isNew ? '새 캐릭터 추가' : '캐릭터 수정'}
          </h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Form */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          {/* Import button */}
          <div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,.png,image/png"
              onChange={handleImport}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border-2 border-dashed border-gray-300 hover:border-gray-400 text-sm text-gray-500 hover:text-gray-700 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
              </svg>
              캐릭터카드 임포트 — PNG / JSON (SillyTavern · PocketRisu)
            </button>
            {importError && (
              <p className="text-xs text-red-500 mt-1">{importError}</p>
            )}
          </div>

          {/* Name */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5">
              이름 <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder="서아, 수학 선생님, ..."
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-xl focus:outline-none focus:border-gray-400 transition-colors"
            />
          </div>

          {/* ID (new only) */}
          {isNew && (
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1.5">
                ID{' '}
                <span className="text-gray-400 font-normal">(영소문자·숫자·_ 권장, 비워두면 자동생성)</span>
              </label>
              <input
                type="text"
                value={idInput}
                onChange={(e) => setIdInput(e.target.value)}
                placeholder="seoa, math_teacher, ..."
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-xl focus:outline-none focus:border-gray-400 transition-colors font-mono"
              />
            </div>
          )}

          {/* System prompt */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5">
              시스템 프롬프트 (캐릭터 설정)
            </label>
            <textarea
              value={form.system_prompt}
              onChange={(e) => set('system_prompt', e.target.value)}
              placeholder="너는 ___야. ..."
              rows={6}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-xl focus:outline-none focus:border-gray-400 transition-colors resize-none leading-relaxed"
            />
          </div>

          {/* API Provider */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5">API 제공자</label>
            <div className="flex gap-2">
              {API_PROVIDERS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => handleProviderChange(p)}
                  className={`flex-1 py-2 rounded-xl text-xs font-medium transition-colors ${
                    form.api_provider === p
                      ? 'bg-gray-900 text-white'
                      : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  }`}
                >
                  {({'claude':'Claude','gemini':'Gemini','deepseek':'DeepSeek','grok':'Grok','openai':'OpenAI'} as Record<string,string>)[p] ?? p}
                </button>
              ))}
            </div>
            <p className="text-xs text-gray-400 mt-1.5">
              Claude · Gemini는 웹 검색 자동 포함. DeepSeek · Grok · OpenAI는 API 키 등록 후 사용 가능.
            </p>
          </div>

          {/* Model */}
          {form.api_provider !== 'seoa-worker' && (
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1.5">모델</label>
              <select
                value={form.model}
                onChange={(e) => set('model', e.target.value)}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-xl focus:outline-none focus:border-gray-400 transition-colors bg-white"
              >
                {(MODEL_OPTIONS[form.api_provider] ?? []).map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>
          )}

          {/* Avatar image */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5">아바타 이미지</label>
            <div className="flex items-center gap-3">
              {/* Preview */}
              <div
                className="w-16 h-16 rounded-full flex-shrink-0 flex items-center justify-center text-white font-bold text-xl overflow-hidden"
                style={{ backgroundColor: form.color }}
              >
                {form.avatar_url ? (
                  <img src={form.avatar_url} alt="" className="w-full h-full object-cover" />
                ) : (
                  <span>{form.name.slice(0, 1) || '?'}</span>
                )}
              </div>
              <div className="flex-1 space-y-2">
                <button
                  type="button"
                  onClick={() => {
                    const input = document.createElement('input');
                    input.type = 'file';
                    input.accept = 'image/*';
                    input.onchange = (e) => {
                      const file = (e.target as HTMLInputElement).files?.[0];
                      if (!file) return;
                      const reader = new FileReader();
                      reader.onload = (ev) => {
                        const img = new Image();
                        img.onload = () => {
                          const MAX = 1024;
                          const scale = Math.min(1, MAX / Math.max(img.width, img.height));
                          const canvas = document.createElement('canvas');
                          canvas.width = img.width * scale;
                          canvas.height = img.height * scale;
                          canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
                          set('avatar_url', canvas.toDataURL('image/jpeg', 0.99));
                        };
                        img.src = ev.target?.result as string;
                      };
                      reader.readAsDataURL(file);
                    };
                    input.click();
                  }}
                  className="w-full py-2 px-3 rounded-xl border border-gray-200 hover:border-gray-400 text-xs text-gray-600 hover:text-gray-900 transition-colors text-left"
                >
                  📁 이미지 파일 선택
                </button>
                <input
                  type="url"
                  value={form.avatar_url?.startsWith('data:') ? '' : (form.avatar_url ?? '')}
                  onChange={(e) => set('avatar_url', e.target.value || null)}
                  placeholder="또는 이미지 URL 입력 (https://...)"
                  className="w-full px-3 py-1.5 text-xs border border-gray-200 rounded-xl focus:outline-none focus:border-gray-400 transition-colors"
                />
                {form.avatar_url && (
                  <button
                    type="button"
                    onClick={() => set('avatar_url', null)}
                    className="text-xs text-red-400 hover:text-red-600"
                  >
                    이미지 제거
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Color picker */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-2">테마 색상</label>
            <div className="flex gap-2 flex-wrap">
              {ACCENT_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => set('color', c)}
                  className={`w-8 h-8 rounded-full transition-transform ${
                    form.color === c ? 'scale-125 ring-2 ring-offset-2 ring-gray-400' : 'hover:scale-110'
                  }`}
                  style={{ backgroundColor: c }}
                  title={c}
                />
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-100 flex gap-3">
          {!isNew && (
            <div className="flex gap-1.5">
              {onDelete && (
                <button
                  type="button"
                  onClick={handleDelete}
                  title="캐릭터 삭제"
                  className="px-3 py-2 rounded-xl text-sm font-medium text-red-500 hover:bg-red-50 transition-colors"
                >
                  삭제
                </button>
              )}
              {onClearMessages && character?.id !== 'seoa' && (
                <button
                  type="button"
                  onClick={handleClearMessages}
                  title="대화 내용만 초기화"
                  className="px-3 py-2 rounded-xl text-sm font-medium text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
                >
                  대화 초기화
                </button>
              )}
            </div>
          )}
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-sm font-medium text-gray-600 hover:bg-gray-100 transition-colors"
          >
            취소
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!form.name.trim() || saving}
            className="px-5 py-2 rounded-xl text-sm font-medium bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {saving ? '저장 중...' : isNew ? '추가' : '저장'}
          </button>
        </div>
      </div>
    </div>
  );
}
