from __future__ import annotations

import asyncio
import importlib.util
from pathlib import Path

import pytest

MODULE_PATH = Path(__file__).resolve().parents[1] / "langflow" / "components" / "kyb_tinyfish_search_v3.py"
SPEC = importlib.util.spec_from_file_location("kyb_tinyfish_search_v3", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

GLEIF_MORGAN_STANLEY = {"data": [{"id": "IGJSJL3JD5P30I6NJZ34", "attributes": {
    "lei": "IGJSJL3JD5P30I6NJZ34",
    "entity": {
        "legalName": {"name": "MORGAN STANLEY"}, "registeredAs": "923632",
        "registeredAt": {"id": "RA000602"}, "jurisdiction": "US-DE", "status": "ACTIVE",
        "legalAddress": {"addressLines": ["1209 Orange Street"], "city": "Wilmington",
                         "region": "US-DE", "postalCode": "19801", "country": "US"},
    },
    "registration": {"status": "ISSUED"},
}}]}


class FakeResponse:
    def __init__(self, status_code: int, body: dict):
        self.status_code, self._body = status_code, body

    def json(self) -> dict:
        return self._body

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


class FakeClient:
    """Answers each request with the first response whose predicate matches it, and records calls."""

    def __init__(self, *routes):
        self.routes, self.calls = routes, []

    async def get(self, url, params=None, auth=None, headers=None):
        self.calls.append({"url": url, "params": params or {}, "auth": auth})
        for matches, response in self.routes:
            if matches(url, params or {}):
                return response
        return FakeResponse(200, {"data": [], "items": []})


def run(coroutine):
    return asyncio.run(coroutine)


def test_only_approved_applicant_values_are_disclosed():
    snapshot = {
        "applicant": {"legal_name": "Morgan Stanley", "jurisdiction": "us-de"},
        "submitted_payload": {"entity_declaration": {"identifiers": [
            {"type": "lei", "value": "IGJSJL3JD5P30I6NJZ34"},
            {"type": "registration_number", "value": "923632"},
        ]}},
    }
    assert MODULE._disclosed_applicant(snapshot, ["legal_name", "jurisdiction", "registration_number"]) == {
        "legal_name": "Morgan Stanley", "jurisdiction": "US-DE", "registration_number": "923632"}
    assert MODULE._disclosed_applicant(snapshot, ["legal_name"]) == {"legal_name": "Morgan Stanley"}


def test_gleif_finds_the_entity_by_its_registration_number_in_its_jurisdiction():
    client = FakeClient((lambda url, params: params.get("filter[entity.registeredAs]") == "923632",
                         FakeResponse(200, GLEIF_MORGAN_STANLEY)))
    [row] = run(MODULE._gleif_lookup(client, {"legal_name": "Morgan Stanley", "jurisdiction": "US-DE",
                                              "registration_number": "923632"}, 5, ""))
    assert row["url"] == "https://api.gleif.org/api/v1/lei-records/IGJSJL3JD5P30I6NJZ34"
    assert "Registered as: 923632" in row["snippet"] and "Jurisdiction: US-DE" in row["snippet"]
    assert "Legal address: 1209 Orange Street, Wilmington, US-DE, 19801, US" in row["snippet"]
    assert client.calls[0]["params"]["filter[entity.jurisdiction]"] == "US-DE"
    # An exact identifier match needs no name search.
    assert len(client.calls) == 1


def test_gleif_falls_back_to_the_name_and_keeps_only_the_exact_name():
    similar = {"data": [
        {"id": "X1", "attributes": {"lei": "X1", "entity": {"legalName": {"name": "MORGAN STANLEY BITCOIN TRUST"}}}},
        *GLEIF_MORGAN_STANLEY["data"],
    ]}
    client = FakeClient((lambda url, params: "filter[entity.legalName]" in params, FakeResponse(200, similar)))
    rows = run(MODULE._gleif_lookup(client, {"legal_name": "Morgan Stanley", "registration_number": "999"}, 5, ""))
    assert [row["name"] for row in rows] == ["MORGAN STANLEY"]


def test_companies_house_needs_a_key_and_only_covers_uk_companies():
    with pytest.raises(MODULE.RegistryUnavailable):
        run(MODULE._companies_house_lookup(FakeClient(), {"legal_name": "BP P.L.C."}, 5, ""))
    client = FakeClient()
    assert run(MODULE._companies_house_lookup(client, {"legal_name": "Morgan Stanley", "jurisdiction": "US-DE"}, 5, "key")) == []
    assert client.calls == []


def test_companies_house_looks_up_the_number_then_falls_back_to_the_name():
    profile = {"company_number": "00102498", "company_name": "BP P.L.C.", "company_status": "active",
               "date_of_creation": "1909-04-14", "type": "plc",
               "registered_office_address": {"address_line_1": "1 St James's Square", "locality": "London",
                                             "postal_code": "SW1Y 4PD"}}
    client = FakeClient((lambda url, params: url.endswith("/company/00102498"), FakeResponse(200, profile)))
    [row] = run(MODULE._companies_house_lookup(client, {"jurisdiction": "GB", "registration_number": "00102498"}, 5, "key"))
    assert row["url"] == "https://find-and-update.company-information.service.gov.uk/company/00102498"
    assert "Registered office address: 1 St James's Square, London, SW1Y 4PD" in row["snippet"]
    assert client.calls[0]["auth"] == ("key", "")

    missing = FakeClient(
        (lambda url, params: "/company/" in url, FakeResponse(404, {})),
        (lambda url, params: url.endswith("/search/companies"), FakeResponse(200, {"items": [
            {"company_number": "1", "title": "BP P.L.C. HOLDINGS"}, {"company_number": "00102498", "title": "BP P.L.C."}]})),
    )
    rows = run(MODULE._companies_house_lookup(missing, {"legal_name": "BP p.l.c.", "registration_number": "123"}, 5, "key"))
    assert [row["name"] for row in rows] == ["BP P.L.C."]


def test_a_name_search_offers_no_similar_companies_when_the_applicant_is_not_registered():
    results = FakeClient(
        (lambda url, params: "/company/" in url, FakeResponse(404, {})),
        (lambda url, params: url.endswith("/search/companies"), FakeResponse(200, {"items": [
            {"company_number": "15250664", "title": "HELMSGATE LIMITED"},
            {"company_number": "16565684", "title": "AA COMMERCE LIMITED"}]})),
    )
    assert run(MODULE._companies_house_lookup(
        results, {"legal_name": "Helmsgate Commerce Ltd", "registration_number": "19604271"}, 5, "key")) == []


def test_legal_form_spelling_does_not_prevent_an_exact_match():
    assert MODULE._name_key("BP p.l.c.") == MODULE._name_key("BP PUBLIC LIMITED COMPANY") == "BP PLC"
    assert MODULE._name_key("Acme Holdings Limited") == MODULE._name_key("ACME HOLDINGS LTD")
    assert MODULE._name_key("Helmsgate Ltd") != MODULE._name_key("Helmsgate Commerce Ltd")


def test_web_search_is_restricted_to_the_domains_without_a_registry_adapter():
    assert MODULE._web_query('"Acme" 123', ["sec.gov", "icis.corp.delaware.gov"]) == \
        '"Acme" 123 (site:sec.gov OR site:icis.corp.delaware.gov)'
    assert set(MODULE.REGISTRY_ADAPTERS) == {"gleif.org", "company-information.service.gov.uk"}


FETCH_SPEC = importlib.util.spec_from_file_location(
    "kyb_tinyfish_fetch_v3", Path(__file__).resolve().parents[1] / "langflow" / "components" / "kyb_tinyfish_fetch_v3.py")
assert FETCH_SPEC and FETCH_SPEC.loader
FETCH = importlib.util.module_from_spec(FETCH_SPEC)
FETCH_SPEC.loader.exec_module(FETCH)


def test_registry_records_are_read_from_the_registry_and_web_pages_are_not():
    gleif = "https://api.gleif.org/api/v1/lei-records/IGJSJL3JD5P30I6NJZ34"
    assert FETCH._registry_source(gleif, "") == (gleif, None)
    page = "https://find-and-update.company-information.service.gov.uk/company/00102498"
    assert FETCH._registry_source(page, "key") == (
        "https://api.company-information.service.gov.uk/company/00102498", ("key", ""))
    # Without a key the Companies House page is fetched like any other web page.
    assert FETCH._registry_source(page, "") is None
    assert FETCH._registry_source("https://www.sec.gov/cgi-bin/browse-edgar", "key") is None
    assert FETCH._registry_source("https://api.gleif.org/api/v1/lei-records?filter=x", "") is None


def test_a_registry_record_is_excerpted_as_the_facts_it_states():
    gleif = FETCH._registry_excerpt("https://api.gleif.org/api/v1/lei-records/IGJSJL3JD5P30I6NJZ34", {
        "meta": {"goldenCopy": {"publishDate": "2026-09-27T16:00:00Z"}},
        "data": {"type": "lei-records", "id": "IGJSJL3JD5P30I6NJZ34", "attributes": {
            "lei": "IGJSJL3JD5P30I6NJZ34",
            "entity": {
                "legalName": {"name": "MORGAN STANLEY", "language": "en"},
                "otherNames": [],
                "legalAddress": {"addressLines": ["C/O THE CORPORATION TRUST COMPANY", "1209 ORANGE ST"],
                                 "addressNumber": None, "city": "WILMINGTON", "region": "US-DE",
                                 "country": "US", "postalCode": "19801"},
                "registeredAt": {"id": "RA000602"}, "registeredAs": "0923632",
                "jurisdiction": "US-DE", "legalForm": {"id": "XTIQ", "other": None}, "status": "ACTIVE",
            },
            "registration": {"status": "ISSUED", "nextRenewalDate": "2027-03-01T00:00:00Z"},
        }},
    })
    assert gleif == (
        "Legal name: MORGAN STANLEY\n"
        "LEI: IGJSJL3JD5P30I6NJZ34\n"
        "Registered as: 0923632\n"
        "Registration authority: RA000602\n"
        "Jurisdiction: US-DE\n"
        "Legal form: XTIQ\n"
        "Entity status: ACTIVE\n"
        "Legal address: C/O THE CORPORATION TRUST COMPANY, 1209 ORANGE ST, WILMINGTON, US-DE, 19801, US\n"
        "LEI registration status: ISSUED\n"
        "Next renewal date: 2027-03-01T00:00:00Z"
    )
    companies_house = FETCH._registry_excerpt("https://api.company-information.service.gov.uk/company/00102498", {
        "company_name": "BP P.L.C.", "company_number": "00102498", "company_status": "active", "type": "plc",
        "date_of_creation": "1909-04-14", "sic_codes": ["70100"],
        "registered_office_address": {"address_line_1": "1 St James's Square", "locality": "London",
                                      "postal_code": "SW1Y 4PD"},
    })
    assert companies_house == (
        "Company name: BP P.L.C.\nCompany number: 00102498\nStatus: active\nCompany type: plc\n"
        "Incorporated on: 1909-04-14\nRegistered office address: 1 St James's Square, London, SW1Y 4PD\n"
        "SIC codes: 70100"
    )
    # Anything that is not a recognisable record keeps the raw response as its excerpt.
    assert FETCH._registry_excerpt("https://api.gleif.org/api/v1/lei-records/IGJSJL3JD5P30I6NJZ34", {"errors": []}) is None
    assert FETCH._registry_excerpt("https://www.sec.gov/x", {"company_name": "X"}) is None


def test_errors_without_a_message_still_say_what_happened():
    class ReadTimeout(Exception):
        pass
    assert FETCH._error_text(ReadTimeout()) == "ReadTimeout"
    assert FETCH._error_text(ValueError("bad")) == "ValueError: bad"
