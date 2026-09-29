# Field results to SC Inspect JSON

This tool turns what was said and written during a field test into a **proposed** post-test SC Inspect record. It saves typing the results in by hand from field notes. It never changes the source record. Every value it fills in carries its source, the transcript excerpt and a confidence level. Anything unclear is left empty and listed as an open item.

## Where it fits

```
intake JSON -> test plan / BOD -> pretest checklists -> FIELD TEST -> field results to JSON (this tool) -> review -> results report
                (sc-inspection-test-plan)  (sc-field-checklists)   (app + Pocket recorder)                        (sc-inspection-results)
```

A **pre-test** JSON is the building record exported from SC Inspect (Reports > Export JSON, or `projects/<id>.json` in the data repository) before testing. It holds the configuration (`info`, `systems`, `stairwells`, `hoistways`, `equipment`, `sequence`), and its result sections are empty. A **post-test** JSON is the same record with these sections filled:

| Section | Key | Values | App screen |
|---|---|---|---|
| `seqResults` | `<tag>_<test index>` per device (from `getSeqTests`), plus `v1`-`v18`, `f3`, `e1`-`e4`, `i2` | `pass` / `fail` / `na` | Sequence tests (Appendix A-1, Tables 1 and 2) |
| `matrixResults` | `<level>_<column key>` (for example `8_fan_SPF-1`, `8_corr_dampers`) | `pass` / `fail` / `na` | Floor matrix (A-2) |
| `zoneResults` | `<zone>_fans`, `_dampers`, `_isolate` | `pass` / `fail` / `na` | Lower-level zones (A-2(b)) |
| `floors` | `<pressure prefix>_<level>` (for example `Stair A_12`, `VEST_Stair_A_12`, `EL_EL-1_11`, `CORR_9`) | `{ dp, brk, swg, cl }`: ΔP in. w.g., break-away and swing force in lbf, close/latch `pass`/`fail` | Pressure & door force (A-2b) |
| `deficiencies` | list | `{ id, loc, sev: Deficiency/Observation/Note, desc, action, photos }` | Deficiencies (Appendix C) |

The results report skill and the app's field summary read exactly these sections. The tool does not keep its own copy of these rules. It loads the data-model script from `index.html` and uses the app's own `normalizeProject`, `getSeqTests`, `getMatrixCols`, `getFloors`, `pressBlocks` and `getZones`, so the keys it writes always match the app.

## Quick start

Requires Node 18 or newer. No `npm install` is needed because the tool has no dependencies.

```bash
node tools/field-results/cli.js \
  --pretest ~/jobs/example-tower/pSYNTH0001.json \
  --transcript ~/jobs/example-tower/pocket-part1.txt \
  --transcript ~/jobs/example-tower/pocket-part2.json \
  --checklist ~/jobs/example-tower/fans-dampers-checklist.xlsx \
  --photos ~/jobs/example-tower/photo-index.csv
```

It writes three files to `<pretest name>.field-results/` next to the pre-test JSON (use `--out-dir` to choose another folder):

| File | What it is |
|---|---|
| `*.field-results-review.md` | **Start here.** The review table: every proposed value with source file and line, timestamp, speaker, excerpt, confidence and how it was read. It also has status by device, zone, matrix row and pressure reading, measurements with no field in the record, proposed deficiencies, open items, items stated as not tested, and checklist rows that did not map. |
| `*.proposed-patch.json` | Only the new values (`patch`, which has the same shape as the record sections above), plus `evidence`, `openItems`, `measurements`, `notTested`, `validation`, and the source file's SHA-256 checksum. |
| `*.proposed-post-test.json` | The pre-test record with the patch applied. In SC Inspect, use Reports > Record & data transfer > **Import JSON as new building** to open it as a separate building. Importing never replaces the original. |

Exit code `0` means the files were written and are valid, `2` means they were written but failed validation (the errors are listed in the review), and `1` means an error occurred. An existing output is only replaced with `--force`. The tool refuses to write to any of its input paths.

**Do not commit outputs to this repository.** It is public and served by GitHub Pages. `.gitignore` excludes the output file names.

## Inputs

**Pre-test JSON** (required). An SC Inspect export, either the plain record or `{ "project": ... }`.

**Transcripts** (one or more, required). You can pass several files, for example one per recording. Context (current level, stair, device) is never carried from one file to the next. Supported shapes:

- Text with timestamps and speakers: `[00:01:05] Speaker 1: ...`, `00:01:05 Speaker 1: ...`, `Speaker 1 (00:01:05): ...`
- A header line (`Speaker 1  00:01:05`) with the text on the following lines
- `Speaker: text` lines, plain lines, SRT/VTT blocks, and wall-clock times such as `10:14 AM`
- JSON exports: a list of segments at the top level or under `segments`, `utterances`, `transcript`, `results` and similar keys. Text keys (`text`, `content`, `transcript`, `words[]`), start keys (`start`, `startTime`, `start_ms`, `offset`, `timestamp`), and speaker keys (`speaker`, `speaker_label`, or an id resolved through a `speakers` map) are detected automatically.

