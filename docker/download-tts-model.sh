#!/bin/sh
set -eu
name=vits-piper-en_US-ljspeech-medium
checksum=3dfb4b759d8be032a4903a9538d128b0fda2a06ab1de6cbc2d93a97e2dd83dba
root=/models
target="$root/$name"
if [ -f "$target/.source-sha256" ] && [ "$(cat "$target/.source-sha256")" = "$checksum" ] &&
   [ -f "$target/.files.sha256" ] && (cd "$target" && sha256sum --check --status .files.sha256); then
  echo "Local TTS model is ready."
  exit 0
fi
stage=$(mktemp -d "$root/.tts-install.XXXXXX")
trap 'rm -rf "$stage"' EXIT HUP INT TERM
echo "Downloading the English TTS voice (67 MB; first setup only)…"
curl --fail --location --retry 3 --connect-timeout 20 --max-time 1800 \
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/$name.tar.bz2" \
  --output "$stage/model.tar.bz2"
echo "$checksum  $stage/model.tar.bz2" | sha256sum --check --status
tar --extract --bzip2 --file "$stage/model.tar.bz2" --directory "$stage" --no-same-owner --no-same-permissions
test -s "$stage/$name/en_US-ljspeech-medium.onnx"
test -s "$stage/$name/tokens.txt"
test -s "$stage/$name/MODEL_CARD"
test -d "$stage/$name/espeak-ng-data"
(cd "$stage/$name" && find . -type f -exec sha256sum '{}' + > ../files.sha256)
mv "$stage/files.sha256" "$stage/$name/.files.sha256"
echo "$checksum" > "$stage/$name/.source-sha256"
chmod -R a+rX "$stage/$name"
rm -rf "$target"
mv "$stage/$name" "$target"
echo "Local TTS model is ready."
