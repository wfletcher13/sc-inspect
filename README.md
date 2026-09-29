SC Inspect: smoke control inspection field app for EB Life Safety. The app is served from this repository by GitHub Pages at https://wfletcher13.github.io/sc-inspect/ and holds no inspection data.

## Inspection workflow

1. **Intake**: create the building in the app or import the intake JSON (configuration, equipment, sequence, zones).
2. **Test plan / basis of design** and **pretest checklists**: generated from the record by the eb-smoke-control-inspection plugin (sc-inspection-test-plan, sc-field-checklists).
3. **Field test**: results go into the app directly, or are recorded on the Pocket voice recorder with photos of checklists and the FSCP panel.
4. **Field results to JSON**: `tools/field-results` reads the pre-test JSON, the transcripts, the filled-in checklist and a photo index. It writes a proposed post-test patch and a review table in which every value shows its source and confidence, and anything unclear is left empty as an open item. It never changes the source record. See [tools/field-results/README.md](tools/field-results/README.md) and the skill notes in [tools/field-results/SKILL.md](tools/field-results/SKILL.md).
5. **Results report**: after review, the approved record goes to sc-inspection-results.

Tool outputs contain project data. Keep them out of this public repository (`.gitignore` excludes them).
