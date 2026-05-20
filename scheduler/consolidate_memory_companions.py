"""
비서아 캐릭터 장기기억 자동 정리 (매일 23:45 KST)
- character_context: 관계/감정/특성 요약 (기존 슬롯 방식 유지)
- episodic_memories: 기억할 가치 있는 에피소드만 선택 추출 → Gemini 임베딩 → DB 저장
"""
import os, json, re, requests
from datetime import datetime, timedelta, timezone

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SUPABASE_KEY = os.environ["SUPABASE_KEY"]
ANTHROPIC_API_KEY = os.environ["ANTHROPIC_API_KEY"]
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")


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
        f"&order=created_at&select=role,content,created_at",
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


# ── 1. character_context 업데이트 (슬롯 요약) ─────────────────────────────────

def update_context_with_haiku(character_name: str, logs: list, existing_ctx: dict) -> dict:
    conversation = "\n".join(
        f"[{m['role']}] {m['content'][:200]}" for m in logs
    )
    existing = (
        f"현재 relationship_summary: {existing_ctx.get('relationship_summary', '없음')}\n"
        f"현재 memorable_moments: {existing_ctx.get('memorable_moments', '없음')}\n"
        f"현재 mood: {existing_ctx.get('mood', '없음')}"
    )

    prompt = f"""{character_name}와 성민의 최근 대화야.

{existing}

최근 대화:
{conversation[:4000]}

아래 3가지를 JSON으로 업데이트해줘. 기존 내용 있으면 합쳐서 업데이트.

핵심 원칙: "대화 재현" 말고 "상태/특성"으로 증류.
나쁜 예: "5월 20일에 AI 얘기했음"
좋은 예: "AI 의식·실존 주제 깊이 파고드는 성향"

{{
  "relationship_summary": "{character_name} 1인칭 시점, 성민과의 관계 특성 (2-3문장)",
  "memorable_moments": "기억할 에피소드 최대 3개 (날짜·상태 위주)",
  "mood": "{character_name}의 현재 감정 상태 (1문장)"
}}

JSON만."""

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


# ── 2. 에피소드 선택 추출 + 임베딩 저장 ──────────────────────────────────────

def extract_episodes(character_name: str, logs: list) -> list:
    """3개월 뒤에도 기억할 에피소드만 선택 추출. 없으면 []."""
    if len(logs) < 5:
        return []

    conversation = "\n".join(
        f"[{m.get('created_at','')[:10]} {m['role']}] {m['content'][:200]}" for m in logs[-40:]
    )

    prompt = f"""{character_name}와 성민의 대화야. 3개월 뒤에도 기억할 만한 에피소드가 있으면 JSON 배열로 줘. 없으면 반드시 [] 반환.

기억할 것:
- 감정적으로 강했던 순간
- 성민의 가치관·관계 변화가 드러난 순간
- 구체적인 결정·사건·고백

절대 기억 안 하는 것:
- 수치·시세 조회, 단순 정보 요청
- "응" "ㅋㅋ" 류 일상 잡담
- 기술 버그 수정 논의

대화:
{conversation}

형식:
[{{"title": "10자 이내 제목", "summary": "1-2문장 설명", "emotional_weight": "high/medium/low", "tags": ["태그1", "태그2"]}}]

없으면 []. JSON만."""

    res = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={
            "x-api-key": ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        json={
            "model": "claude-haiku-4-5-20251001",
            "max_tokens": 600,
            "messages": [{"role": "user", "content": prompt}],
        }
    )
    text = res.json()["content"][0]["text"].strip()
    m = re.search(r'\[[\s\S]*\]', text)
    if not m:
        return []
    try:
        episodes = json.loads(m.group(0))
        return episodes if isinstance(episodes, list) else []
    except Exception:
        return []


def embed_text(text: str) -> list | None:
    """Gemini text-embedding-004 (768차원)"""
    if not GEMINI_API_KEY:
        return None
    res = requests.post(
        f"https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key={GEMINI_API_KEY}",
        headers={"Content-Type": "application/json"},
        json={"model": "models/text-embedding-004", "content": {"parts": [{"text": text}]}}
    )
    if res.status_code != 200:
        print(f"  임베딩 실패: {res.status_code}")
        return None
    return res.json()["embedding"]["values"]


def save_episodes(character_id: str, episodes: list):
    for ep in episodes:
        embed_input = f"{ep['title']} {ep['summary']}"
        embedding = embed_text(embed_input)

        payload = {
            "character_id": character_id,
            "title": ep["title"],
            "summary": ep["summary"],
            "emotional_weight": ep.get("emotional_weight", "medium"),
            "tags": ep.get("tags", []),
        }
        if embedding:
            payload["embedding"] = embedding

        res = requests.post(
            f"{SUPABASE_URL}/rest/v1/episodic_memories",
            headers=supabase_headers(),
            json=payload
        )
        if res.status_code in (200, 201):
            print(f"    에피소드 저장: [{ep['emotional_weight']}] {ep['title']}")
        else:
            print(f"    에피소드 저장 실패: {res.status_code} {res.text[:80]}")


# ── main ──────────────────────────────────────────────────────────────────────

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

        print(f"\n[{name}] {len(logs)}개 대화 처리 중...")

        # 1. character_context 업데이트 (슬롯 요약)
        existing = fetch_existing_context(cid)
        ctx = update_context_with_haiku(name, logs, existing)
        upsert_context(cid, ctx)
        print(f"  context 업데이트: {ctx.get('mood', '')}")

        # 2. 에피소드 선택 추출 → 임베딩 저장
        episodes = extract_episodes(name, logs)
        if episodes:
            print(f"  {len(episodes)}개 에피소드 발견, 저장 중...")
            save_episodes(cid, episodes)
        else:
            print(f"  기억할 에피소드 없음, 스킵")


if __name__ == "__main__":
    main()
