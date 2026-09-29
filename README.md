# Jeen AI KYB Readiness Agent

A merchant onboarding (KYB) review assistant. An analyst opens a case, uploads the
applicant's documents, and a Langflow multi-agent workflow checks them against policy:

- **Coordinator** plans the review, dispatches specialists, asks the analyst for
  approval or missing information, and writes the final findings.
- **Entity**, **Ownership**, **Policy** and **Public Research** specialists each
  return cited findings, evidence gaps and conflicts.
- **Document Ingestion** parses uploads into searchable, citable chunks.

PostgreSQL is the source of truth for cases, runs, citations and checkpoints. A
Next.js app provides the analyst UI and the API that starts Langflow runs. A human
makes the final approve/reject decision on every case.

## Prerequisites

- Node.js 22 or later
- Docker with Docker Compose (runs PostgreSQL with pgvector)
- A running Langflow server (default `http://localhost:7860`)
- API keys for OpenAI and Cohere

## Setup

### 1. Install and Start the Database

```sh
npm install
npm run db:up
npm run db:migrate
npm run db:seed
```

`db:seed` loads the reviewed demo policy rules used by the Policy specialist.

### 2. Configure the Environment

```sh
cp .env.example .env.local
```

Fill in the keys in `.env.local`. The Langflow flow and node IDs are filled in after
step 3.

### 3. Set Up Langflow

1. Import every flow in `langflow/Flows/`: Coordinator, Entity, Ownership, Policy,
   KYB Public Research V3, Scoped Policy Semantic Search V3 and Document Ingestion.
   Keep the flow names unchanged: the Coordinator calls the specialists by name.
   The Policy flow calls Scoped Policy Semantic Search V3 by its flow ID
   (`5bce1bed-4022-4602-a2f7-2a570010da11`). If the imported flow gets a different
   ID, update `SEARCH_FLOW_ID` in the Policy flow's Scoped Policy Semantic Search
   V3 Tool component.
2. In Langflow, add these global variables:
   - `DATABASE_URL`: the same database as above. If Langflow runs in Docker, use
     `postgresql://jeen:jeen_dev@host.docker.internal:5432/jeen`.
   - `OPENAI_API_KEY` and `COHERE_API_KEY`.
   - `TINY_FISH_KEY` (optional): enables approved public web research.
3. Create a Langflow API key and copy it into `LANGFLOW_API_KEY`.
4. Copy the Coordinator and Document Ingestion flow IDs into
   `LANGFLOW_COORDINATOR_FLOW_ID` and `LANGFLOW_INGESTION_FLOW_ID`. The ingestion
   node IDs in `.env.example` already match the exported flow.

The exported flows are what runs. `langflow/components/` and `langflow/prompts/` hold
readable copies of the custom component code and agent prompts, used by the tests.

### 4. Add Policy Embeddings

```sh
npm run policy:embed-approved -- --all
npm run assistant:embeddings:backfill
```

### 5. Run the App

```sh
npm run dev
```

Open http://localhost:3000.

## Trying a Case

1. Create a case and choose a jurisdiction, business type and product.
2. Upload the applicant documents. Ready-made packets are in `demo/`:
   - `demo/Helmsgate/`: a fictional UK marketplace company (five documents).
   - `demo/Morgan Stanley/`: a packet built from public filings (three documents).

   To generate more packets (fictional companies with planted gaps and conflicts)
   into `output/pdf/`:

   ```sh
   pip install reportlab
   python3 scripts/generate-kyb-test-documents.py
   ```
3. When every upload shows as ready, start the analysis.
4. Follow the specialists on the case page. Answer any checkpoint the Coordinator
   raises: approving a web search, supplying missing information, or accepting
   research results.
5. When the case is ready for review, read the cited findings and record the final
   approve or reject decision with a rationale.

The case assistant answers questions about the case from its pinned evidence, with
citations. It cannot change the case.

## Tests

```sh
npm run verify
npm run db:verify
```

`npm run verify` runs the type check and unit tests. The `db:verify*` scripts in
`package.json` check database rules and need the database running.

## Project Layout

- `app/`, `components/`, `lib/`: Next.js analyst UI and API route
- `src/api/`: shared API handler (also runs standalone with `npm run api`)
- `src/contracts/`: typed contracts shared by the API and Langflow
- `langflow/components/`, `langflow/prompts/`: Langflow custom components and prompts
- `db/`: migrations, seeds and database tests
- `fixtures/`: sample cases and policies
- `scripts/`: document generator, embedding and verification scripts
- `tests/`: unit tests

## Known Limits

- This is a local demo. The API accepts client-supplied analyst IDs and has no
  production authentication or authorization.
- Findings support an analyst's review. They are not legal or licensing conclusions.
