#!/usr/bin/env bash
# Download ONNX models required by the face detection worker.
# Run once before starting the server: bun run setup
set -euo pipefail

MODELS_DIR="$(cd "$(dirname "$0")/.." && pwd)/models"
mkdir -p "$MODELS_DIR"

# --------------------------------------------------------------------------
# Helper
# --------------------------------------------------------------------------
download_if_missing() {
  local label="$1"
  local dest="$2"
  shift 2
  local urls=("$@")

  if [ -f "$dest" ]; then
    echo "[download-models] $label already exists, skipping."
    return 0
  fi

  echo "[download-models] Downloading $label..."
  for url in "${urls[@]}"; do
    echo "[download-models] Trying: $url"
    if curl -fsSL --max-time 120 -o "$dest" "$url"; then
      echo "[download-models] Done → $dest ($(du -sh "$dest" | cut -f1))"
      return 0
    fi
  done

  echo "[download-models] ERROR: all sources failed for $label."
  return 1
}

# --------------------------------------------------------------------------
# UltraFace RFB-320  (~1.2 MB)   — primary face detector
# --------------------------------------------------------------------------
download_if_missing \
  "UltraFace-RFB-320" \
  "$MODELS_DIR/ultraface-slim-320.onnx" \
  "https://github.com/onnx/models/raw/refs/heads/main/validated/vision/body_analysis/ultraface/models/version-RFB-320.onnx" \
  "https://media.githubusercontent.com/media/onnx/models/main/validated/vision/body_analysis/ultraface/models/ultraface_slim_320.onnx"

# --------------------------------------------------------------------------
# MoveNet Lightning (~9 MB)   — pose fallback for turned-away persons
#
# Hosted on PINTO0309's Wasabi S3 bucket as part of a multi-format tarball.
# We download the archive and extract only the float32 ONNX file.
#
# If the download fails, place the model manually at models/movenet-lightning.onnx.
# Manual conversion from TFLite:
#   pip install tf2onnx tensorflow-cpu
#   python -m tf2onnx.convert \
#     --tflite movenet_lightning.tflite \
#     --output models/movenet-lightning.onnx --opset 13
# --------------------------------------------------------------------------
MOVENET_DEST="$MODELS_DIR/movenet-lightning.onnx"
MOVENET_TAR_URL="https://s3.ap-northeast-2.wasabisys.com/pinto-model-zoo/115_MoveNet/lightning_v4/resources.tar.gz"

download_movenet() {
  local tmp
  tmp="$(mktemp -d)"
  echo "[download-models] Trying: $MOVENET_TAR_URL"
  if curl -fsSL --max-time 120 -o "$tmp/resources.tar.gz" "$MOVENET_TAR_URL"; then
    tar -xzf "$tmp/resources.tar.gz" -C "$tmp" saved_model/model_float32.onnx
    mv "$tmp/saved_model/model_float32.onnx" "$MOVENET_DEST"
    rm -rf "$tmp"
    echo "[download-models] Done → $MOVENET_DEST ($(du -sh "$MOVENET_DEST" | cut -f1))"
    return 0
  fi
  rm -rf "$tmp"
  return 1
}

if [ ! -f "$MOVENET_DEST" ]; then
  echo "[download-models] Downloading MoveNet-Lightning..."
  if ! download_movenet; then
    echo ""
    echo "  MoveNet is optional — the service works without it."
    echo "  Without it, crops fall back to entropy when no faces are detected."
    echo "  To enable pose-based cropping for turned-away persons, place the model at:"
    echo "  $MOVENET_DEST"
    echo ""
  fi
else
  echo "[download-models] MoveNet-Lightning already exists, skipping."
fi

echo "[download-models] All done."
