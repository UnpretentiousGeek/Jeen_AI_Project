BEGIN;

ALTER TABLE external_web_evidence
  DROP CONSTRAINT IF EXISTS external_web_evidence_retrieval_method_check;

ALTER TABLE external_web_evidence
  ADD CONSTRAINT external_web_evidence_retrieval_method_check
  CHECK (retrieval_method IN ('firecrawl_search', 'tinyfish_search', 'tinyfish_fetch'));

COMMIT;