**Checklist** (optional, CSV or XLSX). This is a filled-in vendor pretest checklist. The tool finds the header row and needs at least a result column. It recognises these columns:

| Field | Header names |
|---|---|
| Device | `Tag`, `Device`, `Equipment`, `Unit`, `Component` |
| Item | `Test / Check`, `Test`, `Check`, `Item`, `Description`, `Requirement` |
| Result | `Result`, `Status`, `Pass/Fail`, `Y/N`, `Verified`, `Complete` |
| Level | `Floor`, `Level` |
| Location | `Location`, `Area`, `Shaft`, `Stair`, `Zone` |
| Notes | anything containing `Note`, `Comment`, `Remark` |

Answers are read as follows: `Y` / `Yes` / `Pass` / `OK` / ✓ is pass, `N` / `No` / `Fail` is fail, `N/A` is na, and a blank cell is ignored. Any other answer becomes an open item. A row is mapped to a device test when its device tag and wording match exactly one test, or to a Table 1/2 item when its wording clearly matches one label. Unmapped rows are listed. A failed row with a comment becomes a proposed deficiency. Checklist answers are vendor-reported, not witnessed, so they are never rated above medium. If a checklist answer disagrees with the recording, the field is left empty.

**Photo index** (optional; CSV, XLSX or JSON list). Columns: `file`, `caption`, and optionally `time`. Captions go through the same rules as the recording, one caption at a time, and are rated medium at most. Photos whose caption names the same device, zone, or stair and level as a proposed deficiency are listed next to it. The tool does not read the images themselves, so write the panel state or reading into the caption (for example "FSCP: SPF-1 ON, SPF-2 ON").

## What is read, and how to say it

All matching uses the building's own vocabulary from the pre-test JSON: equipment tags (`SPF-1`, "SPF 1", "S.P.F. one"), levels in range (`level 12`, `12th floor`, `lobby`), stairwells (`Stair A`, "stairwell A"), hoistways (`EL-1`, "elevator 1"), `corridor`, and zones (`zone 11`). Numbers can be spoken or typed: "point zero eight", "twenty two pounds", "12,500 CFM", "12.5k CFM", "15 Pa" (converted to 0.06 in. w.g.), "133 newtons" (converted to lbf).

| Say | Becomes |
|---|---|
| "SPF-1 manual override on, pass." | `seqResults.SPF-1_0 = pass` (high) |
| "SPF-1 VFD power loss." ... "Fault showed up. Pass." | `seqResults.SPF-1_3 = pass` (medium: the result came in the next sentence) |
| "Smoke detector on level 8." ... "SPF-1 pass." ... "Corridor dampers failed." ... "Reset the panel." | `matrixResults.8_fan_SPF-1 = pass`, `8_corr_dampers = fail` (the floor is in alarm until the panel is reset) |
| "Zone 11 purge, fans started, pass." / "Zone 11 adjacent zones isolated, pass." | `zoneResults.11_fans` / `11_isolate = pass` |
| "Level 12, stair A, 0.08 in wc, break 22 pounds, swing 12 pounds, closed and latched." | `floors["Stair A_12"] = { dp: 0.08, brk: 22, swg: 12, cl: pass }` (high) |
| "Stair B, 0.04 in wc ..." (level said earlier) | `floors["Stair B_12"].dp` (medium: the level came from an earlier sentence, within 5 minutes) |
| "Write that up as a deficiency, ..." / "Observation: ..." / "Note: ..." | new deficiency with the spoken wording, severity from the cue word, and location from the sentence or context |
| "EPF-1 disconnect not tested, locked out." | listed as stated not tested; no value is written |
| "SPF-1 measured airflow 12,500 CFM." / "SEF-1 is running." | listed under measurements (schema v2 has no field for them), with the design CFM beside the reading |

Deficiencies are also proposed for every accepted reading below 0.05 in. w.g., every door force over 30 lbf, every door that did not latch, and every failed result, unless a spoken or checklist deficiency already covers the same place or device. Corrective action is always left blank for the engineer to write.

Helpful habits when dictating: say the level, shaft and door once before a run of readings; say "break" and "swing" for door forces; say "pass" or "fail" in the same sentence as the device and the test; with a vestibule system, say "stair door" or "vestibule door".

## When a field is left empty (open items)

A field is never guessed. The tool leaves it empty and lists it with the reason and the excerpt in any of these cases:

- The device, test, zone column, shaft, door or level is not identified, or more than one fits.
- The level is outside the building's floor range.
- A door force is given without "break" or "swing".
- A number without a unit falls outside the plausible range, or no pressure or force word goes with it.
- The value was asked as a question ("is that 0.05?").
- Two statements, two transcripts, or the recording and the checklist disagree.
- The pre-test JSON already holds a different value. Nothing already recorded is overwritten, and matching values are listed as unchanged.
- A result is given with nothing to attach it to.

## Confidence

- **high**: the device or shaft, the level, and the value with its unit (or the pass/fail word) were all stated in the same sentence of the recording.
- **medium**: one part came from an earlier sentence (level or shaft within 5 minutes or 8 statements; device within 90 seconds; a bare "pass" within 60 seconds of the device and test; zone within 2 minutes; a floor in alarm until the panel is reset), or the unit was not said but a pressure or force word was and the number is in range (ΔP under 0.5 in. w.g.; force 1 to 100 lbf), or the value came from a checklist, a photo caption, or a verified language-model suggestion.
- Anything weaker is an open item. When several sources agree, the review marks the value as "corroborated".

## Validation

Before writing, the patch is checked against the app's rules:

- Every key must be one the app generates for this building.
- Results must be `pass` / `fail` / `na`.
- `dp`, `brk` and `swg` must be numeric, and `cl` must be `pass` / `fail`, and only on shafts that have a latch column.
- Deficiency ids must be unique, with a valid severity and a non-empty description.
- The merged record is run through the app's `normalizeProject` and must come back with every proposed value unchanged.

The result is printed, stored in `validation`, and shown at the top of the review.

## Optional language-model step (off by default)

The rules above work without any model. For recordings with a lot of free speech, `--llm` adds a second reader:

```bash
# Anthropic API (needs ANTHROPIC_API_KEY; model from SC_FIELD_LLM_MODEL, default claude-sonnet-5)
node tools/field-results/cli.js ... --llm anthropic
# any other model or service: the command gets a JSON request on stdin and prints a JSON array of suggestions on stdout
node tools/field-results/cli.js ... --llm "command:python3 my_reader.py"
```

The interface lives in `lib/llm.js`. The request contains the building name, the valid targets for this building, and the transcript segments. A suggestion looks like this:

```json
{ "target": "floors.Stair B_12.dp", "value": "0.06", "segment": { "file": "part1.txt", "index": 14 }, "excerpt": "point zero six on the gauge" }
```

For a deficiency, use `"target": "deficiency"` with `sev` and `loc`. Plain code checks every suggestion before it is used:

- The segment must exist, and the excerpt must appear in it word for word.
- The target must be a key the app generates for this building.
- The value must be found again in the excerpt by the same number and pass/fail parsers.
- The device, zone, shaft and level in the target must be named in that segment or the three before it.

A suggestion that passes is rated medium at most and still loses to any source that disagrees. One that fails any check becomes an open item. If the model call fails, the rule-based result is still written, and the error is shown in the review. When `--llm` is used, the transcript text is sent to that service.

## Limits

- Photos are used through their captions only. There is no image reading.
- Schema v2 has no field for measured airflow, fan speed or observed equipment state, so these are reported for the narrative and not written.
- Emergency power, fault and initiating-device items (Table 2) are filled only from a checklist.
- The checklist column names above are an assumption about the vendor format. A sheet without a recognisable header row with a result column is skipped, and this is noted in the patch's `inputs`.

## Development

```bash
cd tools/field-results && npm test      # node --test, no dependencies
```

The tests use only synthetic data in `test/fixtures/` (a fictional 12-storey building, transcripts, checklist and photo index). CI runs them on every change to `index.html` or this folder, because the tool reads its model from `index.html`.

| File | Role |
|---|---|
| `lib/appModel.js` | loads the data-model script from `index.html` in a sandbox |
| `lib/units.js` | spoken and typed numbers with units, Pa and N conversion |
| `lib/transcript.js` | text and JSON transcript readers |
| `lib/tabular.js` | CSV and XLSX readers (XLSX via zlib, no dependencies) |
| `lib/matcher.js` | building vocabulary: tags, levels, shafts, zones, test phrases |
| `lib/extract.js` | rules: statements to candidates, open items, measurements, deficiencies |
| `lib/checklist.js`, `lib/photos.js` | checklist and photo-index sources |
| `lib/resolve.js` | merges sources, applies the no-overwrite and no-conflict rules, generates deficiencies |
| `lib/validate.js` | schema and value checks against the app model |
| `lib/llm.js` | optional model step and its verification |
| `lib/review.js` | markdown review table |
| `lib/pipeline.js`, `cli.js` | orchestration and command line |
