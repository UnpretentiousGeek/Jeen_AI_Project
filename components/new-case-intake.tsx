"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Building2,
  Check,
  FileCheck2,
  FileText,
  Plus,
  SearchCheck,
  ShieldCheck,
  Upload,
  X,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet, FieldTitle } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { SearchableSelect } from "@/components/searchable-select";
import { BUSINESS_TYPES, DOCUMENT_TYPES, JURISDICTIONS, LICENSING_BASIS, OPERATING_JURISDICTIONS, PAYMENT_ACTIVITIES, PRODUCTS, YES_NO_UNKNOWN, caseOptionLabel } from "@/src/case-catalog";

type IntakeStep = 1 | 2 | 3;
type DetailKey = "legalName" | "jurisdiction" | "businessType" | "product" | "registrationNumber" | "registeredAddress" | "operatingAddress" | "mailingAddress" | "paymentActivity" | "handlesCustomerFunds" | "licensingBasis";

type EvidenceFile = {
  id: string;
  name: string;
  size: number;
  file: File;
  documentType: string;
};

export type NewCaseEvidenceUpload = Pick<EvidenceFile, "file" | "documentType">;

export type NewCaseDraft = {
  legalName: string;
  jurisdiction: string;
  businessType: string;
  product: string;
  registrationNumber: string;
  registeredAddress: string;
  operatingAddress: string;
  mailingAddress: string;
  operatingJurisdictions: string[];
  paymentActivity: string;
  handlesCustomerFunds: string;
  licensingBasis: string;
  documents: string[];
};

const INITIAL_DRAFT: NewCaseDraft = {
  legalName: "",
  jurisdiction: "",
  businessType: "",
  product: "",
  registrationNumber: "",
  registeredAddress: "",
  operatingAddress: "",
  mailingAddress: "",
  operatingJurisdictions: [],
  paymentActivity: "unknown",
  handlesCustomerFunds: "unknown",
  licensingBasis: "unknown",
  documents: [],
};

const STEPS = [
  { number: 1, label: "Entity Details" },
  { number: 2, label: "Evidence" },
  { number: 3, label: "Review and Create" },
] as const;

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] text-ink-3">{label}</dt>
      <dd className="mt-1 text-sm font-medium text-ink">{value || "Not provided"}</dd>
    </div>
  );
}

function HiddenFieldError({ id, message }: { id: string; message?: string }) {
  return message ? <span id={id} className="sr-only">{message}</span> : null;
}

