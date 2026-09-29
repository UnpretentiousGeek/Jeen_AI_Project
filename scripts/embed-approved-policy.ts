import { Pool } from "pg";

import { CohereRetrievalClient } from "../src/api/cohere-retrieval.ts";

const code = process.argv[2]?.trim();
if (!code) throw new Error("Provide an approved policy rule code or --all");
const apiKey = process.env.COHERE_API_KEY;
if (!apiKey) throw new Error("COHERE_API_KEY is required");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? "postgresql://jeen:jeen_dev@localhost:5432/jeen",
  max: 2,
});

try {
  const result = await pool.query<{ id: string; code: string; content: string }>(
    `SELECT chunk.id::text, rule.code, chunk.content
     FROM policy_rule_scopes rule
     JOIN policy_chunks chunk ON chunk.id = rule.policy_chunk_id
     WHERE ($1 = '--all' OR rule.code = $1) AND rule.review_state = 'approved'
       AND (chunk.embedding IS NULL OR vector_dims(chunk.embedding) <> 1024)
     ORDER BY rule.code`,
    [code],
  );
  if (result.rows.length === 0) {
    const exists = await pool.query(
      "SELECT 1 FROM policy_rule_scopes WHERE ($1 = '--all' OR code = $1) AND review_state = 'approved'",
      [code],
    );
    if (exists.rowCount === 0) throw new Error(`No approved policy rule ${code}`);
    process.stdout.write(`${code}: embedding already present\n`);
  } else {
    const cohere = new CohereRetrievalClient(apiKey);
    const vectors = await cohere.embedDocuments(result.rows.map((row) => row.content));
    for (const [index, row] of result.rows.entries()) {
      const vector = vectors[index];
      if (!vector || vector.length !== 1024) throw new Error("Invalid policy embedding");
      const saved = await pool.query(
        `UPDATE policy_chunks chunk SET embedding = $2::vector
         WHERE chunk.id = $1::uuid AND chunk.content = $3
           AND EXISTS (
             SELECT 1 FROM policy_rule_scopes rule
             WHERE rule.policy_chunk_id = chunk.id AND rule.code = $4
               AND rule.review_state = 'approved'
           )`,
        [row.id, `[${vector.join(",")}]`, row.content, row.code],
      );
      if (saved.rowCount !== 1) throw new Error("Policy source changed during embedding");
    }
    process.stdout.write(`${code}: embedded ${result.rows.length} approved passage(s)\n`);
  }
} finally {
  await pool.end();
}
