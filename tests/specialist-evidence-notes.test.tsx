import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SpecialistEvidenceSection } from "../components/specialist-evidence";
import { specialistEvidence } from "../lib/specialist-evidence";

const citation = {
  id: "c1", source_kind: "case_document", source_id: "doc-1", chunk_id: "chunk-1",
  locator: "Page 1", excerpt: "Registered office: Suite 4, 12 Quayside", source_label: "Incorporation Extract",
};

function render(observations?: unknown[]) {
  const evidence = specialistEvidence({
    agent_activity: {
      tasks: [{ role: "specialist", status: "completed", task_id: "task-1", specialty: "entity" }],
      contributions: [{ task_id: "task-1", specialty: "entity", status: "partial", payload: {
        citations: [citation],
        reconciliations: [{
          field: "address", address_type: "registered", outcome: "conflict", declared_original: "Ste 4, 12 Quayside",
          documentary_values: [{ original: "Suite 4, 12 Quayside", normalized: "SUITE 4 12 QUAYSIDE", citation_id: "c1" }],
        }],
        ...(observations ? { observations } : {}),
      } }],
    },
  });
  return renderToStaticMarkup(<SpecialistEvidenceSection evidence={evidence} supporting={false} onViewCitation={() => {}} />);
}

describe("agent notes in specialist results", () => {
  it("renders nothing extra when a contribution has no notes", () => {
    const html = render();
    expect(html).toContain("Registered Address");
    expect(html).not.toContain("Agent Note");
  });

  it("shows notes collapsed, labelled advisory, as plain text with their sources", () => {
    const html = render([
      { id: "obs-1", kind: "near_miss_equivalence", about: "address:registered", confidence: "medium",
        statement: "<b>Ste 4</b> and Suite 4 name the same unit.", citations: ["c1"] },
      { id: "obs-2", kind: "visual_check", about: "run", confidence: "low",
        statement: "The extract carries a round seal.", citations: ["c1"] },
    ]);
    expect(html).toContain("Agent Note (1)");
    expect(html).toContain("Advisory, Not Verified by the System");
    expect(html).toContain("Near Miss Equivalence · Medium Confidence");
    expect(html).toContain("Visual Check, Not Text-Verified · Low Confidence");
    // Notes are plain text: markup in a statement is escaped, never rendered.
    expect(html).toContain("&lt;b&gt;Ste 4&lt;/b&gt;");
    expect(html).not.toContain("<b>Ste 4</b>");
    expect(html).toContain("View Incorporation Extract at Page 1");
    // Collapsed by default: the disclosure that holds the notes is not open.
    const notes = html.indexOf("Agent Note (1)");
    const disclosure = html.slice(html.lastIndexOf("<details", notes), notes);
    expect(disclosure.startsWith("<details")).toBe(true);
    expect(disclosure.slice(0, disclosure.indexOf(">"))).not.toContain("open");
  });
});
