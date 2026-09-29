"""Generate KYB test document packets as PDFs.

Run with: uv run --with reportlab scripts/generate-kyb-test-documents.py

Three packets are written to output/pdf/:
  - aldermoor_*: a fictional UK company whose packet deliberately omits and contradicts
    identity and ownership facts, so the coordinator asks the analyst for clarification.
  - morgan_stanley_*: a real, widely held public company. Identity facts match the case
    declaration, but registry status, beneficial ownership, and licences are left for
    public-source verification, so an analyst research request yields web searches.
  - helmsgate_*: a fictional UK marketplace with three ownership layers and conflicts buried
    in a 12-page annual report, for demonstrating what a quick manual skim misses.
  - morgan_stanley_full_*: a longer Morgan Stanley packet built only from public filings, where
    MUFG's stake differs across filings near 25% and the hypothetical application form was
    filled in from a subsidiary's records.
  - brackwater_*: a fictional UK trading company planted with one situation for each advisory
    observation kind the other packets do not exercise (see the comment above brackwater()).
"""

from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

OUT = Path(__file__).resolve().parent.parent / "output" / "pdf"

styles = getSampleStyleSheet()
BANNER = ParagraphStyle("banner", parent=styles["Normal"], fontName="Helvetica-Bold", fontSize=9,
                        alignment=1, textColor=colors.HexColor("#8a1c1c"))
TITLE = ParagraphStyle("title", parent=styles["Title"], fontSize=17, spaceBefore=6, spaceAfter=10)
HEADING = ParagraphStyle("heading", parent=styles["Heading2"], fontSize=12, spaceBefore=10, spaceAfter=4)
BODY = ParagraphStyle("body", parent=styles["Normal"], fontSize=9.5, leading=13)
CELL = ParagraphStyle("cell", parent=BODY, fontSize=9.5)


def fields(rows):
    table = Table([[Paragraph(k, CELL), Paragraph(v, CELL)] for k, v in rows], colWidths=[55 * mm, 115 * mm])
    table.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LINEBELOW", (0, 0), (-1, -1), 0.25, colors.HexColor("#cccccc")),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    return table


def grid(rows):
    """Multi-column table; the first row is the header and numeric columns are right-aligned."""
    width = 170 * mm
    first = 70 * mm if len(rows[0]) > 2 else 85 * mm
    rest = (width - first) / (len(rows[0]) - 1)
    table = Table([[Paragraph(str(cell), CELL) for cell in row] for row in rows],
                  colWidths=[first] + [rest] * (len(rows[0]) - 1))
    table.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LINEBELOW", (0, 0), (-1, 0), 0.6, colors.HexColor("#333333")),
        ("LINEBELOW", (0, 1), (-1, -1), 0.25, colors.HexColor("#cccccc")),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    return table


PAGE_BREAK = ("", None)


def seal_and_signature(canvas, seal_text, signer):
    """A round company seal and a signature scrawl, drawn as page graphics rather than text."""
    canvas.saveState()
    canvas.setStrokeColor(colors.HexColor("#8a1c1c"))
    canvas.setFillColor(colors.HexColor("#8a1c1c"))
    canvas.setLineWidth(1.4)
    canvas.circle(160 * mm, 58 * mm, 17 * mm)
    canvas.circle(160 * mm, 58 * mm, 13 * mm)
    canvas.setFont("Helvetica-Bold", 6)
    for offset, line in zip((3.5, 0, -3.5), (*seal_text, "COMMON SEAL")):
        canvas.drawCentredString(160 * mm, (57 + offset) * mm, line)
    canvas.setStrokeColor(colors.HexColor("#1f3a8a"))
    canvas.setLineWidth(1.1)
    scrawl = canvas.beginPath()
    scrawl.moveTo(25 * mm, 50 * mm)
    scrawl.curveTo(32 * mm, 62 * mm, 36 * mm, 40 * mm, 44 * mm, 55 * mm)
    scrawl.curveTo(50 * mm, 66 * mm, 55 * mm, 44 * mm, 63 * mm, 54 * mm)
    scrawl.curveTo(68 * mm, 60 * mm, 72 * mm, 50 * mm, 80 * mm, 52 * mm)
    canvas.drawPath(scrawl)
    canvas.setStrokeColor(colors.HexColor("#333333"))
    canvas.setLineWidth(0.5)
    canvas.line(25 * mm, 46 * mm, 85 * mm, 46 * mm)
    canvas.setFillColor(colors.HexColor("#333333"))
    canvas.setFont("Helvetica", 7.5)
    canvas.drawString(25 * mm, 42 * mm, signer)
    canvas.restoreState()


def build(filename, title, footer, banner, sections, seal=None):
    def decorate(canvas, doc):
        canvas.saveState()
        canvas.setFont("Helvetica", 7.5)
        canvas.setFillColor(colors.HexColor("#555555"))
        canvas.drawString(20 * mm, 12 * mm, footer)
        canvas.drawRightString(190 * mm, 12 * mm, f"Page {doc.page}")
        canvas.restoreState()
        if seal and doc.page == 1:
            seal_and_signature(canvas, *seal)

    story = [Paragraph(banner, BANNER), Spacer(1, 6), Paragraph(title, TITLE)]
    for heading, content in sections:
        if content is None:
            story.append(PageBreak())
            continue
        story.append(Paragraph(heading, HEADING))
        if isinstance(content, str):
            story.append(Paragraph(content, BODY))
        elif isinstance(content, Table):
            story.append(content)
        else:
            story.append(fields(content))
    doc = SimpleDocTemplate(str(OUT / filename), pagesize=A4, title=title, author="Jeen AI test data",
                            leftMargin=20 * mm, rightMargin=20 * mm, topMargin=18 * mm, bottomMargin=20 * mm)
    doc.build(story, onFirstPage=decorate, onLaterPages=decorate)


# --- Fictional packet: Aldermoor Logistics Ltd -------------------------------------------------
# Planted gaps: no company number or mailing address anywhere; the registered address differs
# between the extract and the declaration; Priya Raman's stake in the parent is 52% in the chart
# but 60% in the declaration.

AL_BANNER = "SYNTHETIC TEST DOCUMENT - NOT AN OFFICIAL RECORD"
AL_FOOTER = "SYNTHETIC TEST EVIDENCE | Aldermoor Logistics Ltd | Not valid for legal or regulatory use"


