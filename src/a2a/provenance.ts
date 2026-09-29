import { type AllowedAgent } from "./agent-card.js";
import {
  type SpecialistSpecialty,
  type SpecialistDispatchResult,
} from "./coordinator.js";

export interface A2AProvenanceRecord {
  analysisRunId: string;
  specialty: SpecialistSpecialty;
  allowedAgent: AllowedAgent;
  result: SpecialistDispatchResult;
  latencyMs: number;
  completedAt: string;
}

export interface A2AProvenanceStore {
  record(record: A2AProvenanceRecord): Promise<"stored" | "duplicate">;
  recordFailure(record: A2AProvenanceFailureRecord): Promise<"stored" | "duplicate">;
}

export interface A2AProvenanceFailureRecord {
  analysisRunId: string;
  specialty: SpecialistSpecialty;
  allowedAgent: AllowedAgent;
  taskId: string;
  contextId: string;
  messageId: string;
  correlationId: string;
  attempts: number;
  latencyMs: number;
  completedAt: string;
  errorCode: string;
  errorMessage: string;
}

export class InMemoryA2AProvenanceStore implements A2AProvenanceStore {
  private readonly records = new Map<string, {
    record: A2AProvenanceRecord;
    fingerprint: string;
  }>();
  private readonly failures = new Map<string, A2AProvenanceFailureRecord>();

  async record(record: A2AProvenanceRecord): Promise<"stored" | "duplicate"> {
    const key = `${record.analysisRunId}:${record.specialty}:${record.result.messageId}`;
    const fingerprint = JSON.stringify({
      analysisRunId: record.analysisRunId,
      specialty: record.specialty,
      allowedAgent: record.allowedAgent,
      result: record.result,
    });
    const existing = this.records.get(key);
    if (existing === undefined) {
      this.records.set(key, { record, fingerprint });
      return "stored";
    }
    if (existing.fingerprint === fingerprint) {
      return "duplicate";
    }
    throw new Error(`conflicting A2A provenance for ${key}`);
  }

  list(): A2AProvenanceRecord[] {
    return [...this.records.values()].map(({ record }) => structuredClone(record));
  }

  async recordFailure(record: A2AProvenanceFailureRecord): Promise<"stored" | "duplicate"> {
    const key = `${record.analysisRunId}:${record.specialty}:${record.messageId}`;
    const existing = this.failures.get(key);
    if (existing === undefined) {
      this.failures.set(key, structuredClone(record));
      return "stored";
    }
    if (JSON.stringify(existing) === JSON.stringify(record)) return "duplicate";
    throw new Error(`conflicting failed A2A provenance for ${key}`);
  }

  listFailures(): A2AProvenanceFailureRecord[] {
    return [...this.failures.values()].map((record) => structuredClone(record));
  }
}

export interface SqlQueryable {
  query(text: string, values: unknown[]): Promise<{
    rows: Array<Record<string, unknown>>;
  }>;
}

export class PostgresA2AProvenanceStore implements A2AProvenanceStore {
  constructor(private readonly database: SqlQueryable) {}

  async record(record: A2AProvenanceRecord): Promise<"stored" | "duplicate"> {
    const response = await this.database.query(
      `SELECT record_a2a_specialist_result(
        $1::uuid, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11, $12, $13, $14::jsonb, $15::timestamptz
      ) AS outcome`,
      [
        record.analysisRunId,
        record.specialty,
        record.allowedAgent.name,
        record.allowedAgent.version,
        record.allowedAgent.cardUrl,
        record.allowedAgent.endpointUrl,
        record.allowedAgent.skillId,
        record.result.taskId,
        record.result.contextId,
        record.result.messageId,
        record.result.correlationId,
        record.result.attempts,
        record.latencyMs,
        JSON.stringify(record.result.artifact),
        record.completedAt,
      ],
    );
    const outcome = response.rows[0]?.outcome;
    if (outcome !== "stored" && outcome !== "duplicate") {
      throw new Error("database did not confirm A2A provenance persistence");
    }
    return outcome;
  }

  async recordFailure(record: A2AProvenanceFailureRecord): Promise<"stored" | "duplicate"> {
    const response = await this.database.query(
      `SELECT record_a2a_specialist_failure(
        $1::uuid, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11, $12, $13, $14, $15, $16::timestamptz
      ) AS outcome`,
      [
        record.analysisRunId,
        record.specialty,
        record.allowedAgent.name,
        record.allowedAgent.version,
        record.allowedAgent.cardUrl,
        record.allowedAgent.endpointUrl,
        record.allowedAgent.skillId,
        record.taskId,
        record.contextId,
        record.messageId,
        record.correlationId,
        record.attempts,
        record.latencyMs,
        record.errorCode,
        record.errorMessage,
        record.completedAt,
      ],
    );
    const outcome = response.rows[0]?.outcome;
    if (outcome !== "stored" && outcome !== "duplicate") {
      throw new Error("database did not confirm failed A2A provenance persistence");
    }
    return outcome;
  }
}
