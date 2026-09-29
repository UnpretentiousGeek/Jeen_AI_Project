import asyncio
import hashlib
import hmac
import importlib.util
import json
import os
import sys
from pathlib import Path

from lfx.schema.data import Data
from lfx.schema.message import Message


def load(name: str, path: str):
    spec = importlib.util.spec_from_file_location(name, Path(path))
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


Scope = load("public_research_scope_v3", "langflow/components/public_research_scope_v3.py").KybPublicResearchScope
Validator = load("public_research_validator_v3", "langflow/components/public_research_validator_v3.py").KybPublicResearchContributionValidator

# Seeded citation-guard scenario (db/seeds/006_public_research_v3_acceptance.sql).
TASK = {
    "operation_mode": "analyze_accepted_results",
    "analysis_run_id": "a3000000-0000-4000-8000-000000000048",
    "task_id": "public-research-tamper-48",
    "context_id": "public-research-tamper-context-48",
    "case_id": "32000000-0000-0000-0000-000000000048",
    "search_execution_id": "e3000000-0000-4000-8000-000000000048",
    "approved_plan": {
        "query": '"Public Research Example 48 Ltd" "MT-48"',
        "allowed_domains": ["regulator.example.gov"],
        "disclosed_applicant_fields": ["legal_name", "claimed_license_type", "jurisdiction"],
        "result_limit": 5,
        "claim_id": "licensing",
        "claim": "Public Research Example 48 Ltd holds money transmitter license MT-48.",
        "rationale": "Resolve the documented licensing evidence gap using bounded official-domain research.",
    },
}


async def main() -> None:
    database_url = os.environ["PUBLIC_RESEARCH_DATABASE_URL"]

    scope = Scope()
    scope.input_value = Message(text=json.dumps(TASK))
    scope.database_url = database_url
    signed = await scope._prepare_once()
    context = json.loads(json.dumps(signed["context"]))
    page = context["results"][0]

    # Alter the stored excerpt and re-sign the context with the real key, so only the
    # validator's independent database comparison can catch the change.
    page["excerpt"] += " ALTERED"
    canonical = json.dumps(Validator._canonical(context), sort_keys=True, separators=(",", ":"), default=str).encode()
    proof = hmac.new(database_url.encode(), canonical, hashlib.sha256).hexdigest()
    extraction = {
        "result_id": page["immutable_result_id"],
        "legal_name": "Public Research Example 48 Ltd",
        "identifiers": ["GB-PR-0048"],
        "other_identifiers": [],
        "jurisdiction": "",
        "address": "",
        "official_domain": "",
        "claims": {"licensing": {"stance": "support", "quote": "holds money transmitter license MT-48"}},
    }

    validator = Validator()
    validator.research_context = Data(data={"context": context, "context_proof": proof})
    validator.artifact = Data(data={"extractions_json": json.dumps({"extractions": [extraction]})})
    validator.database_url = database_url

    try:
        await validator.validate()
    except ValueError as error:
        message = str(error)
        assert "fabricated or altered" in message
        output = Path("artifacts/acceptance/public-research-v3-runs/09b-validator-tamper.json")
        output.write_text(json.dumps({"result": "PASS", "rejected_error": message}, indent=2) + "\n")
        summary_path = Path("artifacts/acceptance/public-research-v3-runs/results.json")
        summary = json.loads(summary_path.read_text())
        summary["scenarios"]["fabricated_or_altered_citations_rejected"] = {
            "result": "PASS",
            "normal_flow_http_status": 200,
            "direct_validator_test": str(output),
            "tampered_context_proof_recomputed": True,
        }
        summary_path.write_text(json.dumps(summary, indent=2) + "\n")
        print(json.dumps({"result": "PASS", "rejected_error": message}))
        return
    raise AssertionError("altered citation was accepted")


asyncio.run(main())