def aldermoor():
    build("aldermoor_logistics_incorporation_extract.pdf", "Incorporation record extract", AL_FOOTER, AL_BANNER, [
        ("Entity record", [
            ("Legal name", "Aldermoor Logistics Ltd"),
            ("Jurisdiction", "England and Wales (GB)"),
            ("Legal form", "Private company limited by shares"),
            ("Date of incorporation", "3 May 2023"),
            ("Status on extract date", "Active"),
            ("Registered address", "Unit 7, Wharfside Court, Leeds LS11 5PQ, United Kingdom"),
            ("Directors", "Priya Raman (appointed 3 May 2023); Owen Hartley (appointed 14 January 2025)"),
        ]),
        ("Record provenance",
         "Prepared as a fictional registry-style extract for local KYB workflow testing. Extract date: "
         "22 September 2026. The applicant supplied a cropped copy; the top of the registry page, where the "
         "company number appears, is cut off. This file is not issued by Companies House and must not be used "
         "as real incorporation evidence."),
    ])

    build("aldermoor_logistics_shareholder_register.pdf", "Shareholder register", AL_FOOTER, AL_BANNER, [
        ("Company and share capital", [
            ("Legal name", "Aldermoor Logistics Ltd"),
            ("Record date", "22 September 2026"),
            ("Issued share capital", "1,000 ordinary shares; one vote per share"),
        ]),
        ("Registered holders",
         "The register records one corporate shareholder. Beneficial owners must be traced through the "
         "parent company; see the separate group ownership chart."),
        ("Ownership", [
            ("Aldermoor Holdings Ltd (private company, England and Wales)",
             "1,000 ordinary shares - 100% ownership and voting rights"),
            ("Total accounted for", "1,000 shares - 100% ownership and voting rights"),
        ]),
        ("Prepared by", "Priya Raman, Director - fictional statement dated 22 September 2026."),
    ])

    build("aldermoor_logistics_ownership_chart.pdf", "Group ownership chart", AL_FOOTER, AL_BANNER, [
        ("Structure",
         "Level 0: Aldermoor Logistics Ltd (applicant).<br/>"
         "Level 1: Aldermoor Holdings Ltd holds 100% of the applicant.<br/>"
         "Level 2: the holders of Aldermoor Holdings Ltd are listed below."),
        ("Holders of Aldermoor Holdings Ltd (2,500 ordinary shares; one vote per share)", [
            ("Priya Raman (natural person, United Kingdom resident)",
             "1,300 shares - 52% of the parent; 52% indirect interest in the applicant"),
            ("Tomasz Nowak (natural person, Poland resident)",
             "750 shares - 30% of the parent; 30% indirect interest in the applicant"),
            ("Fernhill Ventures LP (limited partnership, Scotland)",
             "450 shares - 18% of the parent; 18% indirect interest in the applicant"),
            ("Total accounted for", "2,500 shares - 100%"),
        ]),
        ("Declared beneficial owners",
         "Priya Raman (52% indirect) and Tomasz Nowak (30% indirect). Fernhill Ventures LP is below the 25% "
         "threshold; its general partner and limited partners are not disclosed in this packet. No nominee "
         "arrangement or shareholder agreement conferring additional control is declared."),
        ("Prepared by", "Priya Raman, Director - fictional statement dated 22 September 2026."),
    ])

    build("aldermoor_logistics_business_declaration.pdf", "Business and address declaration", AL_FOOTER, AL_BANNER, [
        ("Applicant details", [
            ("Legal name", "Aldermoor Logistics Ltd"),
            ("Registered address", "Unit 9, Wharfside Court, Leeds LS11 5PQ, United Kingdom"),
            ("Operating address", "Unit 7, Wharfside Court, Leeds LS11 5PQ, United Kingdom"),
            ("Business type", "Software"),
            ("Requested product", "Merchant payouts"),
            ("Operating jurisdictions", "United Kingdom, Ireland"),
        ]),
        ("Operating model",
         "Aldermoor Logistics Ltd licenses route-planning and proof-of-delivery software to independent courier "
         "firms in the United Kingdom and Ireland. Couriers pay a monthly subscription. The applicant requests "
         "merchant payouts to settle rebates owed to courier firms under a volume incentive scheme."),
        ("Control",
         "Priya Raman, Director, holds 60% of Aldermoor Holdings Ltd (1,500 of 2,500 shares), the applicant's "
         "sole shareholder, and is the applicant's principal decision-maker."),
        ("Funds flow and licensing",
         "The applicant states that it only pays out its own funds (subscription revenue) and does not receive "
         "or hold money on behalf of third parties. It does not claim to hold a financial-services licence and "
         "does not claim an exemption. Expected payout volume: approximately GBP 40,000 per month across about "
         "120 courier firms."),
        ("Declaration", "Prepared by Priya Raman, Director, on 22 September 2026 for synthetic KYB testing only."),
    ])


# --- Real-company packet: Morgan Stanley ---------------------------------------------------------
# Identity facts match the case declaration so no clarification is needed. Registry status,
# current beneficial ownership, and licence registrations are stated as unverified and point to
# the public registers that can settle them.

MS_BANNER = "TEST DOCUMENT - PUBLIC-RECORD COMPILATION - NOT AN OFFICIAL RECORD"
MS_FOOTER = "TEST EVIDENCE | Morgan Stanley (public-record compilation) | Not an official record"
MS_ENTITY = [
    ("Legal name", "Morgan Stanley"),
    ("Registration number (Delaware file number)", "923632"),
]


