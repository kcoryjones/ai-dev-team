#!/bin/sh
set -eu
model=/models/ggml-base.en.bin
checksum=a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002
if [ -f "$model" ] && echo "$checksum  $model" | sha256sum --check --status; then
  echo "Local speech model is ready."
  exit 0
fi
echo "Downloading the English speech model (148 MB; first setup only)…"
curl --fail --location --retry 3 --connect-timeout 20 --max-time 1800 \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.en.bin \
  --output "$model.part"
echo "$checksum  $model.part" | sha256sum --check --status
chmod 644 "$model.part"
mv "$model.part" "$model"
echo "Local speech model is ready."
