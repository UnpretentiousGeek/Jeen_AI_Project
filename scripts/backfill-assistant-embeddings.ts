import { Pool, type PoolClient } from "pg";

import { CohereRetrievalClient } from "../src/api/cohere-retrieval.ts";

const EMBEDDING_PROVIDER = "cohere";
const EMBEDDING_MODEL = "embed-english-v3.0";
const EMBEDDING_DIMENSIONS = 1024;
const BATCH_SIZE = 96;

type ChunkTable = "document_chunks" | "policy_chunks";

interface PendingChunk {
  id: string;
  content: string;
  table_name: ChunkTable;
}

function vectorLiteral(vector: number[]): string {
  if (vector.length !== EMBEDDING_DIMENSIONS || !vector.every(Number.isFinite)) {
    throw new Error("Cohere returned an invalid embedding vector");
  }
  return `[${vector.join(",")}]`;
}

async function selectBatch(client: PoolClient): Promise<PendingChunk[]> {
  const result = await client.query<PendingChunk>(
    `WITH active_document_chunks AS (
       SELECT DISTINCT chunk.id, chunk.content, 'document_chunks'::text AS table_name
       FROM onboarding_cases onboarding_case
       JOIN analysis_runs run
         ON run.id = onboarding_case.active_analysis_run_id
        AND run.case_id = onboarding_case.id
       JOIN analysis_run_documents snapshot
         ON snapshot.analysis_run_id = run.id
        AND snapshot.case_id = run.case_id
       JOIN document_chunks chunk
         ON chunk.document_id = snapshot.document_id
        AND chunk.case_id = snapshot.case_id
       LEFT JOIN assistant_document_embeddings stored
         ON stored.chunk_id = chunk.id
       WHERE onboarding_case.archived_at IS NULL
         AND (
           stored.chunk_id IS NULL
           OR stored.provider IS DISTINCT FROM $2
           OR stored.model IS DISTINCT FROM $3
           OR vector_dims(stored.embedding) <> $1
         )
     ), active_policy_chunks AS (
       SELECT DISTINCT chunk.id, chunk.content, 'policy_chunks'::text AS table_name
       FROM onboarding_cases onboarding_case
       JOIN analysis_runs run
         ON run.id = onboarding_case.active_analysis_run_id
        AND run.case_id = onboarding_case.id
       JOIN analysis_run_policy_versions snapshot
         ON snapshot.analysis_run_id = run.id
       JOIN policy_chunks chunk
         ON chunk.policy_version_id = snapshot.policy_version_id
       LEFT JOIN assistant_policy_embeddings stored
         ON stored.chunk_id = chunk.id
       WHERE onboarding_case.archived_at IS NULL
         AND ('*' = ANY(chunk.jurisdictions)
             OR run.case_snapshot #>> '{applicant,jurisdiction}' = ANY(chunk.jurisdictions))
         AND ('*' = ANY(chunk.products)
             OR run.case_snapshot #>> '{applicant,product}' = ANY(chunk.products))
         AND ('*' = ANY(chunk.business_types)
             OR run.case_snapshot #>> '{applicant,business_type}' = ANY(chunk.business_types))
         AND (
           stored.chunk_id IS NULL
           OR stored.provider IS DISTINCT FROM $2
           OR stored.model IS DISTINCT FROM $3
           OR vector_dims(stored.embedding) <> $1
         )
     )
     SELECT id::text, content, table_name
     FROM (
       SELECT * FROM active_document_chunks
       UNION ALL
       SELECT * FROM active_policy_chunks
     ) pending
     ORDER BY table_name, id
     LIMIT $4`,
    [EMBEDDING_DIMENSIONS, EMBEDDING_PROVIDER, EMBEDDING_MODEL, BATCH_SIZE],
  );
  return result.rows;
}

async function updateChunk(
  client: PoolClient,
  chunk: PendingChunk,
  embedding: number[],
): Promise<void> {
  const table = chunk.table_name === "document_chunks"
    ? "assistant_document_embeddings"
    : "assistant_policy_embeddings";
  await client.query(
    `INSERT INTO ${table} (chunk_id, embedding, provider, model)
     VALUES ($1::uuid, $2::vector, $3, $4)
     ON CONFLICT (chunk_id) DO UPDATE
     SET embedding = EXCLUDED.embedding,
         provider = EXCLUDED.provider,
         model = EXCLUDED.model,
         created_at = clock_timestamp()`,
    [chunk.id, vectorLiteral(embedding), EMBEDDING_PROVIDER, EMBEDDING_MODEL],
  );
}

async function copyCompatibleEmbeddings(client: PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO assistant_document_embeddings (chunk_id, embedding, provider, model)
     SELECT DISTINCT chunk.id, chunk.embedding, chunk.embedding_provider, chunk.embedding_model
     FROM onboarding_cases onboarding_case
     JOIN analysis_runs run
       ON run.id = onboarding_case.active_analysis_run_id
      AND run.case_id = onboarding_case.id
     JOIN analysis_run_documents snapshot
       ON snapshot.analysis_run_id = run.id
      AND snapshot.case_id = run.case_id
     JOIN document_chunks chunk
       ON chunk.document_id = snapshot.document_id
      AND chunk.case_id = snapshot.case_id
     WHERE onboarding_case.archived_at IS NULL
       AND chunk.embedding IS NOT NULL
       AND vector_dims(chunk.embedding) = $1
       AND chunk.embedding_provider = $2
       AND chunk.embedding_model = $3
     ON CONFLICT (chunk_id) DO NOTHING`,
    [EMBEDDING_DIMENSIONS, EMBEDDING_PROVIDER, EMBEDDING_MODEL],
  );
}

async function backfill(): Promise<void> {
  const apiKey = process.env.COHERE_API_KEY;
  if (!apiKey) throw new Error("COHERE_API_KEY is required");

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL ?? "postgresql://jeen:jeen_dev@localhost:5432/jeen",
    max: 2,
  });
  const cohere = new CohereRetrievalClient(apiKey);
  let completed = 0;

  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await copyCompatibleEmbeddings(client);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    while (true) {
      const selectionClient = await pool.connect();
      let batch: PendingChunk[];
      try {
        batch = await selectBatch(selectionClient);
      } finally {
        selectionClient.release();
      }
      if (batch.length === 0) break;

      const embeddings = await cohere.embedDocuments(batch.map((chunk) => chunk.content));
      if (embeddings.length !== batch.length) {
        throw new Error("Cohere returned an unexpected number of embeddings");
      }

      const writeClient = await pool.connect();
      try {
        await writeClient.query("BEGIN");
        for (const [index, chunk] of batch.entries()) {
          await updateChunk(writeClient, chunk, embeddings[index]!);
        }
        await writeClient.query("COMMIT");
        completed += batch.length;
        console.log(`Embedded ${completed} active-run chunks.`);
      } catch (error) {
        await writeClient.query("ROLLBACK");
        throw error;
      } finally {
        writeClient.release();
      }
    }
    console.log(`Assistant embedding backfill complete (${completed} chunks).`);
  } finally {
    await pool.end();
  }
}

backfill().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(`Assistant embedding backfill failed: ${message}`);
  process.exitCode = 1;
});