def morgan_stanley():
    build("morgan_stanley_incorporation_extract.pdf", "Entity registration summary", MS_FOOTER, MS_BANNER, [
        ("Entity record", MS_ENTITY + [
            ("Jurisdiction", "Delaware, United States (US-DE)"),
            ("Legal form", "Corporation"),
            ("Date of formation", "1 October 1981"),
            ("Registered address",
             "Corporation Trust Center, 1209 Orange Street, Wilmington, DE 19801, United States "
             "(registered agent: The Corporation Trust Company)"),
            ("Legal Entity Identifier", "IGJSJL3JD5P30I6NJZ34"),
            ("SEC CIK", "0000895421"),
            ("Listing", "Common stock listed on the New York Stock Exchange (ticker MS)"),
        ]),
        ("Verification status",
         "Not verified for this case. The applicant supplied this summary instead of a certified Delaware "
         "certificate of good standing. Current status and good standing should be confirmed against the "
         "Delaware Division of Corporations (icis.corp.delaware.gov) and the GLEIF LEI record (gleif.org)."),
        ("Record provenance",
         "Compiled for local KYB workflow testing from public sources. This file is not a Delaware certificate "
         "of incorporation or good standing and was not issued by the Delaware Division of Corporations or by "
         "Morgan Stanley."),
    ])

    build("morgan_stanley_shareholder_register.pdf", "Ownership and control statement", MS_FOOTER, MS_BANNER, [
        ("Company", MS_ENTITY + [
            ("Ownership profile", "Publicly traded on the New York Stock Exchange; widely held"),
        ]),
        ("Shareholder register",
         "Not provided. A listed company's register of beneficial owners is not supplied with this application. "
         "Holders of more than 5% of the common stock report their positions to the SEC on Schedule 13D or "
         "Schedule 13G, and the company summarises them in the Principal Shareholders section of its annual "
         "proxy statement (Form DEF 14A)."),
        ("Beneficial ownership",
         "Not verified for this case. Whether any person or entity holds 25% or more of the common stock, and "
         "the current identity and percentage of each holder above 5%, should be confirmed from current SEC "
         "filings (sec.gov, CIK 0000895421)."),
        ("Control",
         "Senior managing official: Ted Pick, Chairman and Chief Executive Officer. Not verified for this case; "
         "confirm against the company's current SEC filings or its published board and leadership pages."),
    ])

    build("morgan_stanley_business_declaration.pdf", "Business and address declaration", MS_FOOTER, MS_BANNER, [
        ("Scenario notice",
         "<b>This application scenario is hypothetical.</b> Morgan Stanley has not applied to any Jeen AI test "
         "provider and did not prepare or sign this document. Entity facts are taken from public filings; the "
         "requested product and relationship details are invented for testing."),
        ("Applicant details", MS_ENTITY + [
            ("Registered address", "Corporation Trust Center, 1209 Orange Street, Wilmington, DE 19801, United States"),
            ("Operating address", "1585 Broadway, New York, NY 10036, United States"),
            ("Mailing address", "1585 Broadway, New York, NY 10036, United States"),
            ("Business type", "Financial services"),
            ("Requested product (hypothetical)", "Cross-border payments"),
        ]),
        ("Operating model (public description)",
         "Morgan Stanley is a global financial services firm operating through three business segments: "
         "Institutional Securities, Wealth Management and Investment Management."),
        ("Funds flow and licensing (hypothetical)",
         "The scenario assumes Morgan Stanley's corporate treasury requests cross-border payments to settle its "
         "own vendor invoices. Licensing basis: the applicant states that it holds its own licences, as a bank "
         "holding company and financial holding company supervised by the Federal Reserve, with subsidiaries "
         "registered with the SEC and FINRA and authorised in the United Kingdom by the FCA and PRA. No licence "
         "certificates or register extracts are attached; these claims should be confirmed on the public "
         "registers (federalreserve.gov, brokercheck.finra.org, register.fca.org.uk)."),
    ])


# --- Harder fictional packet: Helmsgate Commerce Ltd ---------------------------------------------
# Three ownership layers through a Dutch holding company, with conflicts buried in a 12-page
# annual report. Planted conflicts:
#   1. Registered office moved on 1 August 2026 (directors' report, "Other information"); the
#      extract, the report's company information page, and the declaration give the old address.
#   2. The declaration's signature block transposes the company number (19604217, not 19604271).
#   3. Post-balance-sheet note: Marco Ferri transferred 15 points of Lindqvist Holding B.V. to
#      Sofia Ferri, so his indirect interest falls from 36% to 24%, below the 25% threshold.
#   4. The declaration says Helmsgate never holds buyer or seller funds; the accounting policy and
#      cash notes show a client account holding seller money.
# Other group companies are named but never given their own identifiers or addresses, because
# extracted entity attributes carry no subject and would otherwise be read as the applicant's.

HG_BANNER = "SYNTHETIC TEST DOCUMENT - NOT AN OFFICIAL RECORD"
HG_FOOTER = "SYNTHETIC TEST EVIDENCE | Helmsgate Commerce Ltd | Not valid for legal or regulatory use"
HG_OLD_OFFICE = "Suite 4, 12 Quayside, Newcastle upon Tyne NE1 3DX, United Kingdom"
HG_NEW_OFFICE = "3rd Floor, 41 Grey Street, Newcastle upon Tyne NE1 6EE, United Kingdom"
HG_OPERATING = "Unit 2, Ouseburn Works, Newcastle upon Tyne NE6 1LH, United Kingdom"
HG_MAILING = "PO Box 7713, Newcastle upon Tyne NE99 1TX, United Kingdom"


