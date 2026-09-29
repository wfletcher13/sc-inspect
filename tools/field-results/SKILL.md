---
name: sc-field-results
description: After a smoke control field test, turn the Pocket voice-recorder transcript(s), the filled-in pretest checklist and the photo index into a proposed post-test SC Inspect JSON patch with a review table. Use between the field test and the Smoke Control Inspection Test Results Report (sc-inspection-results). Never overwrites the building record.
---

# Field results to SC Inspect JSON

Use this skill when the inspector has finished a field test and wants the results entered in the building record from the recording and notes, instead of typing them from field notes.

## Inputs to collect

1. The building's **pre-test SC Inspect JSON**: the export attached to the message, or `projects/<id>.json` in the data repository.
2. One or more **transcripts** from the Pocket recorder, as a text or JSON export.
3. Optionally, the filled-in **pretest checklist** (CSV or XLSX) produced by sc-field-checklists.
4. Optionally, a **photo index** (CSV, XLSX or JSON with `file`, `caption` and optionally `time`) for the checklist and FSCP panel photos. If there are photos but no index, write one caption per photo stating what it shows (device, panel state, stair and level, reading), and do not guess anything that is not visible.

## Run

The tool lives in the sc-inspect repository at `tools/field-results`. It needs Node 18+ and has no dependencies.

```bash
node tools/field-results/cli.js --pretest <record.json> --transcript <t1> [--transcript <t2>] \
  [--checklist <checklist.xlsx>] [--photos <photo-index.csv>] --out-dir <work dir>
```

Do not pass `--llm` unless the inspector asks for the model-assisted reading. It is off by default. When it is on, suggestions are re-verified by code and never outrank the rules.

## Then

1. Open `*.field-results-review.md` and show the inspector the **Summary**, the **Open items**, and any **Validation errors**. Do not fill open items yourself. Ask the inspector, one short question per item, and record only what they confirm.
2. Deficiency descriptions are the spoken wording or a generated sentence. Rewrite them into report language only when asked. Corrective action is left blank for the engineer.
3. Once the inspector approves, apply `patch` from `*.proposed-patch.json` to the record, or have them import `*.proposed-post-test.json` in SC Inspect as a new building. Then run sc-inspection-results on the approved record.
4. Never write the outputs to the public sc-inspect repository.

## Rules the tool follows (so you can explain them)

- Values are filled only when the target (device test, zone column, matrix cell, or shaft/door/level) and the value are clear, and rated high or medium. See "Confidence" in `tools/field-results/README.md`.
- Anything unclear, asked as a question, contradicted by another source, or different from a value already in the record is left empty and listed as an open item, with the excerpt.
- The source JSON is never modified.
- Measured airflow and equipment states have no field in schema v2. They are reported for the narrative only.
