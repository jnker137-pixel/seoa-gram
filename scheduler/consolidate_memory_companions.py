"""
비서아 캐릭터 장기기억 자동 정리
- conversation_log에서 최근 3일치 대화 읽기
- Haiku로 요약 → character_context upsert
"""
import os, json, requests
from datetime import datetime, timedelta, timezone

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SUPABASE_KEY = os.environ["SUPABASE_KEY"]
ANTHROPIC_API_KEY = os.environ["ANTHROPIC_API_KEY"]

def supabase_headers():
    return {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
    }

def fetch_characters():
    res = requests.get(
        f"{SUPABASE_URL}/rest/v1/characters?select=id,name&id=neq.seoa",
        headers=supabase_headers()
    )
    return res.json()

def fetch_recent_logs(character_id: str, days: int = 3):
    since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    res = requests.get(
        f"{SUPABASE_URL}/rest/v1/conversation_log"
        f"?character_id=eq.{character_id}&created_at=gte.{since}"
        f"&order=created_at&select=role,content",
        headers=supabase_headers()
    )
    return res.json()

def fetch_existing_context(character_id: str):
    res = requests.get(
        f"{SUPABASE_URL}/rest/v1/character_context?character_id=eq.{character_id}&limit=1",
        headers=supabase_headers()
    )
    rows = res.json()
    return rows[0] if rows else {}

def summarize_with_haiku(character_name: str, logs: list, existing_ctx: dict) -> dict:
    conversation = "\n".join(
        f"[{m['role']}] {m['content']}" for m in logs
    )
    existing = (
        f"현재 relationship_summary: {existing_ctx.get('relationship_summary', '없음')}\n"
        f"현재 memorable_moments: {existing_ctx.get('memorable_moments', '없음')}\n"
        f"현재 mood: {existing_ctx.get('mood', '없음')}"
    )

    prompt = f"""다음은 {character_name}와 성민의 최근 대화야.

{existing}

최근 대화:
{conversation[:4000]}

위 대화를 바탕으로 아래 3가지를 JSON으로 업데이트해줘. 기존 내용이 있으면 합쳐서 업데이트.

중요: 기억은 "대화 재현"이 아니라 "상태/특성"으로 증류해야 해.
나쁜 예: "5월 20일에 주식 얘기했음"
좋은 예: "주식 수익에 예민하고 통제감을 중시함"

{{
  "relationship_summary": "{character_name}이 성민을 어떻게 바라보는지, 둘의 관계 특성 요약 (2-3문장, {character_name} 1인칭 시점)",
  "memorable_moments": "기억할 만한 구체적 에피소드 (날짜 포함, 최대 3개, 상태/특성 위주)",
  "mood": "{character_name}의 현재 감정 상태 (1문장)"
}}

JSON만 응답."""

    res = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={
            "x-api-key": ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        json={
            "model": "claude-haiku-4-5-20251001",
            "max_tokens": 500,
            "messages": [{"role": "user", "content": prompt}],
        }
    )
    text = res.json()["content"][0]["text"].strip()
    import re
    m = re.search(r'\{[\s\S]*\}', text)
    if not m:
        raise ValueError(f"JSON 파싱 실패: {text}")
    return json.loads(m.group(0))

def upsert_context(character_id: str, ctx: dict):
    payload = {
        "character_id": character_id,
        "relationship_summary": ctx.get("relationship_summary"),
        "memorable_moments": ctx.get("memorable_moments"),
        "mood": ctx.get("mood"),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    res = requests.post(
        f"{SUPABASE_URL}/rest/v1/character_context",
        headers={**supabase_headers(), "Prefer": "resolution=merge-duplicates"},
        json=payload
    )
    if res.status_code not in (200, 201):
        raise RuntimeError(f"upsert 실패: {res.status_code} {res.text}")

def main():
    characters = fetch_characters()
    if not isinstance(characters, list):
        print(f"캐릭터 로드 실패: {characters}")
        return

    print(f"처리할 캐릭터: {[c['id'] for c in characters]}")

    for char in characters:
        cid = char["id"]
        name = char["name"]
        logs = fetch_recent_logs(cid)

        if not isinstance(logs, list) or len(logs) < 3:
            print(f"[{name}] 대화 없음 ({len(logs) if isinstance(logs, list) else '오류'}개), 스킵")
            continue

        print(f"[{name}] {len(logs)}개 대화 요약 중...")
        existing = fetch_existing_context(cid)
        ctx = summarize_with_haiku(name, logs, existing)
        upsert_context(cid, ctx)
        print(f"[{name}] 기억 업데이트 완료: {ctx.get('mood', '')}")

if __name__ == "__main__":
    main()