def helmsgate():
    build("helmsgate_commerce_incorporation_extract.pdf", "Incorporation record extract", HG_FOOTER, HG_BANNER, [
        ("Entity record", [
            ("Legal name", "Helmsgate Commerce Ltd"),
            ("Company number", "19604271"),
            ("Jurisdiction", "England and Wales (GB)"),
            ("Legal form", "Private company limited by shares"),
            ("Date of incorporation", "9 August 2021"),
            ("Status on extract date", "Active"),
            ("Registered address", HG_OLD_OFFICE),
            ("Nature of business (SIC)", "47910 - Retail sale via mail order houses or via Internet"),
        ]),
        ("Officers", [
            ("Rian Okafor", "Director, appointed 9 August 2021"),
            ("Elin Lindqvist", "Director, appointed 2 March 2023"),
            ("Hannah Moyo", "Director, appointed 17 February 2025"),
        ]),
        ("Record provenance",
         "Prepared as a fictional registry-style extract for local KYB workflow testing. Extract date: "
         "15 July 2026. This file is not issued by Companies House and must not be used as real "
         "incorporation evidence."),
    ])

    build("helmsgate_commerce_shareholder_register.pdf", "Register of members", HG_FOOTER, HG_BANNER, [
        ("Company and share capital", [
            ("Legal name", "Helmsgate Commerce Ltd"),
            ("Record date", "30 June 2026"),
            ("Issued share capital", "10,000 ordinary shares of GBP 1 each; one vote per share"),
        ]),
        ("Members", [
            ("Helmsgate Group Holdings Ltd (private company, England and Wales)",
             "8,000 ordinary shares - 80% ownership and voting rights"),
            ("Rian Okafor (natural person, United Kingdom resident)",
             "2,000 ordinary shares - 20% ownership and voting rights"),
            ("Total accounted for", "10,000 shares - 100% ownership and voting rights"),
        ]),
        ("Prepared by", "Hannah Moyo, Director - fictional statement dated 30 June 2026."),
    ])

    build("helmsgate_commerce_ownership_chart.pdf", "Group ownership chart", HG_FOOTER, HG_BANNER, [
        ("Structure",
         "Level 0: Helmsgate Commerce Ltd (applicant).<br/>"
         "Level 1: Helmsgate Group Holdings Ltd, a private company in England and Wales, holds 80% of the "
         "applicant. Rian Okafor holds the remaining 20% directly.<br/>"
         "Level 2: Lindqvist Holding B.V., a Dutch private limited company, holds 100% of Helmsgate Group "
         "Holdings Ltd.<br/>"
         "Level 3: the holders of Lindqvist Holding B.V. are listed below."),
        ("Level 1 - holders of Helmsgate Commerce Ltd", [
            ("Helmsgate Group Holdings Ltd", "80% of Helmsgate Commerce Ltd"),
            ("Rian Okafor", "20% of Helmsgate Commerce Ltd"),
        ]),
        ("Level 2 - holder of Helmsgate Group Holdings Ltd", [
            ("Lindqvist Holding B.V.", "100% of Helmsgate Group Holdings Ltd"),
        ]),
        ("Level 3 - holders of Lindqvist Holding B.V.", [
            ("Elin Lindqvist (natural person, Sweden resident)", "55% of Lindqvist Holding B.V."),
            ("Marco Ferri (natural person, Italy resident)", "45% of Lindqvist Holding B.V."),
        ]),
        ("Calculated indirect interests in the applicant", grid([
            ["Person", "Path", "Interest"],
            ["Elin Lindqvist", "55% x 100% x 80%", "44%"],
            ["Marco Ferri", "45% x 100% x 80%", "36%"],
            ["Rian Okafor", "Direct", "20%"],
        ])),
        ("Declared beneficial owners",
         "Elin Lindqvist (44% indirect) and Marco Ferri (36% indirect). Rian Okafor (20% direct) is below the "
         "25% threshold but is a director and the chief executive."),
        ("Prepared by", "Hannah Moyo, Director - fictional statement dated 30 June 2026."),
    ])

    build("helmsgate_commerce_annual_report_2026.pdf",
          "Annual Report and Financial Statements for the Year Ended 31 March 2026", HG_FOOTER, HG_BANNER, [
        ("Helmsgate Commerce Ltd",
         "Registered in England and Wales. Company number 19604271. This synthetic annual report is prepared "
         "for local KYB workflow testing and has not been filed with Companies House."),
        ("Contents",
         "Company information - Strategic report - Directors' report - Statement of directors' "
         "responsibilities - Independent auditor's report - Profit and loss account - Balance sheet - "
         "Statement of changes in equity - Notes to the financial statements"),
        PAGE_BREAK,
        ("Company information", [
            ("Directors", "Rian Okafor (Chief Executive); Elin Lindqvist (Non-executive); Hannah Moyo (Finance)"),
            ("Registered office", HG_OLD_OFFICE),
            ("Trading address", HG_OPERATING),
            ("Auditor", "Brampton Hale LLP, Statutory Auditor (fictional)"),
            ("Bankers", "Keelside Bank plc (fictional)"),
        ]),
        PAGE_BREAK,
        ("Strategic report - business review",
         "Helmsgate Commerce Ltd operates helmsgate.example, an online marketplace on which independent "
         "homeware makers sell to consumers. Sellers are based in the United Kingdom, Ireland and Germany. "
         "The Company earns a commission on each completed order and a monthly listing fee from sellers. "
         "Turnover grew 41% to GBP 4.81 million as gross merchandise value rose to GBP 48.1 million."),
        ("Key performance indicators", grid([
            ["Indicator", "2026", "2025"],
            ["Gross merchandise value (GBP m)", "48.1", "34.2"],
            ["Active sellers at year end", "2,140", "1,610"],
            ["Average commission rate", "10.0%", "10.0%"],
            ["Orders completed (thousands)", "612", "455"],
        ])),
        ("Principal risks and uncertainties",
         "The directors consider the principal risks to be seller fraud and chargebacks, dependence on "
         "third-party payment processing, data protection, and consumer demand for discretionary homeware. "
         "Seller identity checks are performed at onboarding and payout details are re-verified on change."),
        ("Section 172 statement",
         "The directors have regard to the interests of sellers, buyers, employees and the Company's "
         "shareholders. During the year the board reviewed seller payout timing, dispute handling and the "
         "Company's expansion into Germany."),
        PAGE_BREAK,
        ("Directors' report - directors",
         "The directors who held office during the year and up to the date of this report were Rian Okafor, "
         "Elin Lindqvist and Hannah Moyo."),
        ("Dividends", "The directors do not recommend the payment of a dividend (2025: nil)."),
        ("Going concern",
         "The directors have reviewed cash flow forecasts for the twelve months from approval of these "
         "financial statements and are satisfied that the Company has adequate resources to continue in "
         "operation. The financial statements are therefore prepared on a going concern basis."),
        ("Employees",
         "The average number of persons employed during the year was 38 (2025: 29). The Company operates a "
         "defined contribution pension scheme."),
        ("Other information",
         "The Company renewed its principal domain names during the year and completed a penetration test of "
         "its seller dashboard. With effect from 1 August 2026 the Company changed its registered office to "
         f"{HG_NEW_OFFICE}. The Company's trading address is unchanged. The Company did not make any political "
         "donations during the year."),
        ("Disclosure of information to the auditor",
         "So far as each director is aware, there is no relevant audit information of which the Company's "
         "auditor is unaware, and each director has taken all reasonable steps to make themselves aware of "
         "such information."),
        ("Approval",
         "This report was approved by the board on 18 August 2026 and signed on its behalf by Hannah Moyo, "
         "Director."),
        PAGE_BREAK,
        ("Statement of directors' responsibilities",
         "The directors are responsible for preparing the annual report and the financial statements in "
         "accordance with applicable law and United Kingdom accounting standards, including FRS 102. The "
         "directors must not approve the financial statements unless they are satisfied that they give a true "
         "and fair view of the state of affairs of the Company and of its profit for the year."),
        ("Independent auditor's report - opinion",
         "In our opinion the financial statements give a true and fair view of the state of the Company's "
         "affairs as at 31 March 2026 and of its profit for the year then ended, and have been properly "
         "prepared in accordance with United Kingdom Generally Accepted Accounting Practice. Brampton Hale LLP "
         "(fictional), 18 August 2026."),
        PAGE_BREAK,
        ("Profit and loss account for the year ended 31 March 2026", grid([
            ["GBP", "2026", "2025"],
            ["Turnover", "4,812,300", "3,406,900"],
            ["Cost of sales", "(1,203,100)", "(918,600)"],
            ["Gross profit", "3,609,200", "2,488,300"],
            ["Administrative expenses", "(3,104,500)", "(2,301,400)"],
            ["Operating profit", "504,700", "186,900"],
            ["Interest receivable", "18,200", "4,100"],
            ["Profit before taxation", "522,900", "191,000"],
            ["Tax on profit", "(130,700)", "(47,800)"],
            ["Profit for the financial year", "392,200", "143,200"],
        ])),
        ("Balance sheet at 31 March 2026", grid([
            ["GBP", "2026", "2025"],
            ["Intangible assets (platform development)", "412,000", "298,000"],
            ["Debtors", "356,800", "241,300"],
            ["Cash at bank - own funds", "1,027,500", "612,900"],
            ["Cash held on behalf of sellers", "1,238,400", "874,100"],
            ["Amounts owed to sellers", "(1,238,400)", "(874,100)"],
            ["Other creditors due within one year", "(571,300)", "(319,400)"],
            ["Net assets", "1,225,000", "832,800"],
            ["Called-up share capital", "10,000", "10,000"],
            ["Share premium", "390,000", "390,000"],
            ["Profit and loss account", "825,000", "432,800"],
            ["Shareholders' funds", "1,225,000", "832,800"],
        ])),
        PAGE_BREAK,
        ("Statement of changes in equity",
         "Shareholders' funds increased from GBP 832,800 to GBP 1,225,000, reflecting the profit for the year "
         "of GBP 392,200. No shares were issued and no dividends were paid during the year."),
        ("Note 1 - Basis of preparation",
         "These financial statements are prepared under the historical cost convention in accordance with FRS "
         "102 Section 1A. The presentation currency is pounds sterling."),
        ("Note 2 - Turnover",
         "Turnover comprises commission on completed orders, recognised when the buyer's order is dispatched, "
         "and monthly seller listing fees, recognised over the month to which they relate."),
        ("Note 3 - Seller balances",
         "Buyer payments are processed by a third-party card acquirer and settled to the Company. Amounts "
         "collected from buyers and not yet remitted to sellers are held in a designated client bank account "
         "in the Company's name until the seller payout date, which is normally seven days after dispatch. "
         "These balances are presented as cash held on behalf of sellers, with a corresponding liability "
         "for amounts owed to sellers."),
        ("Note 4 - Intangible assets",
         "Development costs of the marketplace platform are capitalised when technical feasibility is "
         "demonstrated and amortised on a straight-line basis over three years."),
        PAGE_BREAK,
        ("Note 5 - Turnover by destination of seller", grid([
            ["GBP", "2026", "2025"],
            ["United Kingdom", "3,368,600", "2,555,200"],
            ["Ireland", "721,800", "511,000"],
            ["Germany", "721,900", "340,700"],
            ["Total", "4,812,300", "3,406,900"],
        ])),
        ("Note 6 - Operating profit",
         "Operating profit is stated after charging amortisation of GBP 131,400 (2025: GBP 96,200), card "
         "processing fees of GBP 688,300 (2025: GBP 497,100) and auditor's remuneration of GBP 24,000 "
         "(2025: GBP 21,000)."),
        ("Note 7 - Taxation",
         "The tax charge is based on the United Kingdom corporation tax rate of 25% (2025: 25%) applied to "
         "taxable profit after allowable deductions."),
        ("Note 8 - Debtors",
         "Debtors comprise card acquirer settlements in transit of GBP 214,600 (2025: GBP 150,900), "
         "prepayments of GBP 96,700 (2025: GBP 62,300) and other debtors of GBP 45,500 (2025: GBP 28,100)."),
        PAGE_BREAK,
        ("Note 9 - Cash at bank",
         "Cash at bank includes GBP 1,238,400 (2025: GBP 874,100) held in the designated seller client account "
         "described in note 3. This amount is not available for the Company's general purposes."),
        ("Note 10 - Creditors",
         "Creditors due within one year comprise amounts owed to sellers of GBP 1,238,400 (2025: GBP 874,100), "
         "corporation tax of GBP 130,700 (2025: GBP 47,800), trade creditors and accruals of GBP 312,800 "
         "(2025: GBP 201,900), and other taxation and social security of GBP 127,800 (2025: GBP 69,700)."),
        ("Note 11 - Share capital",
         "Allotted, called up and fully paid: 10,000 ordinary shares of GBP 1 each (2025: 10,000). At 31 March "
         "2026 Helmsgate Group Holdings Ltd held 8,000 shares, representing 80% of Helmsgate Commerce Ltd, "
         "and Rian Okafor held 2,000 shares, representing 20% of Helmsgate Commerce Ltd."),
        ("Note 12 - Related party transactions",
         "During the year the Company purchased product photography services of GBP 38,400 (2025: GBP 22,000) "
         "from a business owned by a close family member of Rian Okafor, on normal commercial terms. No "
         "balance was outstanding at the year end."),
        PAGE_BREAK,
        ("Note 13 - Parent undertakings and controlling party",
         "The immediate parent undertaking is Helmsgate Group Holdings Ltd, which holds 80% of the Company. "
         "Lindqvist Holding B.V., a private limited company incorporated in the Netherlands, holds 100% of "
         "Helmsgate Group Holdings Ltd and is the ultimate parent undertaking. At 31 March 2026 Elin Lindqvist "
         "held 55% of Lindqvist Holding B.V. and Marco Ferri held 45% of Lindqvist Holding B.V. The directors "
         "consider that there is no single ultimate controlling party."),
        ("Note 14 - Events after the reporting date",
         "On 3 July 2026 Marco Ferri transferred part of his shareholding in Lindqvist Holding B.V. to Sofia "
         "Ferri. Following the transfer, Marco Ferri holds 30% of Lindqvist Holding B.V. and Sofia Ferri holds "
         "15% of Lindqvist Holding B.V.; Elin Lindqvist's 55% holding is unchanged. The transfer does not "
         "affect the Company's immediate ownership and is a non-adjusting event."),
    ])

    build("helmsgate_commerce_business_declaration.pdf", "Business and address declaration", HG_FOOTER, HG_BANNER, [
        ("Applicant details", [
            ("Legal name", "Helmsgate Commerce Ltd"),
            ("Company number", "19604271"),
            ("Registered address", HG_OLD_OFFICE),
            ("Operating address", HG_OPERATING),
            ("Mailing address", HG_MAILING),
            ("Business type", "Marketplace"),
            ("Requested product", "Cross-border payouts"),
            ("Operating jurisdictions", "United Kingdom, Ireland, Germany"),
        ]),
        ("Operating model",
         "Helmsgate Commerce Ltd operates an online marketplace for independent homeware makers. Sellers in "
         "the United Kingdom, Ireland and Germany list products; consumers buy through the Helmsgate website "
         "and app. The applicant requests cross-border payouts so that Irish and German sellers are paid in "
         "euros."),
        ("Seller onboarding",
         "The applicant collects each seller's legal name, registration or tax identifier, and payout bank "
         "details, verifies business sellers against the relevant company registry, and re-verifies payout "
         "details whenever they change. This statement is a claim by the applicant; control evidence is not "
         "attached."),
        ("Funds flow and licensing",
         "Buyer payments are collected and held by our regulated payment partner until payout. Helmsgate does "
         "not receive or hold buyer or seller funds at any time and does not claim to hold a financial-services "
         "licence. Expected payout volume: approximately GBP 4.5 million per month to about 2,100 sellers."),
        ("Ownership summary",
         "Helmsgate Group Holdings Ltd holds 80% and Rian Okafor holds 20%. The ultimate beneficial owners are "
         "Elin Lindqvist and Marco Ferri through Lindqvist Holding B.V.; see the group ownership chart dated "
         "30 June 2026."),
        PAGE_BREAK,
        ("Declaration",
         "I confirm that the information in this declaration is complete and accurate, and I will notify the "
         "provider of any change to the Company's ownership, directors, addresses or business model."),
        ("Signature block", [
            ("Signed for and on behalf of", "Helmsgate Commerce Ltd (company number 19604217)"),
            ("Name", "Hannah Moyo"),
            ("Role", "Director"),
            ("Date", "20 September 2026"),
        ]),
        ("Record provenance", "Fictional declaration prepared for synthetic KYB testing only."),
    ])


