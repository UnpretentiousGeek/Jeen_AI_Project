const ADDRESS_PREFIX = /^(?:the\s+)?current\s+registered\s+address\s+is\s+/i;

export function parseAddressClarification(value: string): { address: string } {
  const normalized = value.trim();
  if (!ADDRESS_PREFIX.test(normalized)) {
    throw new Error('State the address as “The current registered address is …”.');
  }

  const address = normalized
    .replace(ADDRESS_PREFIX, "")
    .replace(/[.]$/, "")
    .trim();
  if (address.length < 8 || address.length > 500) {
    throw new Error("The registered address must be between 8 and 500 characters.");
  }
  return { address };
}
