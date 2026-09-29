BEGIN;

CREATE TABLE assistant_document_embeddings (
  chunk_id uuid PRIMARY KEY REFERENCES document_chunks(id) ON DELETE CASCADE,
  embedding vector(1024) NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE assistant_policy_embeddings (
  chunk_id uuid PRIMARY KEY REFERENCES policy_chunks(id) ON DELETE CASCADE,
  embedding vector(1024) NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO assistant_document_embeddings (chunk_id, embedding, provider, model)
SELECT chunk.id, chunk.embedding::vector(1024), chunk.embedding_provider, chunk.embedding_model
FROM document_chunks chunk
WHERE chunk.embedding IS NOT NULL
  AND vector_dims(chunk.embedding) = 1024
  AND chunk.embedding_provider = 'cohere'
  AND chunk.embedding_model = 'embed-english-v3.0'
ON CONFLICT (chunk_id) DO NOTHING;

COMMIT;