# --- Harder real-company packet: Morgan Stanley --------------------------------------------------
# Every statement about Morgan Stanley comes from its public filings or MUFG's, checked 26 September
# 2026. Two kinds of conflict are buried:
#   Real, from public data: MUFG's stake is 24.0% (2026 proxy), 23.95% (13D/A No. 22) and 24.12%
#   (13D/A No. 23). It moves toward 25% because buybacks shrink the share count and because
#   the filings include managed shares that MUFG disclaims.
#   Planted in the hypothetical application form only: the head office given as the registered
#   office, the LEI of the subsidiary Morgan Stanley & Co. LLC instead of the parent's, and a
#   signature block for Morgan Stanley & Co. LLC. Together they imply the form was filled in from
#   the broker-dealer's records, so the analyst must settle which legal entity is applying.

MSF_SEC = "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&amp;CIK=0000895421"


def morgan_stanley_full():
    build("morgan_stanley_full_incorporation_extract.pdf", "Entity registration summary", MS_FOOTER, MS_BANNER, [
        ("Entity record", MS_ENTITY + [
            ("Jurisdiction", "Delaware, United States (US-DE)"),
            ("Legal form", "Corporation"),
            ("Date of formation", "1 October 1981"),
            ("Registered address", "Corporation Trust Center, 1209 Orange Street, Wilmington, DE 19801, United States"),
            ("Registered agent", "The Corporation Trust Company"),
            ("Legal Entity Identifier", "IGJSJL3JD5P30I6NJZ34"),
            ("Employer identification number", "36-3145972"),
            ("SEC CIK", "0000895421"),
        ]),
        ("Sources",
         "GLEIF LEI record IGJSJL3JD5P30I6NJZ34 (registration authority RA000602, Delaware Division of "
         f"Corporations) and the SEC EDGAR company record, {MSF_SEC}. Checked 26 September 2026."),
        ("Record provenance",
         "Compiled for local KYB workflow testing from the public sources above. This file is not a Delaware "
         "certificate of incorporation or good standing and was not issued by the Delaware Division of "
         "Corporations or by Morgan Stanley."),
    ])

    build("morgan_stanley_full_public_filings_digest.pdf", "Public Filings Digest", MS_FOOTER, MS_BANNER, [
        ("About this digest",
         "A test-data compilation of facts about Morgan Stanley from its Form 10-K for the year ended 31 "
         "December 2025 (filed 19 February 2026), its 2026 proxy statement (Form DEF 14A), Exhibit 21 to the "
         "10-K, Schedule 13D amendments filed by Mitsubishi UFJ Financial Group, Inc., and the GLEIF LEI "
         "register. Each section names its source. Figures are as stated in the source on the date shown."),
        ("Sources",
         f"SEC EDGAR, CIK 0000895421: {MSF_SEC}. 2026 proxy statement: "
         "https://www.sec.gov/Archives/edgar/data/895421/000114036126012975/ny20058185x1_def14a.htm. "
         "GLEIF: https://api.gleif.org/api/v1/lei-records/IGJSJL3JD5P30I6NJZ34. All checked 26 September 2026."),
        PAGE_BREAK,
        ("1. Registrant information (Form 10-K cover page)", [
            ("Registrant name", "Morgan Stanley"),
            ("State of incorporation", "Delaware"),
            ("IRS employer identification number", "36-3145972"),
            ("SEC file number", "1-11758"),
            ("Principal executive offices", "1585 Broadway, New York, NY 10036"),
            ("Common stock", "Par value USD 0.01, listed on the New York Stock Exchange, symbol MS"),
            ("Shares outstanding", "1,587,860,206 shares of common stock at 31 January 2026"),
            ("Public float", "Approximately USD 217.97 billion at 30 June 2025"),
        ]),
        ("2. Business overview (Form 10-K, Business)",
         "Morgan Stanley was originally incorporated under the laws of Delaware in 1981; its predecessor "
         "companies date back to 1924. It is a financial holding company regulated by the Board of Governors "
         "of the Federal Reserve System under the Bank Holding Company Act of 1956. It conducts its business "
         "from headquarters in and around New York City, regional offices and branches."),
        PAGE_BREAK,
        ("3. Business segments (Form 10-K)",
         "The firm reports three segments. Institutional Securities serves corporations, governments, "
         "financial institutions and ultra-high net worth clients with investment banking, sales and trading, "
         "lending and research. Wealth Management serves individual investors, businesses and institutions "
         "through Advisor-Led, Self-Directed and Workplace channels. Investment Management offers investment "
         "strategies and products across public and private markets to institutional and intermediary "
         "clients."),
        ("4. Selected financial information (Form 10-K, USD millions unless stated)", grid([
            ["Measure", "2025", "2024"],
            ["Net revenues", "70,645", "61,761"],
            ["Earnings applicable to common shareholders", "16,249", "12,800"],
            ["Earnings per diluted common share (USD)", "10.21", "7.95"],
            ["Total assets", "1,420,270", "1,215,071"],
            ["Deposits", "415,523", "376,007"],
            ["Common equity", "101,882", "94,761"],
            ["Worldwide employees (thousands)", "83", "80"],
            ["Client assets (USD billions)", "9,276", "7,860"],
            ["Common Equity Tier 1 capital ratio - Standardized", "15.0%", "15.9%"],
        ])),
        PAGE_BREAK,
        ("5. Supervision and regulation (Form 10-K)",
         "As a financial holding company, Morgan Stanley is supervised by the Federal Reserve. Its primary US "
         "broker-dealer subsidiaries, Morgan Stanley &amp; Co. LLC and Morgan Stanley Smith Barney LLC, are "
         "registered with the SEC and are members of FINRA. Morgan Stanley &amp; Co. International plc, a "
         "London-based broker-dealer subsidiary, is subject to the capital requirements of the Prudential "
         "Regulation Authority. Its US bank subsidiaries are national banks supervised by the Office of the "
         "Comptroller of the Currency."),
        ("6. Significant subsidiaries (Exhibit 21, at 31 December 2025)",
         "Exhibit 21 lists the parent company, Morgan Stanley, and 20 subsidiaries, including Morgan Stanley &amp; Co. LLC, Morgan Stanley Smith Barney "
         "LLC, Morgan Stanley Bank, N.A., Morgan Stanley Private Bank, National Association, Morgan Stanley "
         "Finance LLC, Morgan Stanley Europe SE, Morgan Stanley MUFG Securities Co., Ltd. and Morgan Stanley "
         "&amp; Co. International plc. Each is a separate legal entity with its own registration and, where it "
         "has one, its own LEI."),
        PAGE_BREAK,
        ("7. Principal shareholders (2026 proxy statement, page 113)", grid([
            ["Holder", "Shares", "Percent", "Source filing"],
            ["Mitsubishi UFJ Financial Group, Inc.", "380,010,887", "24.0%", "13D/A, 4 Nov 2025"],
            ["State Street Corporation", "114,005,198", "7.2%", "13G/A, 30 Jan 2024"],
            ["The Vanguard Group", "109,040,040", "6.9%", "13G/A, 13 Feb 2024"],
            ["BlackRock, Inc.", "90,496,803", "5.7%", "13G/A, 31 Jan 2024"],
        ])),
        ("Basis of the proxy percentages",
         "The proxy computes each percentage from the 1,581,386,814 shares outstanding at the 16 March 2026 "
         "record date and the holding reported in the source filing. The State Street, Vanguard and BlackRock "
         "positions are as of December 2023. No natural person is listed as a principal shareholder."),
        PAGE_BREAK,
        ("8. MUFG Schedule 13D amendments in 2026", grid([
            ["Amendment", "Shares reported", "Percent", "Shares outstanding used"],
            ["No. 22, filed 13 April 2026", "380,307,520", "23.95%", "1,587,860,206 at 31 Jan 2026"],
            ["No. 23, filed 15 July 2026", "380,511,118", "24.12%", "1,577,284,817 at 30 Apr 2026"],
        ])),
        ("Managed shares",
         "Each amendment includes shares that MUFG affiliates hold solely in a fiduciary capacity, as trustee "
         "of trust accounts or manager of investment funds and managed accounts: 3,222,353 shares in No. 22 "
         "and 3,425,951 shares in No. 23. MUFG disclaims beneficial ownership of these managed shares. "
         "Excluding them, MUFG held 377,085,167 shares directly in both amendments."),
        ("Investor agreement",
         "On 13 April 2026 MUFG and Morgan Stanley signed the Eighth Amendment to their Investor Agreement. It "
         "extends MUFG's standstill provisions and preemptive rights until the earlier of 13 October 2028 or "
         "the date on which MUFG's economic interest falls below 10%."),
        PAGE_BREAK,
        ("9. Directors, officers and corporate secretary",
         "Ted Pick is Chairman and Chief Executive Officer; he became Chief Executive Officer in January 2024 "
         "and Chairman in January 2025. Sharon Yeshaya is Executive Vice President and Chief Financial Officer "
         "(Form 10-K). Martin M. Cohen signed the 2026 proxy notice as Corporate Secretary on 2 April 2026."),
        ("10. Common shares outstanding over time", grid([
            ["Date", "Shares outstanding", "Source"],
            ["31 December 2025", "About 1,583 million", "Form 10-K, selected data"],
            ["31 January 2026", "1,587,860,206", "Form 10-K cover page"],
            ["16 March 2026", "1,581,386,814", "2026 proxy statement"],
            ["30 April 2026", "1,577,284,817", "Form 10-Q, as cited in 13D/A No. 23"],
        ])),
        ("Share repurchases",
         "Morgan Stanley repurchases its common stock under a board-authorised programme. A holder whose "
         "share count is unchanged therefore owns a slightly larger percentage as the number of shares "
         "outstanding falls."),
    ])

    build("morgan_stanley_full_business_declaration.pdf", "Business and address declaration", MS_FOOTER, MS_BANNER, [
        ("Scenario notice",
         "<b>This application form is hypothetical.</b> Morgan Stanley has not applied to any Jeen AI test "
         "provider and did not prepare or sign it. It deliberately contains the kinds of errors an applicant "
         "makes when completing a form from the wrong records, so that the review can be tested."),
        ("Applicant details", [
            ("Legal name", "Morgan Stanley"),
            ("Registration number (Delaware file number)", "923632"),
            ("Legal Entity Identifier", "9R7GPTSO7KV3UQJZQ078"),
            ("Registered address", "1585 Broadway, New York, NY 10036, United States"),
            ("Operating address", "1585 Broadway, New York, NY 10036, United States"),
            ("Mailing address", "1585 Broadway, New York, NY 10036, United States"),
            ("Business type", "Financial services"),
            ("Requested product (hypothetical)", "Cross-border payments"),
        ]),
        ("Operating model",
         "Global financial services firm operating through Institutional Securities, Wealth Management and "
         "Investment Management. The corporate treasury function requests cross-border payments to settle "
         "the firm's own vendor invoices in the United Kingdom and the European Union."),
        ("Ownership summary",
         "Publicly listed on the New York Stock Exchange. The largest shareholder is Mitsubishi UFJ Financial "
         "Group, Inc., which holds less than 25%. See the company's latest proxy statement."),
        ("Licensing",
         "Financial holding company supervised by the Federal Reserve. Licence certificates and register "
         "extracts are not attached."),
        PAGE_BREAK,
        ("Declaration",
         "The signatory confirms that the information in this form is complete and accurate and that the "
         "provider will be told of any change to ownership, addresses or business model."),
        ("Signature block", [
            ("Signed for and on behalf of", "Morgan Stanley &amp; Co. LLC"),
            ("Signatory", "Authorised signatory, Corporate Treasury (name omitted from test packet)"),
            ("Date", "21 September 2026"),
        ]),
    ])


