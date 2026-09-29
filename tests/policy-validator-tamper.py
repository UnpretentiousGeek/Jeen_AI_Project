import asyncio
import importlib.util
import json
import os
import sys
from pathlib import Path

from lfx.schema.data import Data

spec = importlib.util.spec_from_file_location(
    "policy_validator_v3",
    Path("langflow/components/policy_validator_v3.py"),
)
module = importlib.util.module_from_spec(spec)
assert spec and spec.loader
sys.modules[spec.name] = module
spec.loader.exec_module(module)
KybPolicyContributionValidator = module.KybPolicyContributionValidator


def contribution_from_run(path: Path) -> dict:
    response = json.loads(path.read_text())["body"]
    text = response["outputs"][0]["outputs"][0]["results"]["message"]["data"]["text"].strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1].rsplit("```", 1)[0].strip()
    return json.loads(text)


async def main() -> None:
    contribution = contribution_from_run(Path("artifacts/acceptance/policy-v3-runs/08-citation-injection-guard.json"))
    contribution.pop("deterministic_validation", None)
    contribution["citations"][0]["id"] = "policy-00000000-0000-4000-8000-000000000000"
    validator = KybPolicyContributionValidator()
    validator.artifact = Data(data=contribution)
    validator.database_url = os.environ["POLICY_DATABASE_URL"]
    try:
        await validator.validate()
    except ValueError as error:
        message = str(error)
        assert "differs from the deterministically retrieved matrix" in message or "fabricated" in message or "altered" in message or "unknown" in message
        result = {"result": "PASS", "rejected_error": message}
        output = Path("artifacts/acceptance/policy-v3-runs/08b-validator-tamper.json")
        output.write_text(json.dumps(result, indent=2) + "\n")
        summary_path = Path("artifacts/acceptance/policy-v3-runs/results.json")
        summary = json.loads(summary_path.read_text())
        summary["scenarios"]["fabricated_or_altered_citation_rejected"] = {
            "result": "PASS",
            "injection_guard_status": 200,
            "direct_validator_test": str(output),
        }
        summary_path.write_text(json.dumps(summary, indent=2) + "\n")
        print(json.dumps(result))
        return
    raise AssertionError("fabricated citation was accepted")


asyncio.run(main())