export function NewCaseIntake({
  onCancel,
  onCreate,
  onOpenWorkspace,
}: {
  onCancel: () => void;
  onCreate: (draft: NewCaseDraft, files: NewCaseEvidenceUpload[]) => Promise<{ caseId: string; uploadError: string | null }>;
  onOpenWorkspace: (caseId: string, uploadError: string | null) => void;
}) {
  const [step, setStep] = useState<IntakeStep>(1);
  const [draft, setDraft] = useState(INITIAL_DRAFT);
  const [files, setFiles] = useState<EvidenceFile[]>([]);
  const [errors, setErrors] = useState<Partial<Record<DetailKey, string>>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const formRegionRef = useRef<HTMLDivElement>(null);
  const stepHeadingRef = useRef<HTMLHeadingElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const nextFileIdRef = useRef(0);

  useEffect(() => {
    if (step === 1) return;
    window.requestAnimationFrame(() => {
      window.scrollTo({ top: 0 });
      stepHeadingRef.current?.focus({ preventScroll: true });
    });
  }, [step]);

  const updateDraft = (key: DetailKey, value: string) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
  };

  const toggleOperatingJurisdiction = (value: string) => {
    setDraft((current) => ({
      ...current,
      operatingJurisdictions: current.operatingJurisdictions.includes(value)
        ? current.operatingJurisdictions.filter((item) => item !== value)
        : [...current.operatingJurisdictions, value],
    }));
  };

  const validateDetails = () => {
    const nextErrors: Partial<Record<DetailKey, string>> = {};
    if (!draft.legalName.trim()) nextErrors.legalName = "Enter the legal business name.";
    if (!draft.jurisdiction) nextErrors.jurisdiction = "Select a jurisdiction.";
    if (!draft.businessType) nextErrors.businessType = "Select a business type.";
    if (!draft.product) nextErrors.product = "Select the product being requested.";
    if (!draft.registrationNumber.trim()) nextErrors.registrationNumber = "Enter the registration number.";
    if (!draft.registeredAddress.trim()) nextErrors.registeredAddress = "Enter the registered address.";
    if (!draft.operatingAddress.trim()) nextErrors.operatingAddress = "Enter the operating address.";
    if (!draft.mailingAddress.trim()) nextErrors.mailingAddress = "Enter the mailing address.";
    setErrors(nextErrors);

    if (Object.keys(nextErrors).length > 0) {
      window.requestAnimationFrame(() => formRegionRef.current?.querySelector<HTMLElement>("[aria-invalid='true']")?.focus());
      return false;
    }
    return true;
  };

  const moveToStep = (nextStep: IntakeStep) => {
    setStep(nextStep);
  };

  const continueFlow = () => {
    if (step === 1 && !validateDetails()) return;
    if (step === 1) moveToStep(2);
    if (step === 2) moveToStep(3);
  };

  const addFiles = (selectedFiles: FileList | null) => {
    if (!selectedFiles) return;
    const additions = Array.from(selectedFiles).map((file) => ({
      id: `evidence-${nextFileIdRef.current++}`,
      name: file.name,
      size: file.size,
      file,
      documentType: "supporting_document",
    }));
    setFiles((current) => [...current, ...additions]);
    setDraft((current) => ({ ...current, documents: [...current.documents, ...additions.map((file) => file.name)] }));
  };

  const removeFile = (fileId: string) => {
    const remaining = files.filter((file) => file.id !== fileId);
    setFiles(remaining);
    setDraft((current) => ({ ...current, documents: remaining.map((file) => file.name) }));
  };

  const createCase = async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await onCreate(draft, files.map(({ file, documentType }) => ({ file, documentType })));
      onOpenWorkspace(result.caseId, result.uploadError);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Unable to create the case.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto max-w-6xl pb-28">
      <header className="sticky top-0 z-20 -mx-4 flex min-h-24 items-center justify-between gap-5 border-b border-line bg-page/92 px-4 py-4 backdrop-blur-xl sm:-mx-6 sm:px-6 xl:-mx-12 xl:px-12">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-[-0.035em] sm:text-[30px]">Start a New Case</h1>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" onClick={onCancel} aria-label="Close new case flow"><X /></Button>
        </div>
      </header>

      <nav className="py-6" aria-label="New case progress">
        <ol className="grid grid-cols-3 gap-2 sm:gap-4">
          {STEPS.map((item) => {
            const complete = step > item.number;
            const current = step === item.number;
            return (
              <li key={item.number}>
                <Button
                  type="button"
                  variant={current ? "secondary" : "ghost"}
                  className="h-auto min-h-12 w-full justify-start rounded-control px-2 py-2 text-left sm:px-3"
                  onClick={() => complete && moveToStep(item.number)}
                  disabled={!complete && !current}
                  aria-current={current ? "step" : undefined}
                >
                  <span className={`flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${complete ? "bg-green text-white" : current ? "bg-ink text-canvas" : "bg-inset text-ink-3"}`}>
                    {complete ? <Check /> : item.number}
                  </span>
                  <span className="hidden min-w-0 sm:block">
                    <span className="block text-[10px] font-normal text-ink-3">Step {item.number}</span>
                    <span className="block truncate text-xs">{item.label}</span>
                  </span>
                </Button>
              </li>
            );
          })}
        </ol>
        <Progress value={(step / 3) * 100} className="mt-3 h-1" aria-label={`Step ${step} of 3`} />
      </nav>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_310px]">
        <div ref={formRegionRef}>
          {step === 1 && (
            <Card>
              <CardHeader>
                <span className="mb-2 flex size-10 items-center justify-center rounded-window bg-accent-tint text-accent-ink" aria-hidden="true"><Building2 /></span>
                <CardTitle><h2 className="text-xl tracking-[-0.02em]">Entity Details</h2></CardTitle>
              </CardHeader>
              <CardContent>
                <FieldSet>
                  <FieldLegend className="sr-only">Entity Details</FieldLegend>
                  <FieldGroup className="gap-5">
                    <Field>
                      <FieldLabel htmlFor="legal-name">Legal Business Name</FieldLabel>
                      <Input id="legal-name" value={draft.legalName} onChange={(event) => updateDraft("legalName", event.target.value)} placeholder="Cascade Goods Inc" aria-invalid={Boolean(errors.legalName)} aria-describedby={errors.legalName ? "legal-name-error" : undefined} />
                      <HiddenFieldError id="legal-name-error" message={errors.legalName} />
                    </Field>

                    <div className="grid gap-5 sm:grid-cols-2">
                      <Field>
                        <FieldLabel htmlFor="jurisdiction">Jurisdiction</FieldLabel>
                        <SearchableSelect id="jurisdiction" value={draft.jurisdiction} onValueChange={(value) => updateDraft("jurisdiction", value)} options={JURISDICTIONS} placeholder="Select a Jurisdiction…" searchPlaceholder="Search Jurisdictions…" invalid={Boolean(errors.jurisdiction)} describedBy={errors.jurisdiction ? "jurisdiction-error" : undefined} />
                        <HiddenFieldError id="jurisdiction-error" message={errors.jurisdiction} />
                      </Field>

                      <Field>
                        <FieldLabel htmlFor="business-type">Business Type</FieldLabel>
                        <SearchableSelect id="business-type" value={draft.businessType} onValueChange={(value) => updateDraft("businessType", value)} options={BUSINESS_TYPES} placeholder="Select a Business Type…" searchPlaceholder="Search Business Types…" invalid={Boolean(errors.businessType)} describedBy={errors.businessType ? "business-type-error" : undefined} />
                        <HiddenFieldError id="business-type-error" message={errors.businessType} />
                      </Field>
                    </div>

                    <Field>
                      <FieldLabel htmlFor="product">Product Requested</FieldLabel>
                      <SearchableSelect id="product" value={draft.product} onValueChange={(value) => updateDraft("product", value)} options={PRODUCTS} placeholder="Select a Product…" searchPlaceholder="Search Products…" invalid={Boolean(errors.product)} describedBy={errors.product ? "product-error" : undefined} />
                      <HiddenFieldError id="product-error" message={errors.product} />
                    </Field>

                    <Field>
                      <FieldLabel htmlFor="registration-number">Registration Number</FieldLabel>
                      <Input id="registration-number" value={draft.registrationNumber} onChange={(event) => updateDraft("registrationNumber", event.target.value)} placeholder="12345678" aria-invalid={Boolean(errors.registrationNumber)} aria-describedby={errors.registrationNumber ? "registration-number-error" : undefined} />
                      <HiddenFieldError id="registration-number-error" message={errors.registrationNumber} />
                    </Field>

                    <Field>
                      <FieldLabel htmlFor="registered-address">Registered Address</FieldLabel>
                      <Input id="registered-address" value={draft.registeredAddress} onChange={(event) => updateDraft("registeredAddress", event.target.value)} placeholder="100 Market Street, San Francisco, CA 94105" aria-invalid={Boolean(errors.registeredAddress)} aria-describedby={errors.registeredAddress ? "registered-address-error" : undefined} />
                      <HiddenFieldError id="registered-address-error" message={errors.registeredAddress} />
                    </Field>

                    <Field>
                      <FieldLabel htmlFor="operating-address">Operating Address</FieldLabel>
                      <Input id="operating-address" value={draft.operatingAddress} onChange={(event) => updateDraft("operatingAddress", event.target.value)} placeholder="200 Market Street, San Francisco, CA 94105" aria-invalid={Boolean(errors.operatingAddress)} aria-describedby={errors.operatingAddress ? "operating-address-error" : undefined} />
                      <HiddenFieldError id="operating-address-error" message={errors.operatingAddress} />
                    </Field>

                    <Field>
                      <FieldLabel htmlFor="mailing-address">Mailing Address</FieldLabel>
                      <Input id="mailing-address" value={draft.mailingAddress} onChange={(event) => updateDraft("mailingAddress", event.target.value)} placeholder="PO Box 123, San Francisco, CA 94104" aria-invalid={Boolean(errors.mailingAddress)} aria-describedby={errors.mailingAddress ? "mailing-address-error" : undefined} />
                      <HiddenFieldError id="mailing-address-error" message={errors.mailingAddress} />
                    </Field>

                    <FieldSet className="border-t border-line pt-5">
                      <FieldLegend className="text-sm font-semibold text-ink">Business Activity</FieldLegend>
                      <FieldGroup className="mt-4 gap-5">
                        <Field>
                          <FieldLabel htmlFor="payment-activity">How does this business handle payments?</FieldLabel>
                        <SearchableSelect id="payment-activity" value={draft.paymentActivity} onValueChange={(value) => updateDraft("paymentActivity", value)} options={PAYMENT_ACTIVITIES} placeholder="Select a Payment Activity…" searchPlaceholder="Search Payment Activities…" invalid={false} />
                        </Field>
                        <Field>
                          <FieldLabel htmlFor="handles-customer-funds">Does it receive or control customer funds?</FieldLabel>
                          <SearchableSelect id="handles-customer-funds" value={draft.handlesCustomerFunds} onValueChange={(value) => updateDraft("handlesCustomerFunds", value)} options={YES_NO_UNKNOWN} placeholder="Select an Answer…" searchPlaceholder="Search Answers…" invalid={false} />
                        </Field>
                        <Field>
                          <FieldLabel htmlFor="licensing-basis">Licensing Position</FieldLabel>
                        <SearchableSelect id="licensing-basis" value={draft.licensingBasis} onValueChange={(value) => updateDraft("licensingBasis", value)} options={LICENSING_BASIS} placeholder="Select a Licensing Position…" searchPlaceholder="Search Licensing Positions…" invalid={false} />
                        </Field>
                        <fieldset className="space-y-3">
                          <legend className="text-sm font-medium text-ink">Where does it serve customers?</legend>
                          <p className="text-xs text-ink-3">Select every known location. Leave all clear if this is not confirmed.</p>
                          <div className="grid gap-2 sm:grid-cols-2">
                            {OPERATING_JURISDICTIONS.map((option) => (
                              <label key={option.value} className="flex min-h-10 items-center gap-2 rounded-control border border-line px-3 py-2 text-sm">
                                <input type="checkbox" checked={draft.operatingJurisdictions.includes(option.value)} onChange={() => toggleOperatingJurisdiction(option.value)} />
                                <span>{option.label}</span>
                              </label>
                            ))}
                          </div>
                        </fieldset>
                      </FieldGroup>
                    </FieldSet>
                  </FieldGroup>
                </FieldSet>
              </CardContent>
            </Card>
          )}

          {step === 2 && (
            <Card>
              <CardHeader>
                <span className="mb-2 flex size-10 items-center justify-center rounded-window bg-accent-tint text-accent-ink" aria-hidden="true"><Upload /></span>
                <CardTitle><h2 ref={stepHeadingRef} tabIndex={-1} className="text-xl tracking-[-0.02em] outline-none">Add Evidence</h2></CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <Field>
                  <FieldTitle>Business Documents</FieldTitle>
                  <input
                    ref={fileInputRef}
                    id="evidence-files"
                    type="file"
                    multiple
                    accept=".pdf,.png,.jpg,.jpeg,.txt,.md,.docx"
                    hidden
                    onChange={(event) => {
                      addFiles(event.target.files);
                      event.target.value = "";
                    }}
                  />
                  <div className="rounded-window border border-line-strong bg-surface p-3 shadow-xs">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <span className="flex size-9 shrink-0 items-center justify-center rounded-control bg-inset text-ink-2" aria-hidden="true"><FileText className="size-4" /></span>
                        <span className="text-sm text-ink-2">{files.length === 0 ? "No documents selected" : `${files.length} ${files.length === 1 ? "document" : "documents"} selected`}</span>
                      </div>
                      <Button type="button" variant="outline" size="sm" className="active:scale-100" onClick={() => fileInputRef.current?.click()}>
                        <Plus className="size-4" aria-hidden="true" />
                        Add Files
                      </Button>
                    </div>
                    {files.length > 0 && (
                      <ul className="mt-3 flex flex-col gap-3 border-t border-line pt-3" aria-label="Selected documents">
                        {files.map((file) => (
                          <li key={file.id} className="flex flex-wrap items-center gap-3 rounded-control bg-inset p-3 sm:flex-nowrap">
                            <span className="flex size-9 shrink-0 items-center justify-center rounded-control bg-surface text-ink-2" aria-hidden="true"><FileText className="size-4" /></span>
                            <span className="min-w-0 flex-1">
                              <strong className="block truncate text-sm" title={file.name}>{file.name}</strong>
                              <span className="text-xs text-ink-3">{formatBytes(file.size)}</span>
                            </span>
                            <div className="w-full sm:w-56">
                              <SearchableSelect
                                id={`new-case-evidence-type-${file.id}`}
                                value={file.documentType}
                                onValueChange={(documentType) => setFiles((current) => current.map((item) => item.id === file.id ? { ...item, documentType } : item))}
                                options={DOCUMENT_TYPES}
                                placeholder="Select a Document Type…"
                                searchPlaceholder="Search Document Types…"
                                invalid={false}
                              />
                            </div>
                            <Button type="button" variant="ghost" size="icon-sm" className="active:scale-100" onClick={() => removeFile(file.id)} aria-label={`Remove ${file.name}`}>
                              <X className="size-4" />
                            </Button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </Field>
              </CardContent>
            </Card>
          )}

          {step === 3 && (
            <div className="flex flex-col gap-4">
            {submitError && (
              <Alert variant="destructive">
                <ShieldCheck />
                <AlertTitle>Case Not Created</AlertTitle>
                <AlertDescription>{submitError}</AlertDescription>
              </Alert>
            )}
            <Card>
              <CardHeader>
                <span className="mb-2 flex size-10 items-center justify-center rounded-window bg-green-tint text-green" aria-hidden="true"><SearchCheck /></span>
                <CardTitle><h2 ref={stepHeadingRef} tabIndex={-1} className="text-xl tracking-[-0.02em] outline-none">Review and Create</h2></CardTitle>
                <CardDescription>Confirm the details before saving this case as a draft.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-6">
                <dl className="grid gap-5 rounded-card bg-inset p-4 sm:grid-cols-2">
                  <SummaryItem label="Legal Business Name" value={draft.legalName} />
                  <SummaryItem label="Jurisdiction" value={caseOptionLabel(JURISDICTIONS, draft.jurisdiction)} />
                  <SummaryItem label="Business Type" value={caseOptionLabel(BUSINESS_TYPES, draft.businessType)} />
                  <SummaryItem label="Product Requested" value={caseOptionLabel(PRODUCTS, draft.product)} />
                  <SummaryItem label="Registration Number" value={draft.registrationNumber} />
                  <SummaryItem label="Registered Address" value={draft.registeredAddress} />
                  <SummaryItem label="Operating Address" value={draft.operatingAddress} />
                  <SummaryItem label="Payment Activity" value={caseOptionLabel(PAYMENT_ACTIVITIES, draft.paymentActivity)} />
                  <SummaryItem label="Customer Funds" value={caseOptionLabel(YES_NO_UNKNOWN, draft.handlesCustomerFunds)} />
                  <SummaryItem label="Licensing Position" value={caseOptionLabel(LICENSING_BASIS, draft.licensingBasis)} />
                  <SummaryItem label="Customer Locations" value={draft.operatingJurisdictions.map((value) => caseOptionLabel(OPERATING_JURISDICTIONS, value)).join(", ") || "Not confirmed"} />
                  <SummaryItem label="Mailing Address" value={draft.mailingAddress} />
                </dl>

                <div>
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-sm font-semibold">Evidence</h3>
                    <Badge variant="secondary">{files.length} {files.length === 1 ? "Document" : "Documents"}</Badge>
                  </div>
                  {files.length > 0 ? (
                    <ul className="mt-3 flex flex-col gap-2">
                      {files.map((file) => <li key={file.id} className="flex items-center gap-2 text-sm text-ink-2"><FileText className="size-4" /><span className="truncate">{file.name}</span><span className="ml-auto shrink-0 text-xs text-ink-3">{caseOptionLabel(DOCUMENT_TYPES, file.documentType)}</span></li>)}
                    </ul>
                  ) : (
                    <p className="mt-2 text-sm text-ink-3">No documents added. Analysis requires at least one ready document.</p>
                  )}
                </div>

                <Alert variant="info">
                  <ShieldCheck />
                  <AlertTitle>You Stay in Control</AlertTitle>
                  <AlertDescription>Agents can analyze evidence and prepare findings. Any external search or final decision still requires your approval.</AlertDescription>
                </Alert>
              </CardContent>
            </Card>
            </div>
          )}
        </div>

        <aside className="lg:sticky lg:top-30" aria-label="What happens next">
          <Card className="gap-5">
            <CardHeader>
              <CardTitle><h2 className="text-base">What Happens Next</h2></CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="flex flex-col gap-5">
                {[
                  [Building2, "Verify the Entity", "Match the legal identity and registration details."],
                  [FileCheck2, "Review Ownership", "Extract and compare beneficial-owner evidence."],
                  [SearchCheck, "Map Policy Controls", "Prepare findings with source citations."],
                ].map(([Icon, title, description], index) => (
                  <li key={String(title)} className="flex gap-3">
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-control bg-inset text-ink-2" aria-hidden="true"><Icon className="size-4" /></span>
                    <span>
                      <strong className="block text-xs">{index + 1}. {String(title)}</strong>
                      <span className="mt-0.5 block text-xs leading-5 text-ink-3">{String(description)}</span>
                    </span>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </aside>
      </div>

      <footer className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-page/95 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4 backdrop-blur-xl lg:ms-[280px]">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3">
          <Button type="button" variant="ghost" onClick={step === 1 ? onCancel : () => moveToStep((step - 1) as IntakeStep)}>
            {step > 1 && <ArrowLeft data-icon="inline-start" />}
            {step === 1 ? "Cancel" : "Back"}
          </Button>
          <div className="flex items-center gap-2">
            {step < 3 ? (
              <Button type="button" onClick={continueFlow}>Continue <ArrowRight data-icon="inline-end" /></Button>
            ) : (
              <Button type="button" onClick={createCase} disabled={submitting}>
                {submitting ? "Creating Case…" : "Create Case"}
                {!submitting && <ArrowRight data-icon="inline-end" />}
              </Button>
            )}
          </div>
        </div>
      </footer>
    </div>
  );
}