# --- Fictional packet: Brackwater Trading Ltd (advisory observation acceptance) -----------------
# Each planted situation should produce one advisory observation and leave the computed rows alone:
#   Entity
#   - near_miss_equivalence: the declaration's registered address says "Ste 4", every document says
#     "Suite 4" (a conflict row whose values name the same unit).
#   - internal_consistency: the extract gives incorporation on 12 June 2024, but the declaration says
#     the company has traded since March 2022; the company number has 7 digits, not the usual 8.
#   - visual_check: the incorporation extract carries a drawn seal and signature, not text.
#   Ownership (direct holders of the applicant: 45% + 20% + 24.9% named, 10.1% in treasury)
#   - unexplained_remainder: 101 treasury shares have no named holder.
#   - incomplete_chain: the Varga Family Trust names no trustee or beneficiary; Northgate Nominees is
#     owned by a BVI company whose owners are not disclosed.
#   - control_beyond_shareholding: the Varga Family Trust may appoint three of five directors.
#   - person_name_match: the agreement is signed by "J. A. Okonkwo"; the register names
#     "Jane Adaeze Okonkwo" at the same address.
#   - risk_pattern: Northgate holds 24.9%, just under 25%, through Cyprus and the BVI.

BW_BANNER = "SYNTHETIC TEST DOCUMENT - NOT AN OFFICIAL RECORD"
BW_FOOTER = "SYNTHETIC TEST EVIDENCE | Brackwater Trading Ltd | Not valid for legal or regulatory use"
BW_REGISTERED = "Suite 4, 18 Harbour Row, Bristol BS1 4RN, United Kingdom"
BW_OPERATING = "Unit 11, Temple Quay Works, Bristol BS1 6DG, United Kingdom"
BW_MAILING = "PO Box 4410, Bristol BS99 1AB, United Kingdom"


