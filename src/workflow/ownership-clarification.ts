export type ParsedOwnershipClarification = {
  ownerName: string;
  percentage: number;
};

const ownershipStatement = /^(.{1,120}?)\s+(?:owns|holds|controls)\s+(?:the\s+remaining\s+)?(\d{1,3}(?:\.\d{1,3})?)\s*%(?:\s+of\s+(?:the\s+)?(?:company|business|ownership))?[.!]?$/i;

export function parseOwnershipClarification(
  value: string,
  expectedPercentage?: number,
): ParsedOwnershipClarification {
  const normalized = value.trim().replaceAll(/\s+/g, " ");
  const match = ownershipStatement.exec(normalized);
  if (!match) {
    throw new Error("State the owner's name and percentage, for example: Priya Shah owns 18%.");
  }
  const ownerName = match[1]!.trim();
  const percentage = Number(match[2]);
  if (!Number.isFinite(percentage) || percentage <= 0 || percentage > 100) {
    throw new Error("Ownership percentage must be greater than 0 and no more than 100.");
  }
  if (expectedPercentage !== undefined
    && Math.abs(percentage - expectedPercentage) > 0.001) {
    throw new Error(`The clarification must account for the remaining ${expectedPercentage}%.`);
  }
  return { ownerName, percentage };
}
