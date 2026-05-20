-- 1. pgvector 활성화
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. episodic_memories 테이블
CREATE TABLE IF NOT EXISTS episodic_memories (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  character_id  text NOT NULL,
  title         text NOT NULL,
  summary       text NOT NULL,
  emotional_weight text CHECK (emotional_weight IN ('high', 'medium', 'low')),
  tags          text[] DEFAULT '{}',
  embedding     vector(768),
  created_at    timestamptz DEFAULT now(),
  last_recalled_at timestamptz
);

-- 3. 인덱스
CREATE INDEX IF NOT EXISTS episodic_memories_character_idx
  ON episodic_memories (character_id);

CREATE INDEX IF NOT EXISTS episodic_memories_embedding_idx
  ON episodic_memories USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 50);

-- 4. Worker에서 호출할 벡터 검색 RPC
CREATE OR REPLACE FUNCTION match_episodic_memories(
  query_embedding  vector(768),
  character_filter text,
  match_count      int DEFAULT 3,
  min_similarity   float DEFAULT 0.5
)
RETURNS TABLE (
  id               uuid,
  title            text,
  summary          text,
  emotional_weight text,
  tags             text[],
  similarity       float
)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT
    em.id,
    em.title,
    em.summary,
    em.emotional_weight,
    em.tags,
    1 - (em.embedding <=> query_embedding) AS similarity
  FROM episodic_memories em
  WHERE em.character_id = character_filter
    AND em.embedding IS NOT NULL
    AND 1 - (em.embedding <=> query_embedding) >= min_similarity
  ORDER BY em.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- 5. anon 역할 권한
ALTER TABLE episodic_memories ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_all" ON episodic_memories FOR ALL TO anon USING (true) WITH CHECK (true);
GRANT EXECUTE ON FUNCTION match_episodic_memories TO anon;