def brackwater():
    build("brackwater_trading_incorporation_extract.pdf", "Incorporation record extract", BW_FOOTER, BW_BANNER, [
        ("Entity record", [
            ("Legal name", "Brackwater Trading Ltd"),
            ("Company number", "0472913"),
            ("Jurisdiction", "England and Wales (GB)"),
            ("Legal form", "Private company limited by shares"),
            ("Date of incorporation", "12 June 2024"),
            ("Status on extract date", "Active"),
            ("Registered address", BW_REGISTERED),
            ("Directors", "Jane Adaeze Okonkwo (appointed 12 June 2024); Istvan Varga (appointed 1 July 2025)"),
        ]),
        ("Record provenance",
         "Prepared as a fictional registry-style extract for local KYB workflow testing. Extract date: "
         "20 September 2026. Sealed and signed by the company secretary below. This file is not issued by "
         "Companies House and must not be used as real incorporation evidence."),
    ], seal=(("BRACKWATER", "TRADING LTD"), "Company secretary"))

    build("brackwater_trading_shareholder_register.pdf", "Register of members", BW_FOOTER, BW_BANNER, [
        ("Company and share capital", [
            ("Legal name", "Brackwater Trading Ltd"),
            ("Record date", "30 June 2026"),
            ("Issued share capital", "1,000 ordinary shares; one vote per share"),
        ]),
        ("Members", grid([
            ["Member", "Address", "Shares", "Holding"],
            ["Jane Adaeze Okonkwo", "7 Clifton Park Road, Bristol BS8 3HL", "450", "45%"],
            ["Varga Family Trust", "c/o 18 Harbour Row, Bristol BS1 4RN", "200", "20%"],
            ["Northgate Nominees (Cyprus) Ltd", "Limassol, Cyprus", "249", "24.9%"],
            ["Held in treasury (no member)", "-", "101", "-"],
        ])),
        ("Notes",
         "Named members hold 899 of 1,000 issued shares. The remaining 101 shares are recorded as held in "
         "treasury; no member is entered for them. The register does not record the trustees or "
         "beneficiaries of the Varga Family Trust."),
    ])

    build("brackwater_trading_ownership_chart.pdf", "Group ownership chart", BW_FOOTER, BW_BANNER, [
        ("Structure",
         "Level 0: Brackwater Trading Ltd (applicant).<br/>"
         "Level 1: Jane Adaeze Okonkwo holds 45%; Varga Family Trust holds 20%; "
         "Northgate Nominees (Cyprus) Ltd holds 24.9%.<br/>"
         "Level 2: Tiderock Holdings Ltd (British Virgin Islands) holds 100% of Northgate Nominees (Cyprus) Ltd."),
        ("Undisclosed parties",
         "The shareholders of Tiderock Holdings Ltd are not disclosed in this packet. The trustees, settlor and "
         "beneficiaries of the Varga Family Trust are not disclosed in this packet."),
        ("Prepared by", "Jane Adaeze Okonkwo, Director - fictional statement dated 30 June 2026."),
    ])

    build("brackwater_trading_shareholders_agreement.pdf", "Shareholders' agreement (extract)", BW_FOOTER, BW_BANNER, [
        ("Parties",
         "Brackwater Trading Ltd; Jane Adaeze Okonkwo; the Varga Family Trust; Northgate Nominees (Cyprus) Ltd. "
         "Dated 1 July 2025."),
        ("Clause 4 - Board composition",
         "The board shall have five directors. For so long as the Varga Family Trust holds any shares, it may "
         "appoint and remove three directors, and no dividend may be declared without the written consent of a "
         "director appointed by the Varga Family Trust."),
        ("Execution",
         "Signed by J. A. Okonkwo of 7 Clifton Park Road, Bristol BS8 3HL; signed for and on behalf of the Varga "
         "Family Trust by its trustee (name not stated); signed for Northgate Nominees (Cyprus) Ltd by its "
         "nominee director."),
    ])

    build("brackwater_trading_business_declaration.pdf", "Business and address declaration", BW_FOOTER, BW_BANNER, [
        ("Applicant details", [
            ("Legal name", "Brackwater Trading Ltd"),
            ("Company number", "0472913"),
            ("Registered address", "Ste 4, 18 Harbour Row, Bristol BS1 4RN, United Kingdom"),
            ("Operating address", BW_OPERATING),
            ("Mailing address", BW_MAILING),
            ("Business type", "Marketplace"),
            ("Requested product", "Merchant payouts"),
        ]),
        ("Trading history",
         "Brackwater Trading Ltd has traded since March 2022, connecting independent importers of kitchenware "
         "with UK retailers and settling retailer payments to importers."),
        ("Declaration", "Prepared by Jane Adaeze Okonkwo, Director, on 20 September 2026 for synthetic KYB testing only."),
    ])


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    aldermoor()
    morgan_stanley()
    helmsgate()
    morgan_stanley_full()
    brackwater()
    for path in sorted(OUT.glob("*.pdf")):
        print(path.relative_to(OUT.parent.parent))
