# Home-relative current-file HTML references

Use SKILL.md's metadata wrapper with preview-home-reference.ts. It seeds a
synthetic publication with home-relative/absolute HTML references and invokes
file.reference.read through the actual operation registry. Require passed,
liveDocumentServed, sameAbsoluteContent, sourceBound and sourceRechecked in
home-reference.json. The sanitized current document must contain the heading;
equivalent absolute and home-relative references return identical bytes and
leave artifact_files empty. Removing the stored visible reference must refuse.

Traversal, symlinks, secret paths, invalid HTML bytes and oversized files must
refuse without snapshots. The live reader may mask lexical denials as forbidden;
the evidence records the actual reasons. Run preview-resolve.test.ts and retain
the wrapper's JSON, log and exit status. No UI, account or model is used.

Old capture-on-tap is retired by C2; see in-app-previews-human-reference-capture.md
for its explicit upgrade refusal and saved-attachment compatibility proof.
