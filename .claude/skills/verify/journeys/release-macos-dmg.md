# macOS release disk images

Dispatch the Release workflow on the exact candidate ref with `publish=false`.
Both macOS jobs must report an `Accepted` Apple notarization result and zero exit
codes for stapler validation and Gatekeeper assessment before artifact collection.
Save the run URL and both jobs' validation output.

On macOS, set `VERSION` to the package version and `ASSETS` to a fresh absolute
directory. Download both desktop artifacts into it:

```bash
gh run download "$RUN_ID" --name desktop-darwin-arm64 --dir "$ASSETS"
gh run download "$RUN_ID" --name desktop-darwin-x64 --dir "$ASSETS"
```

For a published release audit, get the files instead with
`gh release download "v$VERSION" --pattern 'HyperNeo_*_darwin-*' --dir "$ASSETS"`.
Run the same audit on the downloaded files:

```bash
set -e
for arch in darwin-arm64 darwin-x64; do
  prefix="HyperNeo_${VERSION}_${arch}"
  test -f "$ASSETS/$prefix.dmg"
  test -f "$ASSETS/$prefix.app.zip"
  bash packages/desktop/verify-macos-dmg.sh "$ASSETS/$prefix.dmg"
  (cd "$ASSETS" && shasum -a 256 -c "${prefix}_SHA256SUMS.txt")
  ditto -x -k "$ASSETS/$prefix.app.zip" "$ASSETS/unpacked/$arch"
  xcrun stapler validate "$ASSETS/unpacked/$arch/HyperNeo.app"
done
```

Expect two accepted DMGs, two valid app tickets, and four successful checksum
lines. This audit uses downloaded bytes and does not launch or install the app.
