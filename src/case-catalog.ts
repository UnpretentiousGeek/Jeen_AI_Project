export const JURISDICTIONS = [
  { value: "US", label: "United States" },
  { value: "US-CA", label: "United States — California" },
  { value: "US-DE", label: "United States — Delaware" },
  { value: "US-NY", label: "United States — New York" },
  { value: "US-TX", label: "United States — Texas" },
  { value: "US-WA", label: "United States — Washington" },
  { value: "GB", label: "United Kingdom" },
  { value: "CA", label: "Canada" },
  { value: "SG", label: "Singapore" },
  { value: "AU", label: "Australia" },
] as const;

export const OPERATING_JURISDICTIONS = [
  ...JURISDICTIONS,
  { value: "IE", label: "Ireland" },
  { value: "DE", label: "Germany" },
] as const;

export const BUSINESS_TYPES = [
  { value: "software", label: "Software" },
  { value: "money_services", label: "Money Services" },
  { value: "marketplace", label: "Marketplace" },
  { value: "data_services", label: "Data Services" },
  { value: "financial_services", label: "Financial Services" },
] as const;

export const PRODUCTS = [
  { value: "domestic_payments", label: "Domestic Payments" },
  { value: "cross_border_payments", label: "Cross-Border Payments" },
  { value: "cross_border_payouts", label: "Cross-Border Payouts" },
  { value: "merchant_payouts", label: "Merchant Payouts" },
  { value: "business_account", label: "Business Account" },
  { value: "card_issuing", label: "Card Issuing" },
] as const;

export const DOCUMENT_TYPES = [
  { value: "formation_certificate", label: "Certificate of Incorporation" },
  { value: "ownership_register", label: "Shareholder Register" },
  { value: "ownership_chart", label: "Ownership Chart" },
  { value: "supporting_document", label: "Other" },
] as const;

export const PAYMENT_ACTIVITY_CODES = [
  "unknown",
  "none",
  "facilitates",
  "receives_or_transmits",
] as const;

const PAYMENT_ACTIVITY_LABELS: Record<(typeof PAYMENT_ACTIVITY_CODES)[number], string> = {
  unknown: "Not Sure Yet",
  none: "Does Not Provide Payment Services",
  facilitates: "Facilitates Payments Through Another Provider",
  receives_or_transmits: "Receives or Sends Customer Payments",
};

export const PAYMENT_ACTIVITIES = PAYMENT_ACTIVITY_CODES.map((value) => ({
  value,
  label: PAYMENT_ACTIVITY_LABELS[value],
}));

export const YES_NO_UNKNOWN_CODES = ["unknown", "yes", "no"] as const;

const YES_NO_UNKNOWN_LABELS: Record<(typeof YES_NO_UNKNOWN_CODES)[number], string> = {
  unknown: "Not Sure Yet",
  yes: "Yes",
  no: "No",
};

export const YES_NO_UNKNOWN = YES_NO_UNKNOWN_CODES.map((value) => ({
  value,
  label: YES_NO_UNKNOWN_LABELS[value],
}));

export const LICENSING_BASIS_CODES = ["unknown", "licensed", "exempt", "partner"] as const;

const LICENSING_BASIS_LABELS: Record<(typeof LICENSING_BASIS_CODES)[number], string> = {
  unknown: "Not Sure Yet",
  licensed: "Holds Its Own License",
  exempt: "Claims an Exemption",
  partner: "Uses a Licensed Partner",
};

export const LICENSING_BASIS = LICENSING_BASIS_CODES.map((value) => ({
  value,
  label: LICENSING_BASIS_LABELS[value],
}));

export function caseOptionLabel(options: readonly { value: string; label: string }[], value: string): string {
  return options.find((option) => option.value === value)?.label ?? value;
}

/** The case form's activity declaration questions, keyed by their submitted_payload field. */
export const DECLARED_ACTIVITY_FIELDS = {
  payment_activity: { label: "Payment Activity", question: "How does this business handle payments?", options: PAYMENT_ACTIVITIES },
  handles_customer_funds: { label: "Customer Funds", question: "Does it receive or control customer funds?", options: YES_NO_UNKNOWN },
  licensing_basis: { label: "Licensing Position", question: "What is its licensing position?", options: LICENSING_BASIS },
  operating_jurisdictions: { label: "Customer Locations", question: "Where does it serve customers?", options: OPERATING_JURISDICTIONS },
} as const;

export type DeclaredActivityField = keyof typeof DECLARED_ACTIVITY_FIELDS;
export const DECLARED_ACTIVITY_FIELD_CODES = Object.keys(DECLARED_ACTIVITY_FIELDS) as [DeclaredActivityField, ...DeclaredActivityField[]];

export function declaredAnswerLabel(field: DeclaredActivityField, value: string | readonly string[]): string {
  const { options } = DECLARED_ACTIVITY_FIELDS[field];
  return (typeof value === "string" ? [value] : value).map((item) => caseOptionLabel(options, item)).join(", ");
}

// Case statuses that can take new evidence and start a fresh analysis: a draft, a stopped run
// that needs attention, and an escalated case under enhanced review. start_analysis_run in the
// database enforces the same list.
export const CASE_STATUSES_OPEN_FOR_ANALYSIS: readonly string[] = ["draft", "attention_required", "enhanced_review"];

