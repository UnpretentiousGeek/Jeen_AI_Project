"use client";

import { useEffect, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { caseApi, type ApiProviderProfile } from "@/lib/case-api";
import { JURISDICTIONS } from "@/src/case-catalog";

const ROLE_OPTIONS: Array<{ value: ApiProviderProfile["regulated_roles"][number]; label: string }> = [
  { value: "bank", label: "Bank" },
  { value: "payment_institution", label: "Payment Institution" },
  { value: "money_transmitter", label: "Money Transmitter" },
  { value: "marketplace", label: "Marketplace Operator" },
];

const EMPTY_PROFILE: ApiProviderProfile = {
  legal_name: "",
  regulated_roles: [],
  service_jurisdictions: [],
};

export function ProviderSettings({ embedded = false }: { embedded?: boolean }) {
  const [profile, setProfile] = useState<ApiProviderProfile>(EMPTY_PROFILE);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    caseApi.getProviderProfile()
      .then((value) => { if (value) setProfile(value); })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Unable to load provider details."))
      .finally(() => setLoading(false));
  }, []);

  const toggleRole = (role: ApiProviderProfile["regulated_roles"][number]) => {
    setSaved(false);
    setProfile((current) => ({ ...current, regulated_roles: current.regulated_roles.includes(role)
      ? current.regulated_roles.filter((value) => value !== role)
      : [...current.regulated_roles, role] }));
  };

  const toggleJurisdiction = (jurisdiction: string) => {
    setSaved(false);
    setProfile((current) => ({ ...current, service_jurisdictions: current.service_jurisdictions.includes(jurisdiction)
      ? current.service_jurisdictions.filter((value) => value !== jurisdiction)
      : [...current.service_jurisdictions, jurisdiction] }));
  };

  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSaved(false);
    if (!profile.legal_name.trim() || profile.regulated_roles.length === 0 || profile.service_jurisdictions.length === 0) {
      setError("Enter a legal name and choose at least one role and service location.");
      return;
    }
    setSaving(true);
    try {
      setProfile(await caseApi.saveProviderProfile({ ...profile, legal_name: profile.legal_name.trim() }));
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save provider details.");
    } finally {
      setSaving(false);
    }
  };

  const content = (
    <div className={embedded ? "space-y-6" : "mx-auto max-w-3xl space-y-6"}>
        {!embedded && <a href="/" className="text-sm text-ink-2 underline underline-offset-4 hover:text-ink">Back to Cases</a>}
        <div>
          <h1 className="text-2xl font-semibold">Onboarding Provider</h1>
        </div>
        <form onSubmit={(event) => { void save(event); }}>
          <Card>
            <CardHeader>
              <CardTitle>Provider Details</CardTitle>
              <CardDescription>Use the legal entity and regulated role that provide the onboarding service.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {loading ? <p className="text-sm text-ink-3">Loading provider details…</p> : (
                <>
                  <div className="space-y-2">
                    <label htmlFor="provider-legal-name" className="text-sm font-medium">Legal Name</label>
                    <Input id="provider-legal-name" value={profile.legal_name} maxLength={200} onChange={(event) => { setSaved(false); setProfile({ ...profile, legal_name: event.target.value }); }} />
                  </div>
                  <fieldset className="space-y-3">
                    <legend className="text-sm font-medium">Regulated Roles</legend>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {ROLE_OPTIONS.map((option) => <label key={option.value} className="flex min-h-11 items-center gap-2 rounded-control border border-line px-3 py-2 text-sm">
                        <input type="checkbox" checked={profile.regulated_roles.includes(option.value)} onChange={() => toggleRole(option.value)} />
                        <span>{option.label}</span>
                      </label>)}
                    </div>
                  </fieldset>
                  <fieldset className="space-y-3">
                    <legend className="text-sm font-medium">Service Locations</legend>
                    <p className="text-xs text-ink-3">Select where this provider offers the onboarding service.</p>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {JURISDICTIONS.map((option) => <label key={option.value} className="flex min-h-11 items-center gap-2 rounded-control border border-line px-3 py-2 text-sm">
                        <input type="checkbox" checked={profile.service_jurisdictions.includes(option.value)} onChange={() => toggleJurisdiction(option.value)} />
                        <span>{option.label}</span>
                      </label>)}
                    </div>
                  </fieldset>
                </>
              )}
              {error && <Alert variant="destructive" role="alert"><AlertTitle>Could Not Save Provider Details</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
              {saved && <p role="status" className="text-sm text-green">Provider details saved. New analyses will use this profile.</p>}
            </CardContent>
            <CardFooter><Button type="submit" disabled={loading || saving}>{saving ? "Saving…" : "Save Provider Details"}</Button></CardFooter>
          </Card>
        </form>
    </div>
  );

  return embedded ? (
    <div className="text-ink">{content}</div>
  ) : (
    <main className="min-h-screen bg-page px-4 py-8 text-ink sm:px-6">{content}</main>
  );
}
